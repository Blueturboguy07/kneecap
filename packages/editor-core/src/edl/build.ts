import type { FrameRate } from "opencut-wasm";
import type { MediaAssetData } from "@/services/storage/types";
import type { MediaType } from "@/media/types";
import type { TBackground, TProject } from "@/project/types";
import type {
	AudioTrack,
	OverlayTrack,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	TScene,
	VideoTrack,
} from "@/timeline/types";
import type {
	AnimationChannel,
	ChannelData,
	ElementAnimations,
	ScalarAnimationKey,
} from "@/animation/types";
import { TICKS_PER_SECOND, mediaTimeFromSeconds } from "@/wasm";
import { clampRetimeRate } from "@/retime/rate";
import {
	buildTransformFromParams,
	readBlendModeFromParams,
	readOpacityFromParams,
} from "@/rendering";
import { rationalFromNumber, reduceRational, scaleTicks } from "./rational";
import { getExportScale } from "./export-size";
import {
	EDL_SCHEMA_ID,
	EDL_VERSION,
	type Edl,
	type EdlAnimationChannel,
	type EdlAsset,
	type EdlCaptionWord,
	type EdlClip,
	type EdlClipKind,
	type EdlKeyframe,
	type EdlKeyframeInterpolation,
	type EdlOutput,
	type EdlOverlay,
	type EdlOverlayKind,
	type EdlRational,
	type EdlTrack,
	type EdlTrackType,
	type EdlTransform,
	type EdlTransition,
} from "./types";

/** Bumped alongside the package version; surfaced in `meta.generator`. */
const GENERATOR = "kneecap/editor-core@0.1.0";

/**
 * Host-supplied media resolution.
 *
 * The engine deliberately does NOT know where the bytes live (plan §2.6 — media
 * custody is native). M4's `NativeMediaStore` and the web dev harness both
 * implement this; without it every asset gets `sourceUri: null` and
 * `validateEdl({ strict: true })` refuses the document.
 */
export interface EdlAssetResolution {
	sourceUri?: string | null;
	proxyUri?: string | null;
	codec?: string | null;
	rotationDegrees?: 0 | 90 | 180 | 270;
}

export type EdlAssetResolver = (args: {
	mediaId: string;
	asset: MediaAssetData;
}) => EdlAssetResolution | null;

export interface BuildEdlArgs {
	project: TProject;
	/** The single scene being exported. EDL v1 is one scene per document. */
	scene: TScene;
	/** Media metadata for every asset the scene references. */
	mediaAssets: MediaAssetData[];
	output: BuildEdlOutputArgs;
	resolveAsset?: EdlAssetResolver;
	/** Total scene duration in ticks; defaults to the max clip end. */
	durationTicks?: number;
}

export interface BuildEdlOutputArgs {
	container: "mp4" | "webm";
	videoCodec: string;
	audioCodec: string;
	bitrate: number;
	includeAudio: boolean;
	/** Defaults to the project frame rate. */
	fps?: FrameRate;
	/**
	 * Defaults to the project canvas size. When it differs (1.0.8: the mobile
	 * export sheet's resolution, see `export-size.ts`), every spatial value is
	 * scaled from canvas pixels to output pixels with one factor per axis
	 * (clip positions, position keyframes and the position params), and
	 * `meta.canvas` is the output size. So a native exporter always gets
	 * canvas = output, the case both exporters place correctly.
	 */
	resolution?: { width: number; height: number };
}

/** Output pixels per canvas pixel (`getExportScale`). */
type SpatialScale = { x: number; y: number };

const IDENTITY_SCALE: SpatialScale = { x: 1, y: 1 };

function isIdentityScale(spatial: SpatialScale): boolean {
	return spatial.x === 1 && spatial.y === 1;
}

/** The position paths are the only canvas-pixel values a native exporter
 *  reads: sizes are a scale over a contain-fit of the output, rotation and
 *  opacity have no unit, and text, captions, stickers and graphics come as
 *  prerendered overlay frames drawn at the output size. */
function positionFactor({
	propertyPath,
	spatial,
}: {
	propertyPath: string;
	spatial: SpatialScale;
}): number | null {
	if (propertyPath === "transform.positionX") return spatial.x;
	if (propertyPath === "transform.positionY") return spatial.y;
	return null;
}

function scalePositionChannels({
	channels,
	spatial,
}: {
	channels: EdlAnimationChannel[];
	spatial: SpatialScale;
}): EdlAnimationChannel[] {
	if (isIdentityScale(spatial)) return channels;
	return channels.map((channel) => {
		const factor =
			channel.componentKey === null
				? positionFactor({ propertyPath: channel.propertyPath, spatial })
				: null;
		if (factor === null) return channel;
		return {
			...channel,
			keyframes: channel.keyframes.map((key) => ({
				...key,
				value: typeof key.value === "number" ? key.value * factor : key.value,
				leftHandle: key.leftHandle
					? { dtTicks: key.leftHandle.dtTicks, dv: key.leftHandle.dv * factor }
					: null,
				rightHandle: key.rightHandle
					? { dtTicks: key.rightHandle.dtTicks, dv: key.rightHandle.dv * factor }
					: null,
			})),
		};
	});
}

function scalePositionParams({
	params,
	spatial,
}: {
	params: EdlClip["params"];
	spatial: SpatialScale;
}): EdlClip["params"] {
	if (isIdentityScale(spatial)) return params;
	const out: EdlClip["params"] = { ...params };
	for (const key of Object.keys(out)) {
		const factor = positionFactor({ propertyPath: key, spatial });
		const value = out[key];
		if (factor !== null && typeof value === "number") out[key] = value * factor;
	}
	return out;
}

const MEDIA_KIND: Record<MediaType, "video" | "image" | "audio"> = {
	video: "video",
	image: "image",
	audio: "audio",
};

function toRational(rate: FrameRate): EdlRational {
	return reduceRational({
		numerator: rate.numerator,
		denominator: rate.denominator,
	});
}

function readNumberParam({
	element,
	key,
	fallback,
}: {
	element: TimelineElement;
	key: string;
	fallback: number;
}): number {
	const value = element.params[key];
	return typeof value === "number" ? value : fallback;
}

function readBooleanParam({
	element,
	key,
	fallback,
}: {
	element: TimelineElement;
	key: string;
	fallback: boolean;
}): boolean {
	const value = element.params[key];
	return typeof value === "boolean" ? value : fallback;
}

function isScalarKey(key: unknown): key is ScalarAnimationKey {
	return typeof key === "object" && key !== null && "segmentToNext" in key;
}

function keyInterpolation(key: unknown): EdlKeyframeInterpolation {
	if (!isScalarKey(key)) return "hold";
	if (key.segmentToNext === "step") return "hold";
	if (key.segmentToNext === "bezier") return "bezier";
	return "linear";
}

function isChannel(value: unknown): value is AnimationChannel {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { keys?: unknown }).keys)
	);
}

function buildChannel({
	propertyPath,
	componentKey,
	channel,
}: {
	propertyPath: string;
	componentKey: string | null;
	channel: AnimationChannel;
}): EdlAnimationChannel {
	const extrapolation =
		"extrapolation" in channel ? channel.extrapolation : undefined;

	const keyframes: EdlKeyframe[] = channel.keys.map((key) => ({
		keyframeId: key.id,
		timeTicks: key.time,
		value: key.value,
		interpolation: keyInterpolation(key),
		leftHandle:
			isScalarKey(key) && key.leftHandle
				? { dtTicks: key.leftHandle.dt, dv: key.leftHandle.dv }
				: null,
		rightHandle:
			isScalarKey(key) && key.rightHandle
				? { dtTicks: key.rightHandle.dt, dv: key.rightHandle.dv }
				: null,
	}));

	return {
		propertyPath,
		componentKey,
		extrapolationBefore: extrapolation?.before ?? "hold",
		extrapolationAfter: extrapolation?.after ?? "hold",
		keyframes,
	};
}

/**
 * Flatten the engine's nested `ElementAnimations` into a stable, ordered array.
 *
 * The engine stores `{ [propertyPath]: ScalarChannel | { [component]: Channel } }`.
 * A native mapper wants a list it can iterate once, so composite channels are
 * split into one entry per component with `componentKey` set. Output is sorted
 * by (propertyPath, componentKey) so two builds of the same project produce
 * byte-identical JSON — which is what makes the golden-fixture test meaningful.
 */
function buildAnimations({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): EdlAnimationChannel[] {
	if (!animations) return [];
	const out: EdlAnimationChannel[] = [];

	for (const propertyPath of Object.keys(animations).sort()) {
		const data: ChannelData | undefined = animations[propertyPath];
		if (!data) continue;

		if (isChannel(data)) {
			out.push(buildChannel({ propertyPath, componentKey: null, channel: data }));
			continue;
		}

		for (const componentKey of Object.keys(data).sort()) {
			const channel = data[componentKey];
			if (!channel) continue;
			out.push(buildChannel({ propertyPath, componentKey, channel }));
		}
	}

	return out;
}

const OVERLAY_KIND: Partial<Record<EdlClipKind, EdlOverlayKind>> = {
	text: "text",
	sticker: "sticker",
	graphic: "graphic",
	caption: "caption",
};

/** `[]` for every element type except `"caption"`. Word ticks pass through
 * unchanged — they are already in the clip's own source-tick space (see
 * `timeline/types.ts`'s `CaptionWord` doc comment), exactly the space
 * `sourceStartTicks`/`sourceEndTicks` below are expressed in. */
function buildCaptionWords({ element }: { element: TimelineElement }): EdlCaptionWord[] {
	if (element.type !== "caption") return [];
	return element.words.map((word) => ({
		text: word.text,
		startTicks: word.startTime,
		endTicks: word.endTime,
	}));
}

function buildClip({
	element,
	spatial = IDENTITY_SCALE,
}: {
	element: TimelineElement;
	spatial?: SpatialScale;
}): EdlClip {
	const kind = element.type as EdlClipKind;
	const retime = "retime" in element ? element.retime : undefined;

	// The engine stores retime rate as a clamped float. This is the single
	// point where it becomes an exact rational for the bridge.
	const speed = rationalFromNumber({
		value: clampRetimeRate({ rate: retime?.rate ?? 1 }),
	});

	// `services/renderer/resolve.ts` computes source time as
	// `trimStart + clipTime * rate` for clipTime in [0, duration). So the span
	// consumed is exactly `duration * rate` ticks starting at `trimStart`.
	const sourceStartTicks = element.trimStart;
	const sourceEndTicks =
		sourceStartTicks + scaleTicks({ ticks: element.duration, rate: speed });

	const transform: EdlTransform = (() => {
		const t = buildTransformFromParams({ params: element.params });
		const identity = isIdentityScale(spatial);
		return {
			positionX: identity ? t.position.x : t.position.x * spatial.x,
			positionY: identity ? t.position.y : t.position.y * spatial.y,
			scaleX: t.scaleX,
			scaleY: t.scaleY,
			rotateDegrees: t.rotate,
		};
	})();

	const assetId =
		"mediaId" in element && typeof element.mediaId === "string"
			? element.mediaId
			: null;

	return {
		clipId: element.id,
		kind,
		assetId,
		name: element.name,
		startTicks: element.startTime,
		durationTicks: element.duration,
		sourceStartTicks,
		sourceEndTicks,
		trimEndTicks: element.trimEnd,
		speed,
		maintainPitch: retime?.maintainPitch === true,
		volumeDb: readNumberParam({ element, key: "volume", fallback: 0 }),
		muted: readBooleanParam({ element, key: "muted", fallback: false }),
		hidden: "hidden" in element ? element.hidden === true : false,
		transform,
		opacity: readOpacityFromParams({ params: element.params }),
		blendMode: readBlendModeFromParams({ params: element.params }),
		effects:
			"effects" in element && element.effects
				? element.effects.map((effect) => ({
						effectId: effect.id,
						type: effect.type,
						enabled: effect.enabled,
						params: { ...effect.params },
					}))
				: [],
		masks:
			"masks" in element && element.masks
				? element.masks.map((mask) => ({
						maskId: mask.id,
						type: mask.type,
						params: { ...mask.params } as Record<string, unknown>,
					}))
				: [],
		animations: scalePositionChannels({
			channels: buildAnimations({ animations: element.animations }),
			spatial,
		}),
		captionWords: buildCaptionWords({ element }),
		params: scalePositionParams({ params: { ...element.params }, spatial }),
	};
}

/**
 * Flatten `SceneTracks` into an explicitly z-ordered list.
 *
 * Mirrors `services/renderer/scene-builder.ts::buildScene`, which composites
 * `[...tracks.overlay, tracks.main].reverse()`. Bottom to top that is:
 * main, then overlay[last] … overlay[0]. `zIndex` here is assigned in that
 * bottom-to-top order so the mapper never has to know about the reversal.
 */
function orderTracks({ tracks }: { tracks: SceneTracks }): Array<{
	track: TimelineTrack;
	kind: "main" | "overlay" | "audio";
	zIndex: number | null;
}> {
	// zIndex ascends bottom-to-top: main first, then overlays. CAPTIONS
	// ALWAYS ON TOP (round 34, founder: "captions are always layered on top
	// of text") — otherwise a text track added later out-stacked them.
	// `services/renderer/scene-builder.ts` applies the same rule so the
	// preview and the export stack identically.
	const composited: Array<{
		track: VideoTrack | OverlayTrack;
		kind: "main" | "overlay";
	}> = [
		{ track: tracks.main, kind: "main" },
		...[...tracks.overlay]
			.reverse()
			.sort((a, b) => Number(a.type === "caption") - Number(b.type === "caption"))
			.map((track) => ({ track, kind: "overlay" as const })),
	];

	const ordered = composited.map((entry, index) => ({
		track: entry.track as TimelineTrack,
		kind: entry.kind,
		zIndex: index as number | null,
	}));

	const audio = tracks.audio.map((track: AudioTrack) => ({
		track: track as TimelineTrack,
		kind: "audio" as const,
		zIndex: null,
	}));

	return [...ordered, ...audio];
}

function trackFlags({ track }: { track: TimelineTrack }): {
	muted: boolean;
	hidden: boolean;
} {
	return {
		muted: "muted" in track ? track.muted === true : false,
		hidden: "hidden" in track ? track.hidden === true : false,
	};
}

function buildAssets({
	mediaAssets,
	resolveAsset,
}: {
	mediaAssets: MediaAssetData[];
	resolveAsset?: EdlAssetResolver;
}): EdlAsset[] {
	return [...mediaAssets]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((asset) => {
			const resolved = resolveAsset?.({ mediaId: asset.id, asset }) ?? null;
			return {
				assetId: asset.id,
				kind: MEDIA_KIND[asset.type],
				name: asset.name,
				sourceUri: resolved?.sourceUri ?? null,
				proxyUri: resolved?.proxyUri ?? null,
				codec: resolved?.codec ?? null,
				width: asset.width ?? null,
				height: asset.height ?? null,
				// `MediaAssetData.duration` is in SECONDS (it comes straight off the
				// decoder probe). This is the ONLY seconds→ticks conversion in the
				// builder, and it is why it goes through the wasm boundary rather
				// than a bare multiply.
				durationTicks:
					typeof asset.duration === "number"
						? mediaTimeFromSeconds({ seconds: asset.duration })
						: null,
				rotationDegrees: resolved?.rotationDegrees ?? 0,
				hasAudio: asset.hasAudio === true,
			};
		});
}

function backgroundOf({ background }: { background: TBackground }) {
	return background.type === "blur"
		? { type: "blur" as const, blurIntensity: background.blurIntensity }
		: { type: "color" as const, color: background.color };
}

/**
 * `buildEdl(project) -> Edl`. Plan §2.3 rule 2: "The EDL is generated by one
 * function in the shared TS core, not by the UI."
 *
 * Deterministic: assets are sorted by id, clips by (startTicks, clipId), and
 * animation channels by (propertyPath, componentKey), so the same project graph
 * always serialises to the same bytes. That determinism is what makes the
 * golden fixture and the future golden-frame comparison worth anything.
 */
export function buildEdl({
	project,
	scene,
	mediaAssets,
	output,
	resolveAsset,
	durationTicks,
}: BuildEdlArgs): Edl {
	const frameRate = toRational(project.settings.fps);
	const projectCanvas = project.settings.canvasSize;
	const outputResolution = output.resolution ?? {
		width: projectCanvas.width,
		height: projectCanvas.height,
	};
	// 1.0.8: the spatial values go out in OUTPUT pixels, and `meta.canvas` is
	// the output size (see BuildEdlOutputArgs.resolution).
	const spatial = getExportScale({
		canvasSize: projectCanvas,
		outputSize: outputResolution,
	});
	const canvas = isIdentityScale(spatial) ? projectCanvas : outputResolution;

	const tracks: EdlTrack[] = orderTracks({ tracks: scene.tracks }).map(
		({ track, kind, zIndex }) => {
			const flags = trackFlags({ track });
			const clips = [...track.elements]
				.sort((a, b) =>
					a.startTime !== b.startTime
						? a.startTime - b.startTime
						: a.id.localeCompare(b.id),
				)
				.map((element) => buildClip({ element, spatial }));

			return {
				trackId: track.id,
				kind,
				trackType: track.type as EdlTrackType,
				name: track.name,
				zIndex,
				muted: flags.muted,
				hidden: flags.hidden,
				clips,
			};
		},
	);

	const overlays: EdlOverlay[] = [];
	for (const track of tracks) {
		if (track.zIndex === null) continue;
		for (const clip of track.clips) {
			const overlayKind = OVERLAY_KIND[clip.kind];
			if (!overlayKind) continue;
			overlays.push({
				overlayId: `${track.trackId}:${clip.clipId}`,
				kind: overlayKind,
				trackId: track.trackId,
				clipId: clip.clipId,
				zIndex: track.zIndex,
				startTicks: clip.startTicks,
				durationTicks: clip.durationTicks,
			});
		}
	}
	overlays.sort((a, b) =>
		a.zIndex !== b.zIndex
			? a.zIndex - b.zIndex
			: a.startTicks !== b.startTicks
				? a.startTicks - b.startTicks
				: a.overlayId.localeCompare(b.overlayId),
	);

	const computedDuration = tracks.reduce((max, track) => {
		for (const clip of track.clips) {
			const end = clip.startTicks + clip.durationTicks;
			if (end > max) max = end;
		}
		return max;
	}, 0);

	const outputFps = output.fps ? toRational(output.fps) : frameRate;

	const edlOutput: EdlOutput = {
		container: output.container,
		videoCodec: output.videoCodec,
		audioCodec: output.audioCodec,
		bitrate: output.bitrate,
		fps: outputFps,
		resolution: { width: outputResolution.width, height: outputResolution.height },
		includeAudio: output.includeAudio,
	};

	return {
		$schema: EDL_SCHEMA_ID,
		meta: {
			edlVersion: EDL_VERSION,
			generator: GENERATOR,
			ticksPerSecond: TICKS_PER_SECOND,
			frameRate,
			canvas: { width: canvas.width, height: canvas.height },
			background: backgroundOf({ background: project.settings.background }),
			projectId: project.metadata.id,
			projectName: project.metadata.name,
			sceneId: scene.id,
			sceneName: scene.name,
			durationTicks: durationTicks ?? computedDuration,
		},
		assets: buildAssets({ mediaAssets, resolveAsset }),
		tracks,
		transitions: buildTransitions({ scene }),
		overlays,
		output: edlOutput,
	};
}

/**
 * Main-track transitions from the scene model (`TScene.transitions`). The
 * native mapper (MainTrackPlacement.swift) THROWS on a transition whose
 * afterClipId is unknown or not immediately followed by another main-track
 * clip, so the producer drops those defensively here — a transition whose
 * neighbor was deleted goes dormant instead of failing the export. Kinds
 * pass through as authored: "fade" maps to the compositor's canonical
 * "cross_fade"; every other kind is carried verbatim and falls back to the
 * same dissolve on the native side (its documented behavior) — matching the
 * preview, which also renders every kind as a cross-fade in v1.
 */
function buildTransitions({ scene }: { scene: TScene }): EdlTransition[] {
	const transitions = scene.transitions ?? [];
	if (transitions.length === 0) return [];

	const mainElements = [...scene.tracks.main.elements]
		.filter((element) => !("hidden" in element && element.hidden))
		.sort((a, b) =>
			a.startTime !== b.startTime
				? a.startTime - b.startTime
				: a.id.localeCompare(b.id),
		);
	const indexById = new Map<string, number>();
	mainElements.forEach((element, index) => indexById.set(element.id, index));

	const out: EdlTransition[] = [];
	for (const transition of transitions) {
		const index = indexById.get(transition.afterElementId);
		if (index === undefined || index + 1 >= mainElements.length) continue;
		if (!Number.isInteger(transition.duration) || transition.duration <= 0) continue;
		out.push({
			transitionId: transition.id,
			afterClipId: transition.afterElementId,
			kind: transition.kind === "fade" ? "cross_fade" : transition.kind,
			durationTicks: transition.duration,
		});
	}
	out.sort((a, b) => a.afterClipId.localeCompare(b.afterClipId));
	return out;
}

/**
 * Canonical JSON serialisation. Stable key order comes from the object literal
 * shapes above; `JSON.stringify` preserves insertion order for string keys, so
 * two builds of the same graph produce identical bytes.
 */
export function serializeEdl({
	edl,
	pretty = true,
}: {
	edl: Edl;
	pretty?: boolean;
}): string {
	return JSON.stringify(edl, null, pretty ? "\t" : undefined);
}

export function parseEdl({ json }: { json: string }): Edl {
	// `JSON.parse` is `any`; this cast is the ONLY unchecked step in the whole
	// module, and it is immediately followed in practice by `validateEdl`, which
	// re-checks every field this type claims. Never trust a parsed EDL without
	// validating it — a document can arrive from a native shell or from disk.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return JSON.parse(json) as Edl;
}
