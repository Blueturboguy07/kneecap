/**
 * NativeBridge — the shared vocabulary. Plan §2.4 / M3.
 *
 * "Nothing crosses the JS↔native bridge except JSON control messages,
 * progress events, and URLs. No video bytes on the bridge — ever." (plan
 * §2.2). Every type below is a plain, JSON-serializable value for exactly
 * that reason — nothing here is a File, Blob, ArrayBuffer, or object URL.
 *
 * A DELIBERATE BOUNDARY, not an oversight: this file does NOT use editor-core
 * ticks (`meta.ticksPerSecond`, 120000-today). Ticks are an
 * `@kneecap/editor-core` / EDL-v1 concept — see docs/EDL.md §6, "durationTicks
 * on an asset is the one place the seconds→ticks boundary is crossed ... goes
 * through the WASM helper, never a bare multiply." A native media probe
 * (`AVAsset`, `MediaMetadataRetriever`) has no idea what an editor tick is and
 * must not invent one. So a probed `MediaHandle` reports `durationMicros` —
 * an INTEGER, never a float, in an unambiguous native-precision unit — and
 * editor-core is the only place that turns it into `durationTicks` via the
 * WASM helper. `exportProject`, by contrast, takes a fully-built `Edl`
 * (imported from `@kneecap/editor-core/edl`), which by then IS all ticks and
 * rationals — see plan §2.2's "Time values crossing the EDL bridge are
 * integer ticks + rational frame rates, never float seconds."
 */

import type { Edl, EdlRational } from "@kneecap/editor-core/edl";

export type Platform = "ios" | "android" | "web";

export type MediaKind = "video" | "audio" | "image";

export interface PickMediaOptions {
	kinds: MediaKind[];
	allowMultiple: boolean;
	/** Honor `capture="camera"` — plan M4 item 3: not honored by Android
	 * WebView by default, so the host must build the camera Intent itself. */
	source?: "library" | "camera";
}

/**
 * What native custody hands back after an import. `uri` is a native handle
 * (an app-sandbox path or a persisted `content://`/`ph://`-style URI) — NEVER
 * a `blob:` URL, which `validateEdl({strict:true})` rejects outright because
 * it is meaningless outside the WebView (docs/EDL.md §6).
 */
export interface MediaHandle {
	id: string;
	uri: string;
	kind: MediaKind;
	fileName: string;
	sizeBytes: number;
	/** Integer microseconds. Never a float-seconds duration. */
	durationMicros: number;
	width: number;
	height: number;
	rotationDegrees: 0 | 90 | 180 | 270;
	hasAudio: boolean;
	codec: string;
	frameRate: EdlRational | null;
}

export interface ProxySpec {
	/** Target short edge, px. Plan Amendment 4 default: 540 (phone preview). */
	targetHeight: number;
	/** Short-GOP / near-all-intra structure for scrub-friendly random access. */
	shortGop: boolean;
}

export type ProxyStage = "queued" | "transcoding" | "done" | "error";

export interface ProxyProgress {
	assetId: string;
	stage: ProxyStage;
	/** 0..1. Always 1 when stage is "done" or "error". */
	fraction: number;
	/** Present only when stage is "done". Never a blob: URL — see MediaHandle. */
	proxyUri?: string;
	error?: string;
}

export type ExportStage =
	| "preparing"
	| "encoding"
	| "muxing"
	| "done"
	| "error";

export interface ExportProgress {
	stage: ExportStage;
	fraction: number;
	outputUri?: string;
	error?: string;
}

export interface TranscribeOptions {
	modelSize: "tiny" | "base";
	languageHint?: string;
}

export interface TranscriptSegment {
	/** Integer microseconds, source-relative — same unit discipline as
	 * MediaHandle. Caller (editor-core) converts to ticks. */
	startMicros: number;
	endMicros: number;
	text: string;
	confidence: number | null;
}

export interface DeviceCapabilities {
	platform: Platform;
	osVersion: string;
	deviceModel: string;
	gpuBackend: "webgpu" | "webgl2" | "unknown";
	ramTierMb: number | null;
	codecs: { decode: string[]; encode: string[] };
	supportsNativeExport: boolean;
	supportsOnDeviceStt: boolean;
}

export const NATIVE_BRIDGE_ERROR_CODES = [
	"NOT_IMPLEMENTED",
	"PERMISSION_DENIED",
	"USER_CANCELLED",
	"UNSUPPORTED",
	"IO_ERROR",
] as const;
export type NativeBridgeErrorCode = (typeof NATIVE_BRIDGE_ERROR_CODES)[number];

export class NativeBridgeError extends Error {
	readonly code: NativeBridgeErrorCode;
	constructor({
		code,
		message,
	}: {
		code: NativeBridgeErrorCode;
		message: string;
	}) {
		super(message);
		this.name = "NativeBridgeError";
		this.code = code;
	}
}

/**
 * The one interface every editor UI file is allowed to touch (plan §2.4).
 * `packages/native-bridge/src/index.ts` and its two implementations are the
 * ONLY files that may import `@capacitor/*` or `@tauri-apps/*` — enforced by
 * `scripts/invariants.sh`'s bridge-import gate and the
 * `no-restricted-imports` ESLint rule.
 *
 * Deliberate deviation from plan §2.4's illustrative sketch
 * (`generateProxy(handle, spec)`, `transcribe(handle, opts)`): this repo
 * enforces single-destructured-object-parameter style everywhere else
 * (`eslint/rules/prefer-object-params.mjs`, already how `buildEdl`/
 * `validateEdl` are shaped) — the sketch was illustrative, not frozen the way
 * EDL v1 is, so multi-param methods here are reshaped to match. Behavior is
 * unchanged.
 */
export interface NativeBridge {
	readonly platform: Platform;
	pickMedia(opts: PickMediaOptions): Promise<MediaHandle[]>;
	// `AsyncGenerator`, not the plan sketch's `AsyncIterable`: every
	// implementation IS an async generator function, and callers (including
	// this package's own tests) need `.next()` on the returned object, which
	// `AsyncIterable` alone doesn't type.
	generateProxy(params: {
		handle: MediaHandle;
		spec: ProxySpec;
	}): AsyncGenerator<ProxyProgress>;
	exportProject(params: { edl: Edl }): AsyncGenerator<ExportProgress>;
	transcribe(params: {
		handle: MediaHandle;
		opts: TranscribeOptions;
	}): AsyncGenerator<TranscriptSegment>;
	capabilities(): Promise<DeviceCapabilities>;
}
