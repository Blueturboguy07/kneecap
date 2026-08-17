/**
 * Test 1 (plan M1 item 1) + Test 6 (plan M1 item 6's peak-RSS column) share
 * one driver because the memory watermark is only meaningful measured DURING
 * the same 3-layer 1080p render load the frame-timing test already applies —
 * running them separately would understate the watermark.
 *
 * Backend instrumentation method: `opencut-wasm` exposes no JS getter for
 * "which wgpu backend did the instance actually select" (checked directly —
 * `opencut_wasm.d.ts` has no such export). This harness infers it instead by
 * probing the compositor's OWN canvas after `initCompositor()` runs, using
 * the HTML spec's own `HTMLCanvasElement.getContext()` idempotency rule: a
 * canvas is permanently locked to the first context type it's given, and
 * re-requesting that SAME type returns the existing context, while
 * requesting a DIFFERENT type returns null. Since wgpu's
 * `new_instance_with_webgpu_detection` creates exactly one context on this
 * canvas internally (`'webgpu'` if the WebGPU path won, `'webgl2'`
 * otherwise), asking the canvas which type it will still accept after the
 * fact is a genuine, spec-correct readout of what actually got selected —
 * not a guess and not the same as `gpu-detect.ts`'s pre-flight
 * feature-detection (which only tells you what's *available*, not what THIS
 * compositor instance chose).
 */
import {
	getSpikeDiagnosticsBridge,
	type SpikeMemoryFootprint,
} from "@kneecap/native-bridge/spike-diagnostics";
import type {
	FrameDescriptor,
	TextureUploadDescriptor,
} from "@kneecap/editor-core/services/renderer/compositor/types";
import type {
	BackendFrameTimeResult,
	MemoryWatermarkResult,
} from "../types";

const WIDTH = 1920;
const HEIGHT = 1080;
const FRAME_COUNT = 500;
const MEMORY_SAMPLE_EVERY = 25; // 20 samples across 500 frames

function detectActualCanvasBackend(canvas: HTMLCanvasElement): "webgpu" | "webgl2" | "unknown" {
	try {
		if (canvas.getContext("webgpu")) return "webgpu";
	} catch {
		// Locked to a different context type — fall through.
	}
	try {
		if (canvas.getContext("webgl2")) return "webgl2";
	} catch {
		// Fall through.
	}
	return "unknown";
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
	return sorted[idx];
}

/** Three solid-color layers with per-frame animated transforms, so every one
 * of the 500 frames is genuinely new compositing work (not a cache hit). */
function buildFrame({
	frameIndex,
}: {
	frameIndex: number;
}): { frame: FrameDescriptor; textures: TextureUploadDescriptor[] } {
	const t = frameIndex / FRAME_COUNT;
	const colors: [number, number, number, number][] = [
		[0.8, 0.1, 0.1, 1],
		[0.1, 0.6, 0.2, 1],
		[0.1, 0.3, 0.9, 1],
	];
	const textures: TextureUploadDescriptor[] = colors.map((color, i) => ({
		kind: "rendered",
		id: `spike-layer-${i}`,
		// Content hash changes every frame on purpose (see comment above) —
		// this is a deliberate stress test, not the steady-state cache-hit
		// path the real renderer optimizes for.
		contentHash: `spike:${i}:${frameIndex}`,
		width: WIDTH,
		height: HEIGHT,
		draw: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
			ctx.fillStyle = `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},1)`;
			ctx.fillRect(0, 0, WIDTH, HEIGHT);
		},
	}));

	const frame: FrameDescriptor = {
		width: WIDTH,
		height: HEIGHT,
		clear: { color: [0, 0, 0, 1] },
		items: colors.map((_, i) => {
			const angle = t * Math.PI * 2 * (i + 1);
			const w = WIDTH * (0.4 + i * 0.15);
			const h = HEIGHT * (0.4 + i * 0.15);
			return {
				type: "layer" as const,
				textureId: `spike-layer-${i}`,
				transform: {
					centerX: WIDTH / 2 + Math.cos(angle) * 200,
					centerY: HEIGHT / 2 + Math.sin(angle) * 200,
					width: w,
					height: h,
					rotationDegrees: (angle * 180) / Math.PI,
					flipX: false,
					flipY: false,
				},
				opacity: 0.6 + 0.3 * Math.sin(t * Math.PI * 2 + i),
				blendMode: "normal" as const,
				effectPassGroups: [],
				mask: null,
			};
		}),
	};

	return { frame, textures };
}

export async function runBackendFrameTimeAndMemoryWatermark(): Promise<{
	backendFrameTime: BackendFrameTimeResult;
	memoryWatermark: MemoryWatermarkResult;
}> {
	const spikeBridge = getSpikeDiagnosticsBridge();
	const memorySamples: number[] = [];
	let terminatedDuringRun = false;

	try {
		// REAL M1 FINDING, not a spike-only workaround: `opencut-wasm` requires
		// `await initializeGpu()` before `initCompositor()` — calling
		// `initCompositor()` without it throws "GPU context not initialized.
		// Call initializeGpu() first." (verified directly against the real
		// wasm binary in a WKWebView-equivalent WebKit engine, iOS Simulator
		// Safari, in this spike). `@kneecap/editor-core`'s own
		// `wasm-compositor.ts` (M2 product code) does NOT call
		// `initializeGpu()` anywhere — its `ensureInitialized()` goes straight
		// to `initCompositor()`. That means the PRODUCT renderer would fail
		// identically the first time it actually runs in a browser, not just
		// this spike. Flagged for the M2 owner; not fixed in
		// wasm-compositor.ts itself here to avoid touching product code
		// outside this milestone's scope while another track may be actively
		// working in that file. See docs/SPIKE-GUIDE.md's "bugs this spike
		// found" section.
		const { initializeGpu } = await import("opencut-wasm");
		await initializeGpu();

		const { wasmCompositor } = await import(
			"@kneecap/editor-core/services/renderer/compositor/wasm-compositor"
		);

		wasmCompositor.ensureInitialized({ width: WIDTH, height: HEIGHT });
		const canvas = wasmCompositor.getCanvas();
		const gpuBackend = detectActualCanvasBackend(canvas);

		const frameTimesMs: number[] = [];

		for (let i = 0; i < FRAME_COUNT; i++) {
			const { frame, textures } = buildFrame({ frameIndex: i });
			wasmCompositor.syncTextures(textures);

			const start = performance.now();
			wasmCompositor.render(frame);
			frameTimesMs.push(performance.now() - start);

			if (i % MEMORY_SAMPLE_EVERY === 0) {
				try {
					const bytes = await spikeBridge.getMemoryFootprintBytes();
					if (bytes !== null) memorySamples.push(bytes);
				} catch {
					// Non-fatal — memory watermark test degrades gracefully.
				}
				// Yield a frame so the memory sample reflects settled state
				// and the UI doesn't appear frozen during the 500-frame loop.
				await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
			}
		}

		const sorted = [...frameTimesMs].sort((a, b) => a - b);
		const perf = performance as Performance & {
			memory?: { usedJSHeapSize: number };
		};

		return {
			backendFrameTime: {
				testId: "backend-frametime",
				gpuBackend,
				frameCount: FRAME_COUNT,
				p50Ms: percentile(sorted, 0.5),
				p95Ms: percentile(sorted, 0.95),
				maxMs: sorted[sorted.length - 1] ?? null,
				peakJsHeapBytes: perf.memory ? perf.memory.usedJSHeapSize : null,
				error: null,
			},
			memoryWatermark: {
				testId: "memory-watermark",
				peakResidentBytes: memorySamples.length > 0 ? Math.max(...memorySamples) : null,
				sampleCount: memorySamples.length,
				terminatedDuringRun,
				error:
					memorySamples.length === 0 && spikeBridge.isNative
						? "SpikeDiagnostics.getMemoryFootprint() returned no samples — native plugin may not be registered."
						: null,
			},
		};
	} catch (err) {
		terminatedDuringRun = false;
		const message = stringifyUnknownError(err);
		return {
			backendFrameTime: {
				testId: "backend-frametime",
				gpuBackend: "unknown",
				frameCount: 0,
				p50Ms: null,
				p95Ms: null,
				maxMs: null,
				peakJsHeapBytes: null,
				error: message,
			},
			memoryWatermark: {
				testId: "memory-watermark",
				peakResidentBytes: memorySamples.length > 0 ? Math.max(...memorySamples) : null,
				sampleCount: memorySamples.length,
				terminatedDuringRun,
				error: `Skipped/aborted — driven by the same failure as backend-frametime: ${message}`,
			},
		};
	}
}

/**
 * wasm-bindgen panics and some WebKit-internal failures don't always surface
 * as a plain `Error` with a useful `.message` — richer than the generic
 * "unknown error" fallback most of this codebase's other catch blocks use,
 * specifically because this compositor path had never been exercised
 * through a real bundler/browser before this spike (see vite.config.ts's
 * header comment) and a vague error here would defeat the point of M1 test
 * 1 entirely.
 */
function stringifyUnknownError(err: unknown): string {
	if (err instanceof Error) return `${err.name}: ${err.message}`;
	if (typeof err === "string") return err;
	try {
		const json = JSON.stringify(err);
		if (json && json !== "{}") return json;
	} catch {
		// Fall through.
	}
	try {
		return String(err);
	} catch {
		return "unknown compositor error (unstringifiable)";
	}
}

export type { SpikeMemoryFootprint };
