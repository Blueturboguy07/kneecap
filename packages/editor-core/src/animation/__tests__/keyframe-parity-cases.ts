/**
 * The keyframe-evaluation parity cases (round 47), shared by the fixture
 * generator and the test that guards the generated file. Each case is an
 * `EdlAnimationChannel` exactly as `edl/build.ts` emits one — the shape the
 * Swift/Kotlin evaluators consume — chosen to hit every branch a port can
 * get wrong: out-of-order keys, hold vs linear vs bezier segments, default
 * AND explicit bezier handles (including value overshoot), handle clamping,
 * both extrapolation modes, single-key channels, and the exact-key-time
 * short-circuits.
 */
import type { EdlAnimationChannel, EdlKeyframe } from "@/edl/types";
import type { ScalarAnimationChannel, ScalarAnimationKey } from "@/animation/types";
import { mediaTime } from "@/wasm";

function key({
	id,
	time,
	value,
	interpolation = "linear",
	leftHandle = null,
	rightHandle = null,
}: {
	id: string;
	time: number;
	value: number;
	interpolation?: EdlKeyframe["interpolation"];
	leftHandle?: EdlKeyframe["leftHandle"];
	rightHandle?: EdlKeyframe["rightHandle"];
}): EdlKeyframe {
	return { keyframeId: id, timeTicks: time, value, interpolation, leftHandle, rightHandle };
}

function channel({
	propertyPath,
	keyframes,
	extrapolationBefore = "hold",
	extrapolationAfter = "hold",
}: {
	propertyPath: string;
	keyframes: EdlKeyframe[];
	extrapolationBefore?: EdlAnimationChannel["extrapolationBefore"];
	extrapolationAfter?: EdlAnimationChannel["extrapolationAfter"];
}): EdlAnimationChannel {
	return { propertyPath, componentKey: null, extrapolationBefore, extrapolationAfter, keyframes };
}

export function buildParityChannels(): EdlAnimationChannel[] {
	return [
		// 0: plain linear ramp, three keys, hold at both edges.
		channel({
			propertyPath: "transform.positionX",
			keyframes: [key({ id: "a", time: 0, value: 100 }), key({ id: "b", time: 4000, value: 200 }), key({ id: "c", time: 10000, value: -50 })],
		}),
		// 1: hold (step) segments — the value jumps at the NEXT key.
		channel({
			propertyPath: "opacity",
			keyframes: [
				key({ id: "a", time: 1000, value: 1, interpolation: "hold" }),
				key({ id: "b", time: 5000, value: 0.25, interpolation: "hold" }),
				key({ id: "c", time: 9000, value: 0.5 }),
			],
		}),
		// 2: bezier with DEFAULT handles (none supplied) — span/3 tangents.
		channel({
			propertyPath: "transform.scaleX",
			keyframes: [key({ id: "a", time: 0, value: 1, interpolation: "bezier" }), key({ id: "b", time: 6000, value: 2 })],
		}),
		// 3: bezier with explicit ease-in-out timing handles (CSS 0.42/0.58)
		//    and zero value handles — what the mobile Graph sheet writes.
		channel({
			propertyPath: "transform.positionY",
			keyframes: [
				key({ id: "a", time: 2000, value: 0, interpolation: "bezier", rightHandle: { dtTicks: 3360, dv: 0 } }),
				key({ id: "b", time: 10000, value: 400, leftHandle: { dtTicks: -3360, dv: 0 } }),
			],
		}),
		// 4: bezier with value OVERSHOOT handles (desktop graph editor shape).
		channel({
			propertyPath: "transform.rotate",
			keyframes: [
				key({ id: "a", time: 0, value: 0, interpolation: "bezier", rightHandle: { dtTicks: 1000, dv: 80 } }),
				key({ id: "b", time: 8000, value: 90, leftHandle: { dtTicks: -1000, dv: 80 } }),
			],
		}),
		// 5: linear extrapolation on both edges.
		channel({
			propertyPath: "transform.positionX",
			extrapolationBefore: "linear",
			extrapolationAfter: "linear",
			keyframes: [key({ id: "a", time: 4000, value: 10 }), key({ id: "b", time: 8000, value: 30 })],
		}),
		// 6: keys supplied OUT OF ORDER — the evaluator must sort by time.
		channel({
			propertyPath: "opacity",
			keyframes: [key({ id: "c", time: 9000, value: 0 }), key({ id: "a", time: 1000, value: 1 }), key({ id: "b", time: 5000, value: 0.5 })],
		}),
		// 7: handles that exceed their segment — clamped: right dt to the
		//    span, a positive left dt to 0 (the engine's normalizeScalarChannel).
		channel({
			propertyPath: "transform.scaleY",
			keyframes: [
				key({ id: "a", time: 0, value: 1, interpolation: "bezier", rightHandle: { dtTicks: 12000, dv: 0.5 } }),
				key({ id: "b", time: 4000, value: 3, leftHandle: { dtTicks: 500, dv: -0.5 } }),
			],
		}),
		// 8: single key — constant everywhere.
		channel({
			propertyPath: "transform.rotate",
			keyframes: [key({ id: "only", time: 3000, value: 45 })],
		}),
		// 9: mixed segments in one channel: bezier → hold → linear.
		channel({
			propertyPath: "transform.positionX",
			keyframes: [
				key({ id: "a", time: 0, value: 0, interpolation: "bezier" }),
				key({ id: "b", time: 3000, value: 300, interpolation: "hold" }),
				key({ id: "c", time: 6000, value: 100 }),
				key({ id: "d", time: 9000, value: 0 }),
			],
		}),
	];
}

/** EDL flattened channel -> the engine's scalar channel, the same mapping
 *  `edl/build.ts` performs in reverse (interpolation is the segment type of
 *  the key it sits on; handles keep their tick/value units). */
export function parityChannelToScalarChannel({ channel }: { channel: EdlAnimationChannel }): ScalarAnimationChannel {
	const keys: ScalarAnimationKey[] = channel.keyframes.map((k) => ({
		id: k.keyframeId,
		time: mediaTime({ ticks: k.timeTicks }),
		value: typeof k.value === "number" ? k.value : Number.NaN,
		segmentToNext: k.interpolation === "hold" ? "step" : k.interpolation === "bezier" ? "bezier" : "linear",
		tangentMode: "broken",
		leftHandle: k.leftHandle ? { dt: mediaTime({ ticks: k.leftHandle.dtTicks }), dv: k.leftHandle.dv } : undefined,
		rightHandle: k.rightHandle ? { dt: mediaTime({ ticks: k.rightHandle.dtTicks }), dv: k.rightHandle.dv } : undefined,
	}));
	return {
		keys,
		extrapolation: { before: channel.extrapolationBefore, after: channel.extrapolationAfter },
	};
}

/** Where to sample: before the first key, exactly on every key, quarter
 *  points of every segment, a few off-grid ticks, and past the last key. */
export function paritySampleTicks({ channel }: { channel: EdlAnimationChannel }): number[] {
	const times = [...new Set(channel.keyframes.map((k) => k.timeTicks))].sort((a, b) => a - b);
	const first = times[0];
	const last = times[times.length - 1];
	const out = new Set<number>([first - 3000, first - 1, ...times, last + 1, last + 5000]);
	for (let i = 0; i < times.length - 1; i++) {
		const span = times[i + 1] - times[i];
		for (const fraction of [0.1, 0.25, 0.5, 0.75, 0.9]) {
			out.add(times[i] + Math.round(span * fraction));
		}
		out.add(times[i] + 1);
		out.add(times[i + 1] - 1);
	}
	return [...out].sort((a, b) => a - b);
}
