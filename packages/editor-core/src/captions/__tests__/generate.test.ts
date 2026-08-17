import { describe, expect, test } from "bun:test";
import {
	buildCaptionElementsFromTranscript,
	type TranscriptSegmentInput,
} from "../generate";
import { TICKS_PER_SECOND, mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { DEFAULT_CAPTION_STYLE_PRESET_ID } from "../styles";

/** A pre-transcribed, already-smoothed fixture — the shape
 * `NativeBridge.transcribe()` produces after native-bridge's mandatory
 * smoothing pass. Two segments, word-level microsecond timestamps, no
 * overlap — deliberately simple/hand-authored (not the real jfk.wav DTW
 * capture that native-bridge's own tests use) since this module's job is
 * purely the microseconds->ticks conversion and per-segment element
 * shaping, not smoothing-quality verification (that is native-bridge's
 * `caption-smoothing.test.ts`, already covered by the previous session).
 */
const FIXTURE_SEGMENTS: TranscriptSegmentInput[] = [
	{
		startMicros: 1_000_000,
		endMicros: 3_500_000,
		text: "and so my fellow Americans",
		words: [
			{ text: "and", startMicros: 1_000_000, endMicros: 1_200_000 },
			{ text: "so", startMicros: 1_200_000, endMicros: 1_400_000 },
			{ text: "my", startMicros: 1_400_000, endMicros: 1_600_000 },
			{ text: "fellow", startMicros: 1_600_000, endMicros: 2_000_000 },
			{ text: "Americans", startMicros: 2_000_000, endMicros: 3_500_000 },
		],
	},
	{
		startMicros: 4_000_000,
		endMicros: 5_000_000,
		text: "ask not",
		words: [
			{ text: "ask", startMicros: 4_000_000, endMicros: 4_400_000 },
			{ text: "not", startMicros: 4_400_000, endMicros: 5_000_000 },
		],
	},
];

describe("buildCaptionElementsFromTranscript", () => {
	test("produces one caption element per segment", () => {
		const elements = buildCaptionElementsFromTranscript({
			segments: FIXTURE_SEGMENTS,
			timelineStartTime: ZERO_MEDIA_TIME,
		});
		expect(elements).toHaveLength(2);
		expect(elements.every((e) => e.type === "caption")).toBe(true);
	});

	test("converts segment start/duration from microseconds to ticks exactly", () => {
		const elements = buildCaptionElementsFromTranscript({
			segments: FIXTURE_SEGMENTS,
			timelineStartTime: ZERO_MEDIA_TIME,
		});
		// 1.0s and 2.5s at TICKS_PER_SECOND, both exact (no rounding needed for
		// whole/tenth-second inputs at a 120000 tick rate).
		expect(elements[0].startTime).toBe(mediaTime({ ticks: TICKS_PER_SECOND * 1 }));
		expect(elements[0].duration).toBe(mediaTime({ ticks: TICKS_PER_SECOND * 2.5 }));
		expect(elements[1].startTime).toBe(mediaTime({ ticks: TICKS_PER_SECOND * 4 }));
		expect(elements[1].duration).toBe(mediaTime({ ticks: TICKS_PER_SECOND * 1 }));
	});

	test("offsets segment start times by timelineStartTime so captions land in sync with the transcribed clip", () => {
		const offset = mediaTime({ ticks: TICKS_PER_SECOND * 10 });
		const elements = buildCaptionElementsFromTranscript({
			segments: FIXTURE_SEGMENTS,
			timelineStartTime: offset,
		});
		expect(elements[0].startTime).toBe(mediaTime({ ticks: TICKS_PER_SECOND * 11 }));
		expect(elements[1].startTime).toBe(mediaTime({ ticks: TICKS_PER_SECOND * 14 }));
	});

	test("word times are relative to their OWN segment's start, not the transcript's absolute start", () => {
		const elements = buildCaptionElementsFromTranscript({
			segments: FIXTURE_SEGMENTS,
			timelineStartTime: ZERO_MEDIA_TIME,
		});
		if (elements[0].type !== "caption") throw new Error("expected caption element");
		const words = elements[0].words;
		expect(words).toHaveLength(5);
		expect(words[0].text).toBe("and");
		expect(words[0].startTime).toBe(ZERO_MEDIA_TIME); // segment's own word 0 starts at t=0
		expect(words[4].text).toBe("Americans");
		// last word ends exactly at the segment's own duration (3.5s - 1.0s = 2.5s)
		expect(words[4].endTime).toBe(mediaTime({ ticks: TICKS_PER_SECOND * 2.5 }));
	});

	test("word times are monotonically non-decreasing within a segment", () => {
		const elements = buildCaptionElementsFromTranscript({
			segments: FIXTURE_SEGMENTS,
			timelineStartTime: ZERO_MEDIA_TIME,
		});
		for (const element of elements) {
			if (element.type !== "caption") continue;
			let cursor = 0;
			for (const word of element.words) {
				expect(word.startTime).toBeGreaterThanOrEqual(cursor);
				expect(word.endTime).toBeGreaterThan(word.startTime);
				cursor = word.endTime;
			}
		}
	});

	test("trimStart/trimEnd start at zero — a fresh, unsplit caption element", () => {
		const elements = buildCaptionElementsFromTranscript({
			segments: FIXTURE_SEGMENTS,
			timelineStartTime: ZERO_MEDIA_TIME,
		});
		for (const element of elements) {
			expect(element.trimStart).toBe(ZERO_MEDIA_TIME);
			expect(element.trimEnd).toBe(ZERO_MEDIA_TIME);
		}
	});

	test("skips segments with zero words (non-speech spans)", () => {
		const elements = buildCaptionElementsFromTranscript({
			segments: [
				...FIXTURE_SEGMENTS,
				{ startMicros: 6_000_000, endMicros: 7_000_000, text: "", words: [] },
			],
			timelineStartTime: ZERO_MEDIA_TIME,
		});
		expect(elements).toHaveLength(2);
	});

	test("applies the default style preset's params when none is given", () => {
		const elements = buildCaptionElementsFromTranscript({
			segments: FIXTURE_SEGMENTS,
			timelineStartTime: ZERO_MEDIA_TIME,
		});
		expect(elements[0].params.stylePresetId).toBe(DEFAULT_CAPTION_STYLE_PRESET_ID);
		expect(typeof elements[0].params.highlightColor).toBe("string");
	});

	test("applies an explicitly requested style preset", () => {
		const elements = buildCaptionElementsFromTranscript({
			segments: FIXTURE_SEGMENTS,
			timelineStartTime: ZERO_MEDIA_TIME,
			stylePresetId: "kneecap-cyan",
		});
		expect(elements[0].params.stylePresetId).toBe("kneecap-cyan");
		expect(elements[0].params.highlightColor).toBe("#00CAE0");
	});
});
