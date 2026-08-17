/**
 * kneecap M1 spike harness — shared result types.
 *
 * THROWAWAY CODE (plan M1: "Build a throwaway harness — not the product").
 * This directory (`apps/mobile/src/spike/`) is a separate Vite entry
 * (`apps/mobile/spike.html`) bundled alongside the product's `index.html`
 * into the same `www/` output, but never linked from product UI. It exists
 * to answer the six pre-committed M1 go/no-go questions on real hardware —
 * see plan M1's exit-criteria table, mirrored in `./thresholds.ts`.
 *
 * IMPORTANT: this harness runs the measurements and packages the results.
 * It does NOT itself decide "M1 passed" — a human (the founder) reads the
 * exported JSON against `./thresholds.ts` and the fallback triggers in plan
 * §7 if two or more kill-signals fire. The verdict computed here is a
 * convenience label for the on-screen UI, not a judgment the code enforces.
 */

export type Verdict = "pass" | "investigate" | "kill" | "unavailable";

export type TestId =
	| "backend-frametime"
	| "scrub-latency"
	| "native-export"
	| "transcription"
	| "opfs-storage"
	| "memory-watermark";

export interface EnvironmentInfo {
	platform: "ios" | "android" | "web";
	userAgent: string;
	deviceModel: string | null;
	osVersion: string | null;
	ramTierMb: number | null;
	timestampIso: string;
}

// --- Test 1: compositor backend + frame timing ------------------------------

export interface BackendFrameTimeResult {
	testId: "backend-frametime";
	/** How the backend was determined — see tests/backend-frametime.ts for
	 * the canvas-context-introspection method (opencut-wasm exposes no JS
	 * getter for this, so this harness infers it from the compositor's own
	 * canvas post-init, per plan M1 item 1's "must instrument ... and log
	 * it"). */
	gpuBackend: "webgpu" | "webgl2" | "unknown";
	frameCount: number;
	p50Ms: number | null;
	p95Ms: number | null;
	maxMs: number | null;
	/** Chromium-only (`performance.memory`); null on WebKit — see
	 * `memory-watermark` / native RSS probe for the iOS-capable substitute. */
	peakJsHeapBytes: number | null;
	error: string | null;
}

// --- Test 2: scrub latency ---------------------------------------------------

export interface ScrubLatencySample {
	timestampSec: number;
	latencyMs: number;
}

export interface ScrubLatencyResult {
	testId: "scrub-latency";
	proxy: {
		samples: ScrubLatencySample[];
		p50Ms: number | null;
		maxMs: number | null;
	} | null;
	full: {
		samples: ScrubLatencySample[];
		p50Ms: number | null;
		maxMs: number | null;
	} | null;
	error: string | null;
}

// --- Test 3: native hardware export ------------------------------------------

export interface NativeExportResult {
	testId: "native-export";
	ran: boolean;
	wallClockMs: number | null;
	outputDurationMs: number | null;
	outputSizeBytes: number | null;
	crossfadeApplied: boolean | null;
	textOverlayApplied: boolean | null;
	/** e.g. the Android Media3-cross-fade gap plan risk #4 predicted. A
	 * populated note on a `ran: true` result is itself a valid M1 finding,
	 * not a failure of the harness. */
	note: string | null;
	error: string | null;
}

// --- Test 4: on-device transcription -----------------------------------------

export interface TranscriptionResult {
	testId: "transcription";
	ran: boolean;
	wallClockMs: number | null;
	wordCount: number | null;
	/** Populated only if a ground-truth transcript was bundled and compared. */
	meanWordTimingErrorMs: number | null;
	note: string | null;
	error: string | null;
}

// --- Test 5: OPFS 200MB write/read -------------------------------------------

export interface OpfsStorageResult {
	testId: "opfs-storage";
	syncAccessHandle: {
		attempted: boolean;
		succeeded: boolean;
		writeMs: number | null;
		readMs: number | null;
		bytesVerified: number | null;
		error: string | null;
	};
	createWritable: {
		attempted: boolean;
		succeeded: boolean;
		writeMs: number | null;
		readMs: number | null;
		bytesVerified: number | null;
		error: string | null;
	};
}

// --- Test 6: peak webview process memory watermark ---------------------------

export interface MemoryWatermarkResult {
	testId: "memory-watermark";
	/** Sampled via the native SpikeDiagnostics plugin during Test 1's render
	 * loop — see `tests/backend-frametime.ts`, which drives both tests in one
	 * pass because the watermark is only meaningful under the same load. */
	peakResidentBytes: number | null;
	sampleCount: number;
	terminatedDuringRun: boolean;
	error: string | null;
}

export type AnyTestResult =
	| BackendFrameTimeResult
	| ScrubLatencyResult
	| NativeExportResult
	| TranscriptionResult
	| OpfsStorageResult
	| MemoryWatermarkResult;

export interface SpikeRunExport {
	schemaVersion: 1;
	environment: EnvironmentInfo;
	results: Partial<Record<TestId, AnyTestResult>>;
}
