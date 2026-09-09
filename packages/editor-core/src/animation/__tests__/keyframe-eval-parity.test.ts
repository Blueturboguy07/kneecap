import { describe, expect, test } from "bun:test";
import { getScalarChannelValueAtTime } from "../interpolation";
import fixture from "./fixtures/keyframe-eval-parity.json";
import { buildParityChannels, parityChannelToScalarChannel, paritySampleTicks } from "./keyframe-parity-cases";

/**
 * Round 47 — guards the cross-language keyframe-evaluation fixture the
 * Swift (`KeyframeEvaluator.swift`, run by verify-export-pipeline) and
 * Kotlin (`KeyframeEvaluatorTest.kt`) ports are measured against. If the
 * engine's interpolation changes, this fails until the fixture is
 * regenerated — and then the native tests fail until the ports follow.
 */
describe("keyframe evaluation parity fixture", () => {
	test("checked-in fixture matches the engine's channels and sample grid", () => {
		const channels = buildParityChannels();
		expect(fixture.channels).toEqual(channels);
		const expectedSamples = channels.flatMap((channel, channelIndex) =>
			paritySampleTicks({ channel }).map((timeTicks) => ({ channel: channelIndex, timeTicks })),
		);
		expect(fixture.samples.map(({ channel, timeTicks }) => ({ channel, timeTicks }))).toEqual(expectedSamples);
	});

	test("every expected value is what the engine computes today", () => {
		const scalarChannels = fixture.channels.map((channel) =>
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON import widens the string unions; the generator wrote EdlAnimationChannel values.
			parityChannelToScalarChannel({ channel: channel as ReturnType<typeof buildParityChannels>[number] }),
		);
		for (const sample of fixture.samples) {
			const actual = getScalarChannelValueAtTime({
				channel: scalarChannels[sample.channel],
				time: sample.timeTicks,
				fallbackValue: Number.NaN,
			});
			expect(Number.isFinite(actual)).toBe(true);
			expect(Math.abs(actual - sample.expected)).toBeLessThanOrEqual(fixture.tolerance);
		}
	});

	test("the fixture exercises the branches a port can get wrong", () => {
		const interpolations = new Set(fixture.channels.flatMap((c) => c.keyframes.map((k) => k.interpolation)));
		expect(interpolations).toEqual(new Set(["linear", "hold", "bezier"]));
		expect(fixture.channels.some((c) => c.extrapolationBefore === "linear" && c.extrapolationAfter === "linear")).toBe(true);
		expect(fixture.channels.some((c) => c.keyframes.some((k) => k.rightHandle && k.rightHandle.dv !== 0))).toBe(true);
		expect(fixture.channels.some((c) => c.keyframes.length === 1)).toBe(true);
		// Out-of-order input present.
		expect(
			fixture.channels.some((c) => c.keyframes.some((k, i, arr) => i > 0 && k.timeTicks < arr[i - 1].timeTicks)),
		).toBe(true);
	});
});
