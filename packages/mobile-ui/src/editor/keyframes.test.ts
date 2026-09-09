import { describe, expect, test } from "bun:test";
import type { TimelineElement } from "@kneecap/editor-core/timeline";
import { TICKS_PER_SECOND, mediaTime } from "@kneecap/editor-core/wasm";
import { getElementKeyframes, resolveAnimationPathValueAtTime } from "@kneecap/editor-core/animation";
import {
	CLIP_KEYFRAME_PATHS,
	adjacentClipKeyframeTime,
	applyClipKeyframeEasing,
	buildClipKeyframeRemovals,
	buildClipKeyframeUpserts,
	clipLocalTime,
	findClipKeyframeAtTime,
	frameTicksFor,
	getClipKeyframeEasing,
	getClipKeyframeTimes,
	hasClipKeyframes,
	resolveClipValuesAtTime,
	segmentKeyframeTimeAt,
	snapLocalTimeToFrame,
	upsertClipAnimationValues,
} from "./keyframes";

/**
 * Round 47 — the CapCut-mobile clip-keyframe model. Every function here is
 * pure and runs on a structural text element; the engine's own keyframe
 * primitives (`upsertPathKeyframe`, `getElementKeyframes`, the resolver)
 * are the real ones, not mocks, so what these tests pin is the GROUP
 * semantics layered on top: one diamond = every path keyed at one time.
 */

const FPS_30 = { numerator: 30, denominator: 1 };
const FRAME = frameTicksFor({ fps: FPS_30 });
const T = (ticks: number) => mediaTime({ ticks });
const REF = { trackId: "track-text", elementId: "text-1" };

function textElement(overrides: Partial<TimelineElement> = {}): TimelineElement {
	// Structural fixture: the fields the keyframe model and the engine's
	// param registry read. Cast is the same pattern the captions tests use.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return {
		id: "text-1",
		type: "text",
		name: "Title",
		startTime: mediaTime({ ticks: 2 * TICKS_PER_SECOND }),
		duration: mediaTime({ ticks: 4 * TICKS_PER_SECOND }),
		trimStart: 0,
		trimEnd: 0,
		params: { "transform.positionX": 10, opacity: 0.5 },
		...overrides,
	} as unknown as TimelineElement;
}

/** Two complete group keyframes: t=0 (positionX 0) and t=2s (positionX 400). */
function twoKeyframeElement(): TimelineElement {
	const base = textElement();
	const first = upsertClipAnimationValues({
		element: base,
		localTime: mediaTime({ ticks: 0 }),
		values: { ...resolveClipValuesAtTime({ element: base, localTime: mediaTime({ ticks: 0 }) }), "transform.positionX": 0 },
	});
	const withFirst = textElement({ animations: first });
	const second = upsertClipAnimationValues({
		element: withFirst,
		localTime: mediaTime({ ticks: 2 * TICKS_PER_SECOND }),
		values: {
			...resolveClipValuesAtTime({ element: withFirst, localTime: mediaTime({ ticks: 2 * TICKS_PER_SECOND }) }),
			"transform.positionX": 400,
		},
	});
	return textElement({ animations: second });
}

describe("frame grid", () => {
	test("frameTicksFor is the engine tick rate over the fps", () => {
		expect(FRAME).toBe(TICKS_PER_SECOND / 30);
		expect(frameTicksFor({ fps: { numerator: 30000, denominator: 1001 } })).toBe(
			Math.round((TICKS_PER_SECOND * 1001) / 30000),
		);
	});

	test("clipLocalTime is playhead minus start, clamped to the clip", () => {
		const element = textElement();
		expect(clipLocalTime({ element, timelineTime: mediaTime({ ticks: 0 }) })).toBe(T(0));
		expect(clipLocalTime({ element, timelineTime: mediaTime({ ticks: 3 * TICKS_PER_SECOND }) })).toBe(T(TICKS_PER_SECOND));
		expect(clipLocalTime({ element, timelineTime: mediaTime({ ticks: 99 * TICKS_PER_SECOND }) })).toBe(T(4 * TICKS_PER_SECOND));
	});

	test("snapLocalTimeToFrame rounds onto the grid and stays inside the clip", () => {
		const duration = mediaTime({ ticks: 4 * TICKS_PER_SECOND });
		expect(snapLocalTimeToFrame({ localTime: mediaTime({ ticks: FRAME + 100 }), fps: FPS_30, duration })).toBe(T(FRAME));
		expect(snapLocalTimeToFrame({ localTime: mediaTime({ ticks: 2 * FRAME - 100 }), fps: FPS_30, duration })).toBe(T(2 * FRAME));
		expect(snapLocalTimeToFrame({ localTime: mediaTime({ ticks: 10 * TICKS_PER_SECOND }), fps: FPS_30, duration })).toBe(duration);
	});
});

describe("keyframe times", () => {
	test("no animations -> no keyframes", () => {
		expect(getClipKeyframeTimes({ animations: undefined })).toEqual([]);
		expect(hasClipKeyframes({ animations: undefined })).toBe(false);
	});

	test("times are the union across group paths, unique and ascending", () => {
		const element = twoKeyframeElement();
		expect(getClipKeyframeTimes({ animations: element.animations })).toEqual([T(0), T(2 * TICKS_PER_SECOND)]);
		// Every path got a key at both times (one diamond = whole group).
		const perPath = new Map<string, number[]>();
		for (const kf of getElementKeyframes({ animations: element.animations })) {
			perPath.set(kf.propertyPath, [...(perPath.get(kf.propertyPath) ?? []), kf.time]);
		}
		for (const path of CLIP_KEYFRAME_PATHS) {
			expect(perPath.get(path)?.sort((a, b) => a - b)).toEqual([T(0), T(2 * TICKS_PER_SECOND)]);
		}
	});

	test("findClipKeyframeAtTime: exact hit, tolerance hit, nearest wins, miss", () => {
		const times = [0, 8000, 8600, 30000].map((ticks) => mediaTime({ ticks }));
		const tol = FRAME / 2;
		expect(findClipKeyframeAtTime({ times, time: mediaTime({ ticks: 8000 }), toleranceTicks: tol })).toBe(T(8000));
		expect(findClipKeyframeAtTime({ times, time: mediaTime({ ticks: 30000 - tol }), toleranceTicks: tol })).toBe(T(30000));
		expect(findClipKeyframeAtTime({ times, time: mediaTime({ ticks: 8400 }), toleranceTicks: tol })).toBe(T(8600));
		expect(findClipKeyframeAtTime({ times, time: mediaTime({ ticks: 20000 }), toleranceTicks: tol })).toBeNull();
	});

	test("adjacentClipKeyframeTime skips the keyframe the playhead sits on", () => {
		const times = [0, 8000, 16000].map((ticks) => mediaTime({ ticks }));
		const tol = FRAME / 2;
		expect(adjacentClipKeyframeTime({ times, time: mediaTime({ ticks: 8000 }), direction: "next", toleranceTicks: tol })).toBe(T(16000));
		expect(adjacentClipKeyframeTime({ times, time: mediaTime({ ticks: 8000 }), direction: "previous", toleranceTicks: tol })).toBe(T(0));
		expect(adjacentClipKeyframeTime({ times, time: mediaTime({ ticks: 8100 }), direction: "next", toleranceTicks: tol })).toBe(T(16000));
		expect(adjacentClipKeyframeTime({ times, time: mediaTime({ ticks: 16000 }), direction: "next", toleranceTicks: tol })).toBeNull();
		expect(adjacentClipKeyframeTime({ times, time: mediaTime({ ticks: 0 }), direction: "previous", toleranceTicks: tol })).toBeNull();
		expect(adjacentClipKeyframeTime({ times, time: mediaTime({ ticks: 4000 }), direction: "previous", toleranceTicks: tol })).toBe(T(0));
	});

	test("segmentKeyframeTimeAt picks the keyframe whose segment contains the playhead", () => {
		const times = [0, 8000, 16000].map((ticks) => mediaTime({ ticks }));
		const tol = FRAME / 2;
		expect(segmentKeyframeTimeAt({ times, time: mediaTime({ ticks: 4000 }), toleranceTicks: tol })).toBe(T(0));
		expect(segmentKeyframeTimeAt({ times, time: mediaTime({ ticks: 8000 }), toleranceTicks: tol })).toBe(T(8000));
		expect(segmentKeyframeTimeAt({ times, time: mediaTime({ ticks: 12000 }), toleranceTicks: tol })).toBe(T(8000));
		// Sitting on the LAST keyframe: no outgoing segment exists.
		expect(segmentKeyframeTimeAt({ times, time: mediaTime({ ticks: 16000 }), toleranceTicks: tol })).toBe(T(8000));
		expect(segmentKeyframeTimeAt({ times: [times[0]], time: mediaTime({ ticks: 0 }), toleranceTicks: tol })).toBeNull();
	});
});

describe("values", () => {
	test("resolveClipValuesAtTime reads static params and engine defaults when nothing is keyed", () => {
		const values = resolveClipValuesAtTime({ element: textElement(), localTime: mediaTime({ ticks: 1000 }) });
		expect(values).toEqual({
			"transform.positionX": 10,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 0.5,
		});
	});

	test("resolveClipValuesAtTime interpolates keyed paths and keeps the rest", () => {
		const element = twoKeyframeElement();
		const mid = resolveClipValuesAtTime({ element, localTime: mediaTime({ ticks: TICKS_PER_SECOND }) });
		expect(mid["transform.positionX"]).toBeCloseTo(200, 6);
		expect(mid.opacity).toBeCloseTo(0.5, 6);
		expect(mid["transform.scaleX"]).toBe(1);
	});

	test("buildClipKeyframeUpserts records the whole group with overrides applied", () => {
		const element = textElement();
		const upserts = buildClipKeyframeUpserts({
			ref: REF,
			element,
			localTime: mediaTime({ ticks: 3 * FRAME }),
			overrides: { opacity: 0.2 },
		});
		expect(upserts).toHaveLength(CLIP_KEYFRAME_PATHS.length);
		expect(new Set(upserts.map((u) => u.propertyPath))).toEqual(new Set(CLIP_KEYFRAME_PATHS));
		for (const u of upserts) {
			expect(u.trackId).toBe(REF.trackId);
			expect(u.elementId).toBe(REF.elementId);
			expect(u.time).toBe(T(3 * FRAME));
		}
		expect(upserts.find((u) => u.propertyPath === "opacity")?.value).toBe(0.2);
		expect(upserts.find((u) => u.propertyPath === "transform.positionX")?.value).toBe(10);
	});

	test("upsertClipAnimationValues + buildClipKeyframeRemovals round-trip one diamond", () => {
		const base = textElement();
		const t = mediaTime({ ticks: 5 * FRAME });
		const animations = upsertClipAnimationValues({
			element: base,
			localTime: t,
			values: { ...resolveClipValuesAtTime({ element: base, localTime: t }), "transform.scaleX": 1.5 },
		});
		const keyed = textElement({ animations });
		expect(getClipKeyframeTimes({ animations })).toEqual([t]);
		expect(
			resolveAnimationPathValueAtTime({ animations, propertyPath: "transform.scaleX", localTime: t, fallbackValue: 1 }),
		).toBe(1.5);
		const removals = buildClipKeyframeRemovals({ ref: REF, element: keyed, time: t });
		expect(removals).toHaveLength(CLIP_KEYFRAME_PATHS.length);
		expect(removals.every((r) => typeof r.keyframeId === "string" && r.keyframeId.length > 0)).toBe(true);
		// A time with no keyframe removes nothing.
		expect(buildClipKeyframeRemovals({ ref: REF, element: keyed, time: mediaTime({ ticks: 0 }) })).toEqual([]);
	});

	test("re-keying the same time replaces values instead of stacking keys", () => {
		const base = textElement();
		const t = mediaTime({ ticks: 2 * FRAME });
		const first = upsertClipAnimationValues({
			element: base,
			localTime: t,
			values: { ...resolveClipValuesAtTime({ element: base, localTime: t }), opacity: 0.9 },
		});
		const again = upsertClipAnimationValues({
			element: textElement({ animations: first }),
			localTime: t,
			values: { ...resolveClipValuesAtTime({ element: base, localTime: t }), opacity: 0.1 },
		});
		expect(getClipKeyframeTimes({ animations: again })).toEqual([t]);
		expect(resolveAnimationPathValueAtTime({ animations: again, propertyPath: "opacity", localTime: t, fallbackValue: 1 })).toBe(0.1);
		expect(getElementKeyframes({ animations: again }).filter((k) => k.propertyPath === "opacity")).toHaveLength(1);
	});
});

describe("easing", () => {
	const span = 2 * TICKS_PER_SECOND;
	const at = ({ animations, fraction }: { animations: TimelineElement["animations"]; fraction: number }) =>
		resolveAnimationPathValueAtTime({
			animations,
			propertyPath: "transform.positionX",
			localTime: Math.round(span * fraction),
			fallbackValue: 0,
		});

	test("fresh keyframes are linear; nothing to read off a time with no keyframe", () => {
		const element = twoKeyframeElement();
		expect(getClipKeyframeEasing({ animations: element.animations, time: mediaTime({ ticks: 0 }) })).toBe("linear");
		expect(getClipKeyframeEasing({ animations: element.animations, time: mediaTime({ ticks: 123 }) })).toBeNull();
		// The last keyframe has no outgoing segment.
		expect(getClipKeyframeEasing({ animations: element.animations, time: mediaTime({ ticks: span }) })).toBeNull();
		expect(at({ animations: element.animations, fraction: 0.25 })).toBeCloseTo(100, 6);
	});

	test("ease-in-out is symmetric, slow at the ends, and reads back as itself", () => {
		const element = twoKeyframeElement();
		const eased = applyClipKeyframeEasing({ animations: element.animations, time: mediaTime({ ticks: 0 }), easing: "ease-in-out" });
		expect(eased).not.toBe(element.animations);
		expect(getClipKeyframeEasing({ animations: eased, time: mediaTime({ ticks: 0 }) })).toBe("ease-in-out");
		expect(at({ animations: eased, fraction: 0 })).toBeCloseTo(0, 6);
		expect(at({ animations: eased, fraction: 1 })).toBeCloseTo(400, 6);
		expect(at({ animations: eased, fraction: 0.5 })).toBeCloseTo(200, 1);
		expect(at({ animations: eased, fraction: 0.25 })).toBeLessThan(100 - 5);
		expect(at({ animations: eased, fraction: 0.75 })).toBeGreaterThan(300 + 5);
		// Keyframe times are untouched by an easing change.
		expect(getClipKeyframeTimes({ animations: eased })).toEqual([T(0), T(span)]);
	});

	test("ease-in starts slow, ease-out starts fast", () => {
		const element = twoKeyframeElement();
		const easeIn = applyClipKeyframeEasing({ animations: element.animations, time: mediaTime({ ticks: 0 }), easing: "ease-in" });
		const easeOut = applyClipKeyframeEasing({ animations: element.animations, time: mediaTime({ ticks: 0 }), easing: "ease-out" });
		expect(at({ animations: easeIn, fraction: 0.25 })).toBeLessThan(100);
		expect(at({ animations: easeOut, fraction: 0.25 })).toBeGreaterThan(100);
		expect(getClipKeyframeEasing({ animations: easeIn, time: mediaTime({ ticks: 0 }) })).toBe("ease-in");
		expect(getClipKeyframeEasing({ animations: easeOut, time: mediaTime({ ticks: 0 }) })).toBe("ease-out");
	});

	test("hold freezes the value until the next keyframe; linear restores the ramp", () => {
		const element = twoKeyframeElement();
		const held = applyClipKeyframeEasing({ animations: element.animations, time: mediaTime({ ticks: 0 }), easing: "hold" });
		expect(getClipKeyframeEasing({ animations: held, time: mediaTime({ ticks: 0 }) })).toBe("hold");
		expect(at({ animations: held, fraction: 0.5 })).toBe(T(0));
		expect(at({ animations: held, fraction: 0.999 })).toBe(T(0));
		expect(at({ animations: held, fraction: 1 })).toBe(400);
		const linear = applyClipKeyframeEasing({ animations: held, time: mediaTime({ ticks: 0 }), easing: "linear" });
		expect(getClipKeyframeEasing({ animations: linear, time: mediaTime({ ticks: 0 }) })).toBe("linear");
		expect(at({ animations: linear, fraction: 0.5 })).toBeCloseTo(200, 6);
	});

	test("flat paths (opacity unchanged between the keyframes) stay flat under a bezier preset", () => {
		const element = twoKeyframeElement();
		const eased = applyClipKeyframeEasing({ animations: element.animations, time: mediaTime({ ticks: 0 }), easing: "ease-in-out" });
		for (const fraction of [0.1, 0.5, 0.9]) {
			expect(
				resolveAnimationPathValueAtTime({
					animations: eased,
					propertyPath: "opacity",
					localTime: Math.round(span * fraction),
					fallbackValue: 1,
				}),
			).toBeCloseTo(0.5, 9);
		}
	});

	test("applying easing where there is no keyframe is a no-op (same reference)", () => {
		const element = twoKeyframeElement();
		const same = applyClipKeyframeEasing({ animations: element.animations, time: mediaTime({ ticks: 777 }), easing: "ease-in" });
		expect(same).toBe(element.animations);
	});
});
