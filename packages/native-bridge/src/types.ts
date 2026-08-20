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

/**
 * Per-item progress of the POST-pick load/copy step. On iOS this step can
 * be an iCloud original DOWNLOAD (minutes for a large video) — without
 * these events the UI froze at 0% and read as stuck; and a per-item
 * failure (e.g. iCloud + no network) was silently dropped, making an
 * all-failed batch indistinguishable from a user cancel (founder's
 * iPhone, 2026-08-19). "error" items are NOT in the resolved handle list.
 */
export interface PickProgress {
	index: number;
	total: number;
	stage: "loading" | "loaded" | "error";
	/** 0..1 within the item; iOS reports real download fractions, Android
	 *  emits stage markers (0 then 1). */
	fraction: number;
	error?: string;
}

export interface PickMediaOptions {
	kinds: MediaKind[];
	allowMultiple: boolean;
	/** Honor `capture="camera"` — plan M4 item 3: not honored by Android
	 * WebView by default, so the host must build the camera Intent itself. */
	source?: "library" | "camera";
	/** Fires during the post-pick load/copy of each selected item. */
	onProgress?: (progress: PickProgress) => void;
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
	/** Present only when stage is "done" — the proxy's OWN dimensions after
	 * the native downscale (plan Amendment 4), which the webview's
	 * `VideoCache` needs to know to composite against the right size. */
	proxyWidth?: number;
	proxyHeight?: number;
	/** M4 item 5, "Thumbnail strip generation natively... served from the
	 * local server — do NOT decode filmstrip frames in JS." Native file
	 * paths (host converts via `Capacitor.convertFileSrc` before handing
	 * them to the webview, same as `proxyUri` — see
	 * `capacitor-bridge.ts`'s `toWebviewUri`), present only when stage is
	 * "done". Additive to the plan §2.4 sketch of this type; M3 landed
	 * `ProxyProgress` before M4 had a thumbnail-strip design to fold in. */
	thumbnailUris?: string[];
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

/**
 * Plan M4 item 5: "Thumbnail strip generation natively ... do NOT decode
 * filmstrip frames in JS." Added in M4 — not part of M3's original
 * four-bridge sketch (plan §2.4), because M3 only knew about the four
 * bridges named in the brief. The filmstrip is genuinely a fifth native
 * capability, not an extension of `generateProxy`: a proxy is consumed by
 * `<video>`/`CanvasSink` during scrub/playback, while a thumbnail strip is
 * consumed by M7's timeline as static `<img>`-equivalent sources at
 * zoom-dependent density — two different consumers of two different native
 * outputs, both derived from the same source asset.
 */
export interface ThumbnailStripSpec {
	/** How many frames to extract, evenly spaced across the clip. */
	count: number;
	/** Max long edge of each thumbnail, px — a filmstrip thumbnail, not a
	 * full frame (plan M4 item 5). */
	maxEdgePx: number;
}

export interface ThumbnailStrip {
	assetId: string;
	/** Ordered, same length as `timestampsMicros`. Native handles — never
	 * `blob:` URLs, same discipline as `MediaHandle.uri`/`ProxyProgress
	 * .proxyUri`. */
	uris: string[];
	/** Integer microseconds, source-relative — same unit discipline as
	 * `MediaHandle.durationMicros`. */
	timestampsMicros: number[];
}

export interface TranscribeOptions {
	modelSize: "tiny" | "base";
	languageHint?: string;
}

/**
 * One word-level caption unit within a `TranscriptSegment`, added in plan
 * M10 (corpus `12`). Already run through the mandatory smoothing pass
 * (`caption-smoothing.ts`) by the time it reaches this type — nothing
 * downstream of `NativeBridge.transcribe()` ever sees raw, unsmoothed
 * whisper.cpp DTW output. Trailing punctuation is glued onto the word that
 * precedes it (see `caption-smoothing.ts`'s "snap punctuation to the
 * preceding word's end" rule) rather than appearing as its own entry.
 */
export interface TranscriptWord {
	/** May include a leading/trailing punctuation mark merged in during
	 * smoothing (e.g. "Americans," or "country."), but never a bare
	 * punctuation-only string on its own. */
	text: string;
	/** Integer microseconds, source-relative — same unit discipline as
	 * MediaHandle. Caller (editor-core) converts to ticks. */
	startMicros: number;
	endMicros: number;
	confidence: number | null;
}

export interface TranscriptSegment {
	/** Integer microseconds, source-relative — same unit discipline as
	 * MediaHandle. Caller (editor-core) converts to ticks. */
	startMicros: number;
	endMicros: number;
	text: string;
	confidence: number | null;
	/** Word-level timestamps for this segment (plan M10: "audio file in ->
	 * segments with word-level timestamps out"). Always present and always
	 * smoothed — see `TranscriptWord`'s own doc comment. Empty only if the
	 * native side genuinely produced zero decodable words for this segment
	 * span (e.g. a non-speech segment), never as a "not implemented" signal
	 * — that case throws `NativeBridgeError` from `transcribe()` itself. */
	words: TranscriptWord[];
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
	/**
	 * Converts a `MediaHandle.uri` / `ProxyProgress.proxyUri` /
	 * `ProxyProgress.thumbnailUris[n]` (a native handle — an app-sandbox
	 * path on Capacitor, already webview-loadable on the web fallback) into
	 * a URL this platform's webview can actually load as `<video
	 * src>`/`fetch()`.
	 *
	 * kneecap M4 addition — not in the plan §2.4 sketch, which predates
	 * `pickMedia`/`generateProxy` having real implementations to reconcile
	 * against `EdlAssetResolution.sourceUri`'s "must be a real native
	 * handle, not a `blob:` URL" requirement (docs/EDL.md §6). Kept as an
	 * explicit bridge method — not folded into the handle itself — so
	 * `MediaHandle.uri` stays the SAME value on both sides of a
	 * `generateProxy({handle, ...})` call (native handed it out, native
	 * takes it back in); only the host layer building a `MediaAsset.url`
	 * for the webview needs the converted form.
	 */
	toPlaybackUri(nativeUri: string): string;
	/**
	 * The media-custody root directory (the parent of the native
	 * Media/Proxies/Thumbnails dirs), or null when the platform has no
	 * stable native filesystem (web fallback) or the running native build
	 * predates the method. Exists so the engine can persist
	 * container-RELATIVE media paths: iOS rotates the app data-container
	 * UUID on every app update/reinstall, so persisted ABSOLUTE paths die
	 * with the next install (found live 2026-08-19 — every saved project's
	 * playback broke after an Xcode reinstall).
	 */
	getMediaRoot(): Promise<string | null>;
	/** Dogfood audio bisector: a native-rendered 440Hz tone, NO webview
	 *  involved (2026-08-19 device-silence campaign). Resolves false when
	 *  the platform can't play one (web fallback / old native build). */
	playTestTone(): Promise<boolean>;
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
	/** M4 addition (see `ThumbnailStripSpec`'s doc comment) — a single
	 * resolve-when-done call, not a progress generator like `generateProxy`:
	 * a handful of JPEGs is fast enough that streaming progress isn't worth
	 * the complexity. */
	generateThumbnails(params: {
		handle: MediaHandle;
		spec: ThumbnailStripSpec;
	}): Promise<ThumbnailStrip>;
	capabilities(): Promise<DeviceCapabilities>;
}
