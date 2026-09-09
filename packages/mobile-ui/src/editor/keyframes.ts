/**
 * Clip keyframes — the CapCut-mobile keyframe model over the engine's
 * per-property animation channels (round 47, founder: "i want to add
 * keyframes").
 *
 * WHAT CAPCUT MOBILE DOES (research corpus 05 §4 + 2026 tutorials, the
 * founder capture for the exact chrome is still [NEEDS-CAPTURE]): select a
 * clip, a diamond appears above the timeline; tap it and a keyframe drops at
 * the playhead holding the clip's CURRENT position / scale / rotation /
 * opacity. Move the playhead, change any of those (drag or pinch the
 * preview, slide opacity) and the next keyframe is added AUTOMATICALLY.
 * Small diamonds render on the clip; ‹ › arrows jump between them; tapping
 * the diamond while ON a keyframe removes it; an Easing/Graph option sets
 * how the value moves to the next keyframe.
 *
 * THE MODEL THIS FILE ENCODES: one "clip keyframe" = ONE time at which EVERY
 * path in `CLIP_KEYFRAME_PATHS` has a key. The engine keys each property
 * independently (the web editor exposes a diamond per property), but CapCut
 * shows one diamond per time, so every add / auto-add writes the whole
 * group at once. Keeping the group complete is what makes "is the playhead
 * on a keyframe", "delete this keyframe" and "jump to the next keyframe"
 * unambiguous — a half-keyed time would be a diamond that only half deletes.
 *
 * Everything here is pure (no EditorCore, no DOM): the actions in
 * `actions.ts` and the preview gesture in `preview-renderer.tsx` call these
 * and hand the results to the engine's own keyframe commands.
 *
 * TIME RULE: keyframe times are CLIP-LOCAL ticks (`MediaTime`, relative to
 * the element's `startTime`, independent of speed) — the same convention the
 * engine's `getElementLocalTime`, the renderer, and the EDL (`timeTicks`)
 * all use. Seconds appear only at the very edge, in the timeline view-model.
 */
import type { ElementRef, TimelineElement } from "@kneecap/editor-core/timeline";
import type {
	AnimationChannel,
	ElementAnimations,
	NormalizedCubicBezier,
	ScalarAnimationKey,
	ScalarCurveKeyframePatch,
} from "@kneecap/editor-core/animation/types";
import {
	getChannel,
	getCurveHandlesForNormalizedCubicBezier,
	getElementKeyframes,
	getElementLocalTime,
	getKeyframeAtTime,
	getNormalizedCubicBezierForScalarSegment,
	resolveAnimationPathValueAtTime,
	updateScalarKeyframeCurve,
	upsertPathKeyframe,
} from "@kneecap/editor-core/animation";
import { resolveAnimationTarget } from "@kneecap/editor-core/timeline/animation-targets";
import { mediaTime, roundFrameTicks, TICKS_PER_SECOND, type MediaTime } from "@kneecap/editor-core/wasm";
import type { FrameRate } from "opencut-wasm";

/** The property group one CapCut-style diamond stands for: the full 2D
 *  transform plus opacity. `transform.rotate` is included even though the
 *  mobile preview has no rotate gesture yet, so a keyframe always carries
 *  the complete group and the native exporters never see a half-keyed
 *  clip. (Volume is keyframable in the engine too, but CapCut keys it from
 *  the audio panel, not the clip diamond — out of scope for this group.) */
export const CLIP_KEYFRAME_PATHS = [
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
	"transform.rotate",
	"opacity",
] as const;

export type ClipKeyframePath = (typeof CLIP_KEYFRAME_PATHS)[number];
export type ClipKeyframeValues = Record<ClipKeyframePath, number>;

const CLIP_KEYFRAME_PATH_SET: ReadonlySet<string> = new Set(CLIP_KEYFRAME_PATHS);

/** Engine defaults when a param is absent (`buildTransformFromParams` /
 *  `readOpacityFromParams` in editor-core/rendering use these exact
 *  fallbacks — read from there, not re-invented). */
const CLIP_KEYFRAME_DEFAULTS: ClipKeyframeValues = {
	"transform.positionX": 0,
	"transform.positionY": 0,
	"transform.scaleX": 1,
	"transform.scaleY": 1,
	"transform.rotate": 0,
	opacity: 1,
};

export function isClipKeyframePath(path: string): path is ClipKeyframePath {
	return CLIP_KEYFRAME_PATH_SET.has(path);
}

function readBaseValue({ element, path }: { element: TimelineElement; path: ClipKeyframePath }): number {
	const raw = element.params[path];
	return typeof raw === "number" && Number.isFinite(raw) ? raw : CLIP_KEYFRAME_DEFAULTS[path];
}

// ------------------------------------------------------------------ times --

/** Every time (clip-local ticks) at which ANY group path has a key —
 *  unique, ascending. A partially keyed time (a project authored on the web
 *  editor with, say, only opacity keyed) still shows as a diamond, because
 *  it IS a keyframe the user can see and delete. */
export function getClipKeyframeTimes({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): MediaTime[] {
	const times = new Set<number>();
	for (const keyframe of getElementKeyframes({ animations })) {
		if (isClipKeyframePath(keyframe.propertyPath)) {
			times.add(keyframe.time);
		}
	}
	return [...times].sort((a, b) => a - b).map((ticks) => mediaTime({ ticks }));
}

export function hasClipKeyframes({ animations }: { animations: ElementAnimations | undefined }): boolean {
	return getClipKeyframeTimes({ animations }).length > 0;
}

/** Ticks per output frame — the granularity both the preview (`Math.floor
 *  (time / ticksPerFrame)` in preview-renderer) and the export sample at. */
export function frameTicksFor({ fps }: { fps: FrameRate }): number {
	return Math.max(1, Math.round((TICKS_PER_SECOND * fps.denominator) / fps.numerator));
}

/** Playhead -> clip-local ticks, clamped to [0, duration] exactly like the
 *  renderer's own `getElementLocalTime`. */
export function clipLocalTime({
	element,
	timelineTime,
}: {
	element: TimelineElement;
	timelineTime: MediaTime;
}): MediaTime {
	return mediaTime({
		ticks: Math.round(
			getElementLocalTime({
				timelineTime,
				elementStartTime: element.startTime,
				elementDuration: element.duration,
			}),
		),
	});
}

/** Snap a local time onto the project's frame grid and keep it inside the
 *  clip. A keyframe between two frames would render at one of them anyway;
 *  snapping makes the diamond and the frame the user is looking at agree,
 *  and makes "is the playhead on this keyframe" an exact tick comparison
 *  after the ± half-frame tolerance below. */
export function snapLocalTimeToFrame({
	localTime,
	fps,
	duration,
}: {
	localTime: MediaTime;
	fps: FrameRate;
	duration: MediaTime;
}): MediaTime {
	const snapped = Math.round(roundFrameTicks({ ticks: localTime, fps }));
	return mediaTime({ ticks: Math.max(0, Math.min(duration, snapped)) });
}

/** The keyframe the playhead is "on": an exact hit, else the nearest one
 *  within `toleranceTicks` (half a frame in practice — a scrubbed playhead
 *  rarely lands on the exact tick, and CapCut treats the frame as the unit). */
export function findClipKeyframeAtTime({
	times,
	time,
	toleranceTicks,
}: {
	times: readonly MediaTime[];
	time: MediaTime;
	toleranceTicks: number;
}): MediaTime | null {
	let best: MediaTime | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of times) {
		const distance = Math.abs(candidate - time);
		if (distance <= toleranceTicks && distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return best;
}

/** ‹ › navigation: the nearest keyframe strictly before/after the playhead,
 *  ignoring the one the playhead is already on (within tolerance) — pressing
 *  "next" while sitting on a keyframe must go to the NEXT one, not re-land
 *  on the same tick. */
export function adjacentClipKeyframeTime({
	times,
	time,
	direction,
	toleranceTicks,
}: {
	times: readonly MediaTime[];
	time: MediaTime;
	direction: "previous" | "next";
	toleranceTicks: number;
}): MediaTime | null {
	if (direction === "previous") {
		let found: MediaTime | null = null;
		for (const candidate of times) {
			if (candidate < time - toleranceTicks) found = candidate;
		}
		return found;
	}
	for (const candidate of times) {
		if (candidate > time + toleranceTicks) return candidate;
	}
	return null;
}

// ----------------------------------------------------------------- values --

/** The group's effective values at a clip-local time: animated channels win,
 *  static params (or engine defaults) fill in for un-keyed paths. This is
 *  what a new keyframe records and what a preview drag starts from. */
export function resolveClipValuesAtTime({
	element,
	localTime,
}: {
	element: TimelineElement;
	localTime: MediaTime;
}): ClipKeyframeValues {
	const values = { ...CLIP_KEYFRAME_DEFAULTS };
	for (const path of CLIP_KEYFRAME_PATHS) {
		values[path] = resolveAnimationPathValueAtTime({
			animations: element.animations,
			propertyPath: path,
			localTime: Math.max(0, localTime),
			fallbackValue: readBaseValue({ element, path }),
		});
	}
	return values;
}

export interface ClipKeyframeUpsert {
	trackId: string;
	elementId: string;
	propertyPath: ClipKeyframePath;
	time: MediaTime;
	value: number;
}

/** One complete group keyframe at `localTime` — the current resolved values,
 *  with `overrides` for whatever the user just changed. Feed straight into
 *  `editor.timeline.upsertKeyframes` (one undo step for the whole group). */
export function buildClipKeyframeUpserts({
	ref,
	element,
	localTime,
	overrides,
}: {
	ref: ElementRef;
	element: TimelineElement;
	localTime: MediaTime;
	overrides?: Partial<ClipKeyframeValues>;
}): ClipKeyframeUpsert[] {
	const resolved = resolveClipValuesAtTime({ element, localTime });
	return CLIP_KEYFRAME_PATHS.map((propertyPath) => ({
		trackId: ref.trackId,
		elementId: ref.elementId,
		propertyPath,
		time: localTime,
		value: overrides?.[propertyPath] ?? resolved[propertyPath],
	}));
}

export interface ClipKeyframeRemoval {
	trackId: string;
	elementId: string;
	propertyPath: ClipKeyframePath;
	keyframeId: string;
}

/** Every group key sitting EXACTLY at `time` (the matched keyframe time, not
 *  the raw playhead) — removing them all is what "delete this diamond"
 *  means. Paths without a key at that time are simply not listed. */
export function buildClipKeyframeRemovals({
	ref,
	element,
	time,
}: {
	ref: ElementRef;
	element: TimelineElement;
	time: MediaTime;
}): ClipKeyframeRemoval[] {
	const removals: ClipKeyframeRemoval[] = [];
	for (const propertyPath of CLIP_KEYFRAME_PATHS) {
		const keyframe = getKeyframeAtTime({ animations: element.animations, propertyPath, time });
		if (keyframe) {
			removals.push({ trackId: ref.trackId, elementId: ref.elementId, propertyPath, keyframeId: keyframe.id });
		}
	}
	return removals;
}

/** Write a whole group keyframe into an `animations` map WITHOUT going through
 *  a command — the preview-gesture path: every pointer-move frame builds the
 *  element's next `animations` from the PRE-GESTURE map and hands it to
 *  `timeline.previewElements`; release commits the last one as a single
 *  TracksSnapshotCommand. Uses the engine's own per-path descriptor
 *  (`resolveAnimationTarget`) for channel layout + value coercion so the
 *  result is byte-for-byte what `UpsertKeyframeCommand` would have written. */
export function upsertClipAnimationValues({
	element,
	localTime,
	values,
}: {
	element: TimelineElement;
	localTime: MediaTime;
	values: ClipKeyframeValues;
}): ElementAnimations | undefined {
	let animations = element.animations;
	for (const propertyPath of CLIP_KEYFRAME_PATHS) {
		const target = resolveAnimationTarget({ element, path: propertyPath });
		if (!target) continue;
		animations = upsertPathKeyframe({
			animations,
			propertyPath,
			time: localTime,
			value: values[propertyPath],
			channelLayout: target.channelLayout,
			coerceValue: target.coerceValue,
		});
	}
	return animations;
}

// ----------------------------------------------------------------- easing --

/** CapCut mobile's easing presets (its "Graph" on desktop exposes handles;
 *  mobile offers presets only — corpus + 2026 tutorials). Curves are the CSS
 *  standard `ease-in` / `ease-out` / `ease-in-out` control points, which is
 *  what every editor that ships named presets uses. `hold` is a step (the
 *  value jumps at the next keyframe) — the engine's `"step"` segment. */
export type ClipKeyframeEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "hold";

export const CLIP_KEYFRAME_EASINGS: readonly ClipKeyframeEasing[] = [
	"linear",
	"ease-in",
	"ease-out",
	"ease-in-out",
	"hold",
];

type BezierEasing = Exclude<ClipKeyframeEasing, "linear" | "hold">;

const EASING_PRESETS: ReadonlyArray<{ easing: BezierEasing; curve: NormalizedCubicBezier }> = [
	{ easing: "ease-in", curve: [0.42, 0, 1, 1] },
	{ easing: "ease-out", curve: [0, 0, 0.58, 1] },
	{ easing: "ease-in-out", curve: [0.42, 0, 0.58, 1] },
];

function presetCurve({ easing }: { easing: BezierEasing }): NormalizedCubicBezier {
	const preset = EASING_PRESETS.find((candidate) => candidate.easing === easing);
	if (!preset) throw new Error(`unknown easing preset ${easing}`);
	return preset.curve;
}

function isScalarKey(key: AnimationChannel["keys"][number]): key is ScalarAnimationKey {
	return "segmentToNext" in key;
}

/** A flat segment (both keys hold the same value) has no value span to
 *  normalize handles against; the engine's curve bridge takes a reference
 *  span for that case. All three presets have y1 = 0 and y2 = 1, so with a
 *  reference of 1 the value handles come out exactly 0 — a flat segment
 *  stays flat, it just carries the timing curve for when a value is later
 *  edited into it. */
const FLAT_SEGMENT_REFERENCE_SPAN = 1;

const CURVE_MATCH_TOLERANCE = 0.02;

function scalarKeysAt({
	animations,
	propertyPath,
	time,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: ClipKeyframePath;
	time: MediaTime;
}): { key: ScalarAnimationKey; next: ScalarAnimationKey | null } | null {
	const channel = getChannel({ animations, propertyPath });
	if (!channel) return null;
	const index = channel.keys.findIndex((key) => key.time === time);
	if (index < 0) return null;
	const key = channel.keys[index];
	const next = channel.keys[index + 1] ?? null;
	if (!isScalarKey(key) || (next !== null && !isScalarKey(next))) return null;
	return { key, next };
}

function easingOfSegment({ key, next }: { key: ScalarAnimationKey; next: ScalarAnimationKey }): ClipKeyframeEasing | "custom" {
	if (key.segmentToNext === "step") return "hold";
	if (key.segmentToNext === "linear") return "linear";
	const curve = getNormalizedCubicBezierForScalarSegment({
		leftKey: key,
		rightKey: next,
		referenceSpanValue: FLAT_SEGMENT_REFERENCE_SPAN,
	});
	if (!curve) return "custom";
	for (const preset of EASING_PRESETS) {
		if (preset.curve.every((component, i) => Math.abs(component - curve[i]) <= CURVE_MATCH_TOLERANCE)) {
			return preset.easing;
		}
	}
	return "custom";
}

/** The easing of the segment leaving the keyframe at `time`, as the group
 *  sees it: one answer when every keyed path agrees, `"mixed"` when they
 *  don't (a web-authored project can ease X and Y differently), `"custom"`
 *  for a bezier that is none of the presets (a hand-dragged desktop graph),
 *  and `null` when there is no keyframe at `time` or nothing follows it. */
export function getClipKeyframeEasing({
	animations,
	time,
}: {
	animations: ElementAnimations | undefined;
	time: MediaTime;
}): ClipKeyframeEasing | "custom" | "mixed" | null {
	let result: ClipKeyframeEasing | "custom" | null = null;
	for (const propertyPath of CLIP_KEYFRAME_PATHS) {
		const pair = scalarKeysAt({ animations, propertyPath, time });
		if (!pair || !pair.next) continue;
		const easing = easingOfSegment({ key: pair.key, next: pair.next });
		if (result === null) result = easing;
		else if (result !== easing) return "mixed";
	}
	return result;
}

/** Set the easing of the segment leaving the keyframe at `time` on EVERY
 *  group path that has a key there and a key after it. Returns the element's
 *  next `animations`; unchanged (same reference) when nothing applied, so a
 *  caller can skip the command. */
export function applyClipKeyframeEasing({
	animations,
	time,
	easing,
}: {
	animations: ElementAnimations | undefined;
	time: MediaTime;
	easing: ClipKeyframeEasing;
}): ElementAnimations | undefined {
	let next = animations;
	for (const propertyPath of CLIP_KEYFRAME_PATHS) {
		const pair = scalarKeysAt({ animations: next, propertyPath, time });
		if (!pair || !pair.next) continue;
		let keyPatch: ScalarCurveKeyframePatch;
		let nextKeyPatch: ScalarCurveKeyframePatch | null = null;
		if (easing === "hold") {
			keyPatch = { segmentToNext: "step", rightHandle: null };
			nextKeyPatch = { leftHandle: null };
		} else if (easing === "linear") {
			keyPatch = { segmentToNext: "linear", rightHandle: null };
			nextKeyPatch = { leftHandle: null };
		} else {
			const handles = getCurveHandlesForNormalizedCubicBezier({
				leftKey: pair.key,
				rightKey: pair.next,
				cubicBezier: presetCurve({ easing }),
				referenceSpanValue: FLAT_SEGMENT_REFERENCE_SPAN,
			});
			if (!handles) continue; // zero-length segment: nothing to ease
			keyPatch = { segmentToNext: "bezier", rightHandle: handles.rightHandle, tangentMode: "broken" };
			nextKeyPatch = { leftHandle: handles.leftHandle, tangentMode: "broken" };
		}
		next = updateScalarKeyframeCurve({
			animations: next,
			propertyPath,
			componentKey: "value",
			keyframeId: pair.key.id,
			patch: keyPatch,
		});
		if (nextKeyPatch) {
			next = updateScalarKeyframeCurve({
				animations: next,
				propertyPath,
				componentKey: "value",
				keyframeId: pair.next.id,
				patch: nextKeyPatch,
			});
		}
	}
	return next;
}

/** The keyframe whose outgoing segment the playhead is inside of (or sitting
 *  on): the last keyframe at or before the playhead that has a successor.
 *  This is what the Graph sheet edits — CapCut's "tap the keyframe timeline
 *  after setting multiple keyframes and tap Easing". */
export function segmentKeyframeTimeAt({
	times,
	time,
	toleranceTicks,
}: {
	times: readonly MediaTime[];
	time: MediaTime;
	toleranceTicks: number;
}): MediaTime | null {
	let found: MediaTime | null = null;
	for (let i = 0; i < times.length - 1; i++) {
		if (times[i] <= time + toleranceTicks) found = times[i];
	}
	return found;
}
