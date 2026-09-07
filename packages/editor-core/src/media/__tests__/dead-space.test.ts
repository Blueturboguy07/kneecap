import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DEAD_SPACE_OPTIONS,
	FrameFeatureExtractor,
	cuttableGapSec,
	detectDeadSpace,
	downmixToMono,
	type DeadSpaceOptions,
	type FrameFeatures,
} from "@/media/dead-space";

const RATE = 48000;

/** Deterministic LCG — `Math.random()` in a threshold test is a flaky test. */
function makeNoise({ seed }: { seed: number }): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return (state / 0x100000000) * 2 - 1;
	};
}

interface Section {
	seconds: number;
	/** Linear amplitude, 1 = full scale. */
	amplitude: number;
	/**
	 * `"voice"` is a 130 Hz harmonic stack: periodic like a vowel, with real
	 * energy across the 300-3400 Hz speech band. `"tone"` is a bare 220 Hz
	 * sine and `"noise"` is aperiodic — the point of having all three is that
	 * the detector must treat them differently, which an energy gate cannot.
	 */
	kind: "tone" | "noise" | "voice" | "rumble";
}

/** Builds a mono test signal with a constant low-level room-tone bed. */
function synthesize({
	sections,
	roomToneAmplitude = 0.002,
	roomToneKind = "noise",
	dcOffset = 0,
	seed = 7,
}: {
	sections: Section[];
	roomToneAmplitude?: number;
	/**
	 * White noise by default. `"rumble"` gives a low-frequency bed instead,
	 * which is what a real room actually sounds like — HVAC, traffic and
	 * building noise are bottom-heavy, so their zero-crossing rate is LOW.
	 * White-noise room tone has the same ZCR as a fricative, which makes the
	 * fricative discriminator meaningless against it.
	 */
	roomToneKind?: "noise" | "rumble";
	dcOffset?: number;
	seed?: number;
}): Float32Array {
	const totalSamples = Math.round(
		sections.reduce((sum, s) => sum + s.seconds, 0) * RATE,
	);
	const out = new Float32Array(totalSamples);
	const noise = makeNoise({ seed });
	// One-pole lowpass states for the rumble generators (~80 Hz corner).
	let bedState = 0;
	let rumbleState = 0;
	let cursor = 0;
	for (const section of sections) {
		const length = Math.round(section.seconds * RATE);
		for (let i = 0; i < length && cursor < totalSamples; i++, cursor++) {
			if (roomToneKind === "rumble") bedState += (noise() - bedState) * 0.01;
			const bed =
				roomToneKind === "rumble"
					? bedState * roomToneAmplitude * 6
					: noise() * roomToneAmplitude;
			let body = 0;
			if (section.amplitude !== 0) {
				if (section.kind === "tone") {
					body = Math.sin((2 * Math.PI * 220 * i) / RATE) * section.amplitude;
				} else if (section.kind === "noise") {
					body = noise() * section.amplitude;
				} else if (section.kind === "rumble") {
					// HVAC, traffic, building noise, a hand on the phone: low
					// frequency and APERIODIC. Deliberately not a sine — a hum
					// is periodic, and periodic is the one thing voicing is
					// built to accept. This models the common case honestly
					// rather than the adversarial one dishonestly.
					rumbleState += (noise() - rumbleState) * 0.01;
					body = rumbleState * section.amplitude * 6;
				} else {
					let harmonics = 0;
					for (let h = 1; h <= 12; h++) {
						harmonics += Math.sin((2 * Math.PI * 130 * h * i) / RATE) / h;
					}
					body = harmonics * section.amplitude * 0.4;
				}
			}
			out[cursor] = bed + body + dcOffset;
		}
	}
	return out;
}

function features({
	samples,
	chunkSamples = 4096,
}: {
	samples: Float32Array;
	chunkSamples?: number;
}): FrameFeatures {
	const extractor = new FrameFeatureExtractor({ sampleRate: RATE });
	for (let offset = 0; offset < samples.length; offset += chunkSamples) {
		extractor.push({
			samples: samples.subarray(
				offset,
				Math.min(samples.length, offset + chunkSamples),
			),
		});
	}
	return extractor.finish();
}

function options(overrides: Partial<DeadSpaceOptions> = {}): DeadSpaceOptions {
	return { ...DEFAULT_DEAD_SPACE_OPTIONS, ...overrides };
}

describe("frame feature extraction", () => {
	test("frames the signal at a 10 ms hop regardless of chunk sizes", () => {
		const samples = synthesize({
			sections: [{ seconds: 2, amplitude: 0.3, kind: "tone" }],
		});
		const wholeFile = features({ samples, chunkSamples: samples.length });
		const dribbled = features({ samples, chunkSamples: 997 });

		expect(wholeFile.hopSec).toBeCloseTo(0.01, 6);
		expect(wholeFile.frameSec).toBeCloseTo(0.02, 6);
		expect(wholeFile.sampleCount).toBe(samples.length);
		// ~2 s at a 10 ms hop, minus the frame that can't be filled at the end.
		expect(wholeFile.rmsDb.length).toBeGreaterThan(195);
		expect(dribbled.rmsDb.length).toBe(wholeFile.rmsDb.length);
		for (let i = 0; i < wholeFile.rmsDb.length; i++) {
			expect(dribbled.rmsDb[i]).toBeCloseTo(wholeFile.rmsDb[i], 4);
		}
	});

	test("reads a loud tone far above a quiet bed", () => {
		const loud = features({
			samples: synthesize({
				sections: [{ seconds: 0.5, amplitude: 0.5, kind: "tone" }],
				roomToneAmplitude: 0,
			}),
		});
		const quiet = features({
			samples: synthesize({
				sections: [{ seconds: 0.5, amplitude: 0, kind: "tone" }],
				roomToneAmplitude: 0.002,
			}),
		});
		expect(loud.rmsDb[20]).toBeGreaterThan(-15);
		expect(quiet.rmsDb[20]).toBeLessThan(-45);
	});

	test("noise reads a far higher zero-crossing rate than a low tone", () => {
		const noisy = features({
			samples: synthesize({
				sections: [{ seconds: 0.5, amplitude: 0.2, kind: "noise" }],
				roomToneAmplitude: 0,
			}),
		});
		const tonal = features({
			samples: synthesize({
				sections: [{ seconds: 0.5, amplitude: 0.2, kind: "tone" }],
				roomToneAmplitude: 0,
			}),
		});
		expect(noisy.zcr[20]).toBeGreaterThan(tonal.zcr[20] * 5);
	});

	test("a DC offset does not raise the measured floor or flatten the ZCR", () => {
		const clean = features({
			samples: synthesize({
				sections: [{ seconds: 1, amplitude: 0, kind: "tone" }],
				roomToneAmplitude: 0.002,
			}),
		});
		const biased = features({
			samples: synthesize({
				sections: [{ seconds: 1, amplitude: 0, kind: "tone" }],
				roomToneAmplitude: 0.002,
				dcOffset: 0.05,
			}),
		});
		// Without the DC blocker this frame would read ~-26 dB (the offset),
		// not the ~-54 dB of the actual room tone.
		expect(biased.rmsDb[50]).toBeLessThan(clean.rmsDb[50] + 6);
		expect(biased.zcr[50]).toBeGreaterThan(0.05);
	});

	test("downmix averages channels", () => {
		const left = Float32Array.from([1, 0, -1]);
		const right = Float32Array.from([0, 0, 1]);
		expect(Array.from(downmixToMono({ channels: [left, right], length: 3 }))).toEqual([
			0.5, 0, 0,
		]);
	});
});

describe("dead-space detection", () => {
	test("finds the two spoken regions and drops the dead air around them", () => {
		//  0.0-1.0 silence | 1.0-3.0 speech | 3.0-4.5 silence | 4.5-5.5 speech | 5.5-6.0 silence
		const analysis = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [
						{ seconds: 1.0, amplitude: 0, kind: "tone" },
						{ seconds: 2.0, amplitude: 0.25, kind: "noise" },
						{ seconds: 1.5, amplitude: 0, kind: "tone" },
						{ seconds: 1.0, amplitude: 0.25, kind: "noise" },
						{ seconds: 0.5, amplitude: 0, kind: "tone" },
					],
				}),
			}),
			options: options(),
		});

		expect(analysis.refusal).toBeNull();
		expect(analysis.segments.length).toBe(2);
		// Padding pulls each boundary outward by padIn/padOut; the gate itself
		// must land within a frame or two of the real transition. Read the pad
		// from the options rather than hardcoding it — this test is about the
		// boundaries tracking the padding, not about what the padding is set to.
		const { padInSec, padOutSec } = DEFAULT_DEAD_SPACE_OPTIONS;
		expect(analysis.segments[0].startSec).toBeCloseTo(1.0 - padInSec, 1);
		expect(analysis.segments[0].endSec).toBeCloseTo(3.0 + padOutSec, 1);
		expect(analysis.segments[1].startSec).toBeCloseTo(4.5 - padInSec, 1);
		expect(analysis.segments[1].endSec).toBeCloseTo(5.5 + padOutSec, 1);
		expect(analysis.removedSec).toBeGreaterThan(2.4);
		expect(analysis.noiseFloorDb).toBeLessThan(analysis.speechDb - 20);
	});

	test("leaves a short pause alone but cuts a long one", () => {
		const build = ({ pauseSec }: { pauseSec: number }) =>
			detectDeadSpace({
				features: features({
					samples: synthesize({
						sections: [
							{ seconds: 1.0, amplitude: 0.25, kind: "noise" },
							{ seconds: pauseSec, amplitude: 0, kind: "tone" },
							{ seconds: 1.0, amplitude: 0.25, kind: "noise" },
							{ seconds: 1.2, amplitude: 0, kind: "tone" },
							{ seconds: 1.0, amplitude: 0.25, kind: "noise" },
						],
					}),
				}),
				options: options(),
			});

		// 0.2 s is rhythm between words — a human would not cut it, and the
		// padding alone already covers most of it.
		const short = build({ pauseSec: 0.2 });
		expect(short.refusal).toBeNull();
		expect(short.segments.length).toBe(2);

		// 0.9 s is dead air.
		const long = build({ pauseSec: 0.9 });
		expect(long.refusal).toBeNull();
		expect(long.segments.length).toBe(3);
	});

	test("cuts a short-form pause that padding used to swallow whole", () => {
		// Regression, 2026-08-27. `minSilenceSec` is documented as a RAW
		// silence duration, but the merge rule and the "nothing to cut" guard
		// both compared already-PADDED spans against it. That stacked the
		// padding on top of the threshold, so the real floor was
		// minSilenceSec + padIn + padOut — measured at 0.70 s on this exact
		// signal. On short-form footage almost every pause is under that, so
		// "Cut gaps" answered "nothing to cut" for clips that were visibly
		// full of dead air.
		//
		// 0.35 s is the case that broke: comfortably above the ~200 ms
		// threshold at which a listener hears a pause at all, and squarely in
		// the range short-form editing wants gone.
		const analysis = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [
						{ seconds: 1.2, amplitude: 0.25, kind: "noise" },
						{ seconds: 0.35, amplitude: 0, kind: "tone" },
						{ seconds: 1.2, amplitude: 0.25, kind: "noise" },
					],
				}),
			}),
			options: options(),
		});

		expect(analysis.refusal).toBeNull();
		expect(analysis.segments.length).toBe(2);
		expect(analysis.removedSec).toBeGreaterThan(0.1);
	});

	test("the merge rule and the nothing-to-cut guard share one floor", () => {
		// These two used to disagree: the merge rule would approve a gap that
		// the guard then rejected as "not an edit", because one reasoned in
		// raw seconds and the other in padded seconds. Whichever floor was
		// higher silently won, which is how a fix to one of them produced no
		// visible change. Anything at or above the shared floor must survive
		// BOTH — no refusal, and a real second piece.
		const floor = cuttableGapSec(DEFAULT_DEAD_SPACE_OPTIONS);
		expect(floor).toBeGreaterThan(0);
		expect(floor).toBeLessThan(DEFAULT_DEAD_SPACE_OPTIONS.minSilenceSec);

		const pauseSec =
			DEFAULT_DEAD_SPACE_OPTIONS.minSilenceSec +
			DEFAULT_DEAD_SPACE_OPTIONS.padInSec +
			DEFAULT_DEAD_SPACE_OPTIONS.padOutSec;
		const analysis = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [
						{ seconds: 1.2, amplitude: 0.25, kind: "noise" },
						{ seconds: pauseSec, amplitude: 0, kind: "tone" },
						{ seconds: 1.2, amplitude: 0.25, kind: "noise" },
					],
				}),
			}),
			options: options(),
		});

		expect(analysis.refusal).toBeNull();
		expect(analysis.segments.length).toBe(2);
		expect(analysis.removedSec).toBeGreaterThanOrEqual(floor);
	});

	test("cuts a pause that is full of NON-SPEECH sound", () => {
		// The defect the founder reported, 2026-08-27: "it needs to work for
		// speech specifically, i think its counting any gap in noise."
		//
		// Gating on energy makes any sound "significant audio", so a pause
		// with traffic, a fan, handling noise or someone off-mic in it never
		// reads as a gap. The clip has real quiet room tone at head and tail,
		// so the measured floor is honest room tone and the noise sitting in
		// the middle pause is well ABOVE the gate — an energy-only detector
		// returns ONE piece here and calls the clip already tight.
		const build = ({ gap }: { gap: Section }) =>
			detectDeadSpace({
				features: features({
					samples: synthesize({
						sections: [
							{ seconds: 1.0, amplitude: 0, kind: "tone" },
							{ seconds: 1.5, amplitude: 0.5, kind: "voice" },
							gap,
							{ seconds: 1.5, amplitude: 0.5, kind: "voice" },
							{ seconds: 1.0, amplitude: 0, kind: "tone" },
						],
						roomToneAmplitude: 0.0005,
						roomToneKind: "rumble",
					}),
				}),
				options: options(),
			});

		const noisyGap = build({
			gap: { seconds: 1.0, amplitude: 0.05, kind: "noise" },
		});
		expect(noisyGap.refusal).toBeNull();
		expect(noisyGap.segments.length).toBe(2);

		// And it must land in essentially the same place as the same pause with
		// nothing in it: whether the dead air is silent or noisy is not the
		// question the button asks. Nobody is talking either way.
		const quietGap = build({
			gap: { seconds: 1.0, amplitude: 0, kind: "tone" },
		});
		expect(quietGap.segments.length).toBe(2);
		expect(quietGap.removedSec).toBeGreaterThan(noisyGap.removedSec);
		// The noisy pause keeps a little more, and the amount is not arbitrary:
		// noise is broadband, so the fricative rule extends both boundaries
		// into it, and it is capped at `zcrRescueMaxSec` per boundary. Two
		// boundaries is the whole budget. Anything beyond that would mean the
		// gate itself was holding open on the noise again.
		const rescueBudget = 2 * DEFAULT_DEAD_SPACE_OPTIONS.zcrRescueMaxSec;
		expect(quietGap.removedSec - noisyGap.removedSec).toBeLessThanOrEqual(
			rescueBudget + 1e-6,
		);
	});

	test("low-frequency rumble in a pause is not speech", () => {
		// Hum, HVAC and traffic live under the speech band. Loud rumble in a
		// pause is louder than quiet speech, so an unfiltered level
		// comparison ranks it as the more important of the two.
		const analysis = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [
						{ seconds: 1.0, amplitude: 0, kind: "tone" },
						{ seconds: 1.5, amplitude: 0.4, kind: "voice" },
						{ seconds: 1.0, amplitude: 0.2, kind: "rumble" },
						{ seconds: 1.5, amplitude: 0.4, kind: "voice" },
						{ seconds: 1.0, amplitude: 0, kind: "tone" },
					],
					roomToneAmplitude: 0.0005,
					roomToneKind: "rumble",
				}),
			}),
			options: options(),
		});
		expect(analysis.refusal).toBeNull();
		expect(analysis.segments.length).toBe(2);
	});

	test("falls back to energy when nothing in the clip is voiced", () => {
		// The escape hatch. Whispered speech, heavy processing or a sung take
		// can score voiced almost nowhere; without a fallback every frame
		// reads as non-speech and the button proposes deleting the clip.
		// Degrading to the older, dumber gate is a far better failure.
		const analysis = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [
						{ seconds: 1.0, amplitude: 0, kind: "tone" },
						{ seconds: 1.5, amplitude: 0.4, kind: "noise" },
						{ seconds: 1.0, amplitude: 0, kind: "tone" },
						{ seconds: 1.5, amplitude: 0.4, kind: "noise" },
						{ seconds: 1.0, amplitude: 0, kind: "tone" },
					],
					roomToneAmplitude: 0.0005,
					roomToneKind: "rumble",
				}),
			}),
			options: options(),
		});
		expect(analysis.refusal).toBeNull();
		// Two pieces, not zero: the clip survives.
		expect(analysis.segments.length).toBe(2);
		expect(analysis.keptSec).toBeGreaterThan(2.5);
	});

	test("voicing separates a vowel from noise at the same level", () => {
		// The measurement underneath all of the above, on its own: periodic
		// and aperiodic material of equal loudness must not look alike.
		const voiced = features({
			samples: synthesize({
				sections: [{ seconds: 1.0, amplitude: 0.3, kind: "voice" }],
				roomToneAmplitude: 0,
			}),
		});
		const aperiodic = features({
			samples: synthesize({
				sections: [{ seconds: 1.0, amplitude: 0.3, kind: "noise" }],
				roomToneAmplitude: 0,
			}),
		});
		expect(voiced.voicing[50]).toBeGreaterThan(0.7);
		expect(aperiodic.voicing[50]).toBeLessThan(0.45);
		// Equally loud in the speech band — level alone cannot tell them apart.
		expect(Math.abs(voiced.bandRmsDb[50] - aperiodic.bandRmsDb[50])).toBeLessThan(12);
	});

	test("keeps a quiet high-ZCR tail that a bare energy gate would clip", () => {
		// A vowel, then a fricative 26 dB down — the /s/ at the end of a word.
		//
		// The bed is RUMBLE, not white noise. A fricative is recognised by
		// having far more high-frequency energy than the room does, so a
		// white-noise bed — which has a fricative's own zero-crossing rate —
		// makes the test unfalsifiable: nothing can be distinguished from it.
		// Real rooms are bottom-heavy, and against a real room the /s/ stands
		// out exactly as this expects.
		const withTail = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [
						{ seconds: 1.0, amplitude: 0, kind: "tone" },
						{ seconds: 1.0, amplitude: 0.4, kind: "tone" },
						{ seconds: 0.1, amplitude: 0.02, kind: "noise" },
						{ seconds: 1.5, amplitude: 0, kind: "tone" },
					],
					roomToneAmplitude: 0.0005,
					roomToneKind: "rumble",
				}),
			}),
			options: options({ padOutSec: 0, hangoverSec: 0 }),
		});
		expect(withTail.refusal).toBeNull();
		// The gate stops at 2.0 s — the vowel ends and the fricative is not
		// voiced. Carrying the boundary into the tail is the fricative rule's
		// job, and with hangover and padding both disabled it is the only
		// thing that can do it here.
		expect(withTail.segments[0].endSec).toBeGreaterThan(2.02);
	});

	test("refuses digital silence rather than deleting the clip", () => {
		const analysis = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [{ seconds: 3, amplitude: 0, kind: "tone" }],
					roomToneAmplitude: 0,
				}),
			}),
			options: options(),
		});
		expect(analysis.refusal).toBe("no-audio");
		expect(analysis.segments).toEqual([]);
	});

	test("refuses a clip with no quiet parts to find", () => {
		const analysis = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [{ seconds: 3, amplitude: 0.3, kind: "noise" }],
					roomToneAmplitude: 0,
				}),
			}),
			options: options(),
		});
		expect(analysis.refusal).toBe("no-dynamic-range");
	});

	test("refuses when the only silence is shorter than a cuttable gap", () => {
		const analysis = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [
						{ seconds: 1.5, amplitude: 0.25, kind: "noise" },
						{ seconds: 0.15, amplitude: 0, kind: "tone" },
						{ seconds: 1.5, amplitude: 0.25, kind: "noise" },
					],
				}),
			}),
			options: options(),
		});
		expect(analysis.refusal).toBe("nothing-to-cut");
	});

	test("measures only the trimmed window it was handed", () => {
		const samples = synthesize({
			sections: [
				{ seconds: 2.0, amplitude: 0.25, kind: "noise" },
				{ seconds: 1.5, amplitude: 0, kind: "tone" },
				{ seconds: 2.0, amplitude: 0.25, kind: "noise" },
			],
		});
		const analysis = detectDeadSpace({
			features: features({ samples }),
			// Only the back half of the clip is visible.
			window: { startSec: 3.0, endSec: 5.5 },
			options: options(),
		});
		expect(analysis.refusal).toBeNull();
		expect(analysis.windowSec).toBeCloseTo(2.5, 6);
		for (const segment of analysis.segments) {
			expect(segment.startSec).toBeGreaterThanOrEqual(3.0);
			expect(segment.endSec).toBeLessThanOrEqual(5.5);
		}
		expect(analysis.segments[0].startSec).toBeCloseTo(3.5 - 0.08, 1);
	});

	test("adapts its threshold to a quiet recording", () => {
		// Everything 30 dB down from the previous cases: a fixed -40 dBFS gate
		// would find no sound at all here.
		const analysis = detectDeadSpace({
			features: features({
				samples: synthesize({
					sections: [
						{ seconds: 1.0, amplitude: 0, kind: "tone" },
						{ seconds: 1.5, amplitude: 0.008, kind: "noise" },
						{ seconds: 1.5, amplitude: 0, kind: "tone" },
					],
					roomToneAmplitude: 0.00005,
				}),
			}),
			options: options(),
		});
		expect(analysis.refusal).toBeNull();
		expect(analysis.segments.length).toBe(1);
		expect(analysis.segments[0].startSec).toBeCloseTo(1.0 - 0.08, 1);
		expect(analysis.thresholdDb).toBeLessThan(-50);
	});

	test("keeps part of each gap in tighten mode", () => {
		const build = ({ keepGapSec }: { keepGapSec: number }) =>
			detectDeadSpace({
				features: features({
					samples: synthesize({
						sections: [
							{ seconds: 1.0, amplitude: 0.25, kind: "noise" },
							{ seconds: 2.0, amplitude: 0, kind: "tone" },
							{ seconds: 1.0, amplitude: 0.25, kind: "noise" },
						],
					}),
				}),
				options: options({ keepGapSec }),
			});
		const removed = build({ keepGapSec: 0 }).removedSec;
		const tightened = build({ keepGapSec: 0.5 }).removedSec;
		expect(removed - tightened).toBeCloseTo(0.5, 1);
	});
});
