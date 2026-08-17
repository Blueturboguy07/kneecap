/**
 * EDL v1 — the frozen bridge contract between the TypeScript engine and the two
 * native exporters (AVFoundation on iOS, Media3 on Android). Plan §2.3.
 *
 * FROZEN. Track agents build mappers against exactly these types and against
 * `schema/edl-v1.json`, which is generated from the same shape. Additive,
 * backwards-compatible fields may be appended to v1 only if every existing
 * mapper keeps working unchanged; anything else is v2 with a new
 * `edlVersion`. See docs/EDL.md for the compatibility rules and the reasoning
 * behind each design decision here.
 *
 * THE ONE RULE THAT MATTERS (plan §2.2 / §2.3 rule 1):
 * every time value in this document is an INTEGER TICK COUNT at
 * `meta.ticksPerSecond`, and every rate is a RATIONAL `{numerator,
 * denominator}` of integers. There are no float seconds and no float frame
 * rates anywhere in an EDL. `validateEdl()` enforces this field by field —
 * it is not a convention, it is a checked invariant.
 */

/** Bumping this is a breaking change. See docs/EDL.md § Versioning. */
export const EDL_VERSION = 1 as const;

/** Stable identifier for the JSON Schema in packages/editor-core/schema/. */
export const EDL_SCHEMA_ID = "https://kneecap.dev/schema/edl-v1.json";

/**
 * A rational number as a pair of integers. Used for frame rates and clip speed.
 * `denominator` is always > 0. Never reduce to a float when crossing the
 * bridge: `AVFoundation`'s `CMTime` and Media3's frame-rate handling are both
 * rational, and a 29.97 → 30.0 rounding here is a drift bug that only shows up
 * minutes into a long export.
 */
export interface EdlRational {
	numerator: number;
	denominator: number;
}

export type EdlBackground =
	| { type: "color"; color: string }
	| { type: "blur"; blurIntensity: number };

export interface EdlMeta {
	edlVersion: typeof EDL_VERSION;
	/** e.g. "kneecap/editor-core@0.1.0" — for debugging mapper mismatches. */
	generator: string;
	/**
	 * Ticks per second for EVERY `*Ticks` field in this document. Comes from the
	 * Rust/WASM core (`opencut-wasm`'s `TICKS_PER_SECOND`, 120000 today —
	 * chosen because it divides evenly into every standard and drop-frame rate).
	 * Mappers must read it from the document rather than hardcoding it.
	 */
	ticksPerSecond: number;
	/** Project frame rate as an exact rational (e.g. 30000/1001 for 29.97). */
	frameRate: EdlRational;
	canvas: { width: number; height: number };
	background: EdlBackground;
	projectId: string;
	projectName: string;
	/** EDL v1 describes exactly ONE scene — the one being exported. */
	sceneId: string;
	sceneName: string;
	/** Total timeline length of this scene, in ticks. */
	durationTicks: number;
}

export type EdlAssetKind = "video" | "image" | "audio";

/**
 * A piece of source media. Assets are referenced by clips and never inlined.
 *
 * `sourceUri` / `proxyUri` are NATIVE HANDLES supplied by the host through
 * `buildEdl`'s `resolveAsset` hook (plan §2.2: "Nothing crosses the JS↔native
 * bridge except JSON control messages, progress events, and URLs" — and
 * §2.6: media lives in the native sandbox, not in OPFS). A `blob:` URL here is
 * a bug: it is meaningless to the native exporter and `validateEdl({ strict })`
 * rejects it.
 */
export interface EdlAsset {
	assetId: string;
	kind: EdlAssetKind;
	name: string;
	/** Native file handle / content URI. `null` until M4 wires media custody. */
	sourceUri: string | null;
	/** Downscaled short-GOP preview proxy (plan Amendment 4). Preview only. */
	proxyUri: string | null;
	/** Container-level codec string if the host probed it, else null. */
	codec: string | null;
	width: number | null;
	height: number | null;
	/** Intrinsic length of the source, in ticks. `null` for stills. */
	durationTicks: number | null;
	/** Display rotation baked into the container metadata. */
	rotationDegrees: 0 | 90 | 180 | 270;
	hasAudio: boolean;
}

export type EdlTrackKind = "main" | "overlay" | "audio";
export type EdlTrackType =
	| "video"
	| "text"
	| "audio"
	| "graphic"
	| "effect"
	| "caption";

/**
 * `tracks` is NORMATIVE and z-ordered. `zIndex` 0 is the bottom-most
 * composited layer; higher paints later (on top). Audio tracks are not
 * composited and carry `zIndex: null`.
 *
 * This mirrors `services/renderer/scene-builder.ts::buildScene`, which composes
 * `[...tracks.overlay, tracks.main].reverse()` — i.e. the main track is the
 * BOTTOM layer and `overlay[0]` is the TOP one. That inversion is the single
 * easiest thing for a native mapper to get backwards, so the EDL states the
 * final order explicitly instead of making each mapper re-derive it.
 */
export interface EdlTrack {
	trackId: string;
	kind: EdlTrackKind;
	trackType: EdlTrackType;
	name: string;
	zIndex: number | null;
	muted: boolean;
	hidden: boolean;
	clips: EdlClip[];
}

export type EdlClipKind =
	| "video"
	| "image"
	| "audio"
	| "text"
	| "sticker"
	| "graphic"
	| "effect"
	| "caption";

export interface EdlTransform {
	positionX: number;
	positionY: number;
	scaleX: number;
	scaleY: number;
	rotateDegrees: number;
}

export interface EdlEffect {
	effectId: string;
	type: string;
	enabled: boolean;
	params: Record<string, number | string | boolean>;
}

/**
 * Masks are explicitly POST-v1 for native export (plan §2.3 rule 4). They are
 * carried in the document so the preview renderer and the export path read the
 * same graph, but `validateEdl` emits a warning for every non-empty `masks`
 * array and a v1 native mapper is expected to refuse the export rather than
 * silently drop them.
 */
export interface EdlMask {
	maskId: string;
	type: string;
	params: Record<string, unknown>;
}

export type EdlKeyframeInterpolation = "linear" | "hold" | "bezier";

/** Value-space deltas (`dv`) are floats; the time delta is always integer ticks. */
export interface EdlCurveHandle {
	dtTicks: number;
	dv: number;
}

export interface EdlKeyframe {
	keyframeId: string;
	/** Ticks RELATIVE TO THE CLIP'S OWN START, not to the timeline origin. */
	timeTicks: number;
	value: number | string | boolean;
	interpolation: EdlKeyframeInterpolation;
	leftHandle: EdlCurveHandle | null;
	rightHandle: EdlCurveHandle | null;
}

/**
 * One animated channel, flattened out of the engine's nested
 * `ElementAnimations` map. Composite properties (colours, which the engine
 * stores per-component) become one entry per component, distinguished by
 * `componentKey`; simple scalar channels carry `componentKey: null`.
 */
export interface EdlAnimationChannel {
	propertyPath: string;
	componentKey: string | null;
	extrapolationBefore: "hold" | "linear";
	extrapolationAfter: "hold" | "linear";
	keyframes: EdlKeyframe[];
}

/**
 * One word-level burn-in span, ADDITIVE to v1 (plan §2.3's "additive,
 * backwards-compatible fields may be appended to v1" rule — see this file's
 * header comment). `startTicks`/`endTicks` are in the SAME coordinate space
 * as the owning clip's `sourceStartTicks`/`sourceEndTicks`: a native mapper
 * burning in captions clips this array to the clip's own source window and
 * needs no extra unit conversion. Present and non-empty ONLY on `"caption"`
 * clips; `[]` on every other clip kind (mirrors `masks`/`effects`, which are
 * present-but-usually-empty on every clip too, rather than optional).
 * Styling (colour, highlight colour, font, position, animation style) is
 * NOT re-modelled here — same policy as text, it lives in `params` (see this
 * file's header comment on why v1 does not re-model typography), read by
 * key from `packages/editor-core/src/params/registry.ts`'s
 * `captionElementParams`.
 */
export interface EdlCaptionWord {
	text: string;
	startTicks: number;
	endTicks: number;
}

export interface EdlClip {
	clipId: string;
	kind: EdlClipKind;
	/** `null` for generated content (text, stickers, graphics, effect layers). */
	assetId: string | null;
	name: string;
	/** Position on the timeline, in ticks. */
	startTicks: number;
	/** Length occupied ON THE TIMELINE, in ticks. Already retimed. */
	durationTicks: number;
	/** First source tick consumed. */
	sourceStartTicks: number;
	/**
	 * One past the last source tick consumed:
	 * `sourceStartTicks + round(durationTicks * speed)`.
	 *
	 * Emitted explicitly so no mapper has to redo that multiplication in a
	 * different rounding mode. `validateEdl` re-derives it and fails on a
	 * mismatch of more than one tick.
	 */
	sourceEndTicks: number;
	/** Trim taken off the tail, in ticks. Bookkeeping; the span above is truth. */
	trimEndTicks: number;
	/**
	 * Source ticks consumed per timeline tick, as an exact rational. 2/1 is
	 * double speed (half the timeline duration); 1/2 is slow motion.
	 * `AVAssetTrack.scaleTimeRange(_:toDuration:)` and Media3's
	 * `SpeedChangeEffect` both want exactly this ratio.
	 */
	speed: EdlRational;
	maintainPitch: boolean;
	/** Decibels, matching the engine's `volume` param. 0 dB is unity. */
	volumeDb: number;
	muted: boolean;
	hidden: boolean;
	transform: EdlTransform;
	opacity: number;
	blendMode: string;
	effects: EdlEffect[];
	masks: EdlMask[];
	animations: EdlAnimationChannel[];
	/** `[]` unless `kind === "caption"`. See `EdlCaptionWord`'s doc comment. */
	captionWords: EdlCaptionWord[];
	/**
	 * The element's full resolved param bag. Text content, font, colours,
	 * sticker ids and graphic definition ids all live here — v1 does not
	 * re-model typography in the EDL, it passes the engine's params through so
	 * text rendering stays a single source of truth.
	 */
	params: Record<string, number | string | boolean>;
}

export type EdlOverlayKind = "text" | "sticker" | "graphic" | "caption";

/**
 * DERIVED VIEW, not a second source of truth.
 *
 * `tracks[]` is normative. `overlays[]` is a flat, z-ordered index of the
 * non-media visual clips, so a mapper building its overlay layer separately
 * from the A/V composition (which is how both `AVVideoCompositing` and Media3
 * overlay effects are structured) does not have to walk the track tree.
 * `validateEdl` fails if the two disagree.
 */
export interface EdlOverlay {
	overlayId: string;
	kind: EdlOverlayKind;
	trackId: string;
	clipId: string;
	zIndex: number;
	startTicks: number;
	durationTicks: number;
}

/**
 * Transitions between adjacent main-track clips. CapCut only allows these on
 * the main track, and so does EDL v1.
 *
 * v1 PRODUCER STATUS: always `[]`. The inherited engine has no transition model
 * (there is no `transitions` field anywhere in `timeline/types.ts`), so
 * `buildEdl` cannot populate this yet. The slot is frozen into v1 deliberately
 * so that adding transitions later is a producer change, not a schema break
 * that invalidates both native mappers. Mappers should implement it now and
 * expect an empty array until then.
 */
export interface EdlTransition {
	transitionId: string;
	/** The clip the transition follows. Must be a clip on the `main` track. */
	afterClipId: string;
	kind: string;
	durationTicks: number;
}

export interface EdlOutput {
	container: "mp4" | "webm";
	videoCodec: string;
	audioCodec: string;
	/** Video bitrate in bits per second. */
	bitrate: number;
	fps: EdlRational;
	resolution: { width: number; height: number };
	includeAudio: boolean;
}

export interface Edl {
	$schema: string;
	meta: EdlMeta;
	assets: EdlAsset[];
	tracks: EdlTrack[];
	transitions: EdlTransition[];
	overlays: EdlOverlay[];
	output: EdlOutput;
}
