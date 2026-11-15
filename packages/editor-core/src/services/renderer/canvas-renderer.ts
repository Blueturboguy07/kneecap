import type { FrameRate } from "opencut-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { createCanvasSurface } from "./canvas-utils";
import { Canvas2dCompositor } from "./compositor/canvas2d-compositor";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import { gpuDisabledReason, isGpuBroken, reportGpuFailure } from "./compositor/gpu";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { resolveRenderTree } from "./resolve";
import {
	measureSpanAsync,
	measureSpanSync,
	onRenderPerfFrameComplete,
} from "@/diagnostics/render-perf";

// App shells start the GPU through these, so it starts in the same wasm
// copy that the compositor uses (see compositor/gpu.ts).
export { ensureGpu, isGpuReady } from "./compositor/gpu";

export type CanvasRendererParams = {
	width: number;
	height: number;
	fps: FrameRate;
};

/** "gpu": the wasm compositor. "canvas2d": the fallback when the GPU is
 *  missing or fails (no GPU effects, everything else draws). */
export type RendererBackend = "gpu" | "canvas2d";

/** GPU frames in a row that may fail before the renderer moves to Canvas 2D. */
const MAX_GPU_FRAME_FAILURES = 3;

/**
 * True for a Rust panic in the wasm compositor: a WebAssembly.RuntimeError
 * ("Unreachable code should not be executed"). After a panic the wasm
 * instance is unusable and every later call panics too, so a retry cannot
 * help. The 1.0.4 simulator test saw this: wgpu reported "Out of Memory",
 * the frame panicked, and the next frames panicked in releaseTexture.
 */
function isWasmTrap(error: unknown): boolean {
	if (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /unreachable/i.test(message);
}

export class CanvasRenderer {
	canvas: OffscreenCanvas;
	context: OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	fps: FrameRate;

	private backend: RendererBackend | null = null;
	private gpuFrameFailures = 0;
	private fallbackCanvas: HTMLCanvasElement | null = null;
	private fallbackCompositor: Canvas2dCompositor | null = null;
	/** Set when the renderer moves to Canvas 2D: the next getOutputCanvas()
	 *  drops the Canvas 2D texture cache, so the redraw after the canvas swap
	 *  makes every text texture again. The frame drawn at the moment of the
	 *  GPU failure can come out blank (1.0.4 simulator test: a text-only frame
	 *  stayed empty until the next edit), and the cache would keep it. */
	private dropFallbackCache = false;

	constructor({ width, height, fps }: CanvasRendererParams) {
		this.width = width;
		this.height = height;
		this.fps = fps;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	/**
	 * The backend this renderer draws with. It is chosen on the first call:
	 * the GPU compositor when it can start, else Canvas 2D. A GPU setup error
	 * never reaches the caller.
	 */
	getBackend(): RendererBackend {
		if (this.backend) return this.backend;
		if (!isGpuBroken() && !gpuDisabledReason()) {
			try {
				wasmCompositor.ensureInitialized({
					width: this.width,
					height: this.height,
				});
				this.backend = "gpu";
				return this.backend;
			} catch (error) {
				reportGpuFailure(error);
			}
		}
		this.backend = "canvas2d";
		return this.backend;
	}

	getOutputCanvas(): HTMLCanvasElement {
		if (this.getBackend() === "gpu") {
			try {
				wasmCompositor.ensureInitialized({
					width: this.width,
					height: this.height,
				});
				return wasmCompositor.getCanvas();
			} catch (error) {
				this.useCanvas2d(error);
			}
		}
		if (this.dropFallbackCache) {
			this.dropFallbackCache = false;
			this.fallbackCompositor = null;
		}
		return this.getFallbackCanvas();
	}

	setSize({ width, height }: { width: number; height: number }) {
		this.width = width;
		this.height = height;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	async render({ node, time }: { node: AnyBaseNode; time: number }) {
		await measureSpanAsync({
			name: "resolve",
			fn: () => resolveRenderTree({ node, renderer: this, time }),
		});
		const { frame, textures } = await measureSpanAsync({
			name: "buildFrame",
			fn: () => buildFrameDescriptor({ node, renderer: this }),
		});

		if (this.getBackend() === "gpu") {
			try {
				wasmCompositor.ensureInitialized({
					width: this.width,
					height: this.height,
				});
				measureSpanSync({
					name: "syncTextures",
					fn: () => wasmCompositor.syncTextures(textures),
				});
				measureSpanSync({
					name: "renderFrame",
					fn: () => wasmCompositor.render(frame),
				});
				this.gpuFrameFailures = 0;
				return;
			} catch (error) {
				this.gpuFrameFailures += 1;
				// A wasm panic moves to Canvas 2D at once; another error may
				// pass, so it gets MAX_GPU_FRAME_FAILURES tries.
				if (!isWasmTrap(error) && this.gpuFrameFailures < MAX_GPU_FRAME_FAILURES) throw error;
				this.useCanvas2d(error);
			}
		}

		const output = this.getFallbackCanvas();
		const context = output.getContext("2d");
		if (!context) {
			throw new Error("Failed to get 2D context for the preview canvas");
		}
		if (!this.fallbackCompositor) {
			this.fallbackCompositor = new Canvas2dCompositor();
		}
		const compositor = this.fallbackCompositor;
		measureSpanSync({
			name: "renderFrame2d",
			fn: () => compositor.render({ context, frame, textures }),
		});
	}

	async renderToCanvas({
		node,
		time,
		targetCanvas,
	}: {
		node: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
	}) {
		await this.render({ node, time });

		const ctx = targetCanvas.getContext("2d");
		if (!ctx) {
			throw new Error("Failed to get target canvas context");
		}

		const output = this.getOutputCanvas();
		measureSpanSync({
			name: "drawImage",
			fn: () => ctx.drawImage(output, 0, 0, targetCanvas.width, targetCanvas.height),
		});
		onRenderPerfFrameComplete();
	}

	private useCanvas2d(error: unknown) {
		reportGpuFailure(error);
		if (this.backend !== "canvas2d") {
			console.warn(
				`Renderer moved to Canvas 2D: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (this.backend !== "canvas2d") this.dropFallbackCache = true;
		this.backend = "canvas2d";
	}

	/** The Canvas 2D output, kept at the renderer's size. */
	private getFallbackCanvas(): HTMLCanvasElement {
		if (!this.fallbackCanvas) {
			this.fallbackCanvas = document.createElement("canvas");
		}
		if (this.fallbackCanvas.width !== this.width) this.fallbackCanvas.width = this.width;
		if (this.fallbackCanvas.height !== this.height) this.fallbackCanvas.height = this.height;
		return this.fallbackCanvas;
	}
}
