import { describe, expect, test } from "bun:test";
import {
	getActiveCaptionWordIndex,
	getVisibleCaptionWords,
	measureCaptionLine,
	type CaptionMeasureContext,
} from "../layout";
import type { CaptionElement, CaptionWord } from "@/timeline/types";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";
import { buildDefaultParamValues, getBuiltInElementParams } from "@/params/registry";

/** A deterministic, monospace-ish fake — no DOM/canvas available under `bun
 * test` (see `text/measure-element.ts`'s own fallback chain, which throws in
 * exactly this environment; that's why this is hand-rolled rather than
 * reusing `getTextMeasurementContext()`). Width = 10px per character, which
 * is all `measureCaptionLine`'s layout math (cursor advancement, block
 * width) needs to be exercised meaningfully. */
function fakeMeasureContext(): CaptionMeasureContext {
	return {
		font: "",
		measureText(text: string) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double: CaptionMeasureContext only reads `.width` off the real TextMetrics return value, so a partial object is a faithful, deliberately narrow stand-in (same rationale as edl/__tests__/json-schema.ts's file-level disable for its own test-only casts).
			return { width: text.length * 10 } as TextMetrics;
		},
	};
}

const T = (seconds: number) => mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });

function buildCaptionElement({
	words,
	trimStart = ZERO_MEDIA_TIME,
	duration,
}: {
	words: CaptionWord[];
	trimStart?: ReturnType<typeof mediaTime>;
	duration: ReturnType<typeof mediaTime>;
}): CaptionElement {
	return {
		id: "el-1",
		type: "caption",
		name: "Caption",
		startTime: ZERO_MEDIA_TIME,
		duration,
		trimStart,
		trimEnd: ZERO_MEDIA_TIME,
		words,
		params: buildDefaultParamValues(getBuiltInElementParams({ type: "caption" })),
	};
}

const WORDS: CaptionWord[] = [
	{ text: "and", startTime: T(0), endTime: T(0.2) },
	{ text: "so", startTime: T(0.2), endTime: T(0.4) },
	{ text: "my", startTime: T(0.4), endTime: T(0.6) },
	{ text: "fellow", startTime: T(0.6), endTime: T(1.0) },
	{ text: "Americans", startTime: T(1.0), endTime: T(2.5) },
];

describe("getActiveCaptionWordIndex", () => {
	const element = buildCaptionElement({ words: WORDS, duration: T(2.5) });

	test("returns null before the first word starts", () => {
		expect(
			getActiveCaptionWordIndex({ element, sourceLocalTime: T(-0.1) }),
		).toBeNull();
	});

	test("returns the word whose span contains sourceLocalTime", () => {
		expect(getActiveCaptionWordIndex({ element, sourceLocalTime: T(0.05) })).toBe(0);
		expect(getActiveCaptionWordIndex({ element, sourceLocalTime: T(0.3) })).toBe(1);
		expect(getActiveCaptionWordIndex({ element, sourceLocalTime: T(2.0) })).toBe(4);
	});

	test("stays on the previous word through a gap between words", () => {
		const gappy: CaptionWord[] = [
			{ text: "hello", startTime: T(0), endTime: T(0.3) },
			{ text: "world", startTime: T(1.0), endTime: T(1.3) },
		];
		const el = buildCaptionElement({ words: gappy, duration: T(1.3) });
		// 0.3..1.0 is a gap: word 0 has finished, word 1 hasn't started.
		expect(getActiveCaptionWordIndex({ element: el, sourceLocalTime: T(0.6) })).toBe(0);
		expect(getActiveCaptionWordIndex({ element: el, sourceLocalTime: T(1.1) })).toBe(1);
	});

	test("advances through every word exactly once across the full span, monotonically", () => {
		const seen: number[] = [];
		for (let ms = 0; ms <= 2500; ms += 25) {
			const idx = getActiveCaptionWordIndex({ element, sourceLocalTime: T(ms / 1000) });
			if (idx !== null && seen[seen.length - 1] !== idx) seen.push(idx);
		}
		expect(seen).toEqual([0, 1, 2, 3, 4]);
	});
});

describe("getVisibleCaptionWords", () => {
	test("returns every word when the clip is untrimmed", () => {
		const element = buildCaptionElement({ words: WORDS, duration: T(2.5) });
		const visible = getVisibleCaptionWords({ element });
		expect(visible.map((v) => v.word.text)).toEqual([
			"and",
			"so",
			"my",
			"fellow",
			"Americans",
		]);
		expect(visible.map((v) => v.index)).toEqual([0, 1, 2, 3, 4]);
	});

	test("filters to the trimmed window, preserving original indices — the split-command contract", () => {
		// Simulates the RIGHT half of a split at t=0.6s: trimStart becomes 0.6s,
		// duration becomes the remaining 1.9s, but `words` is untouched (see
		// `CaptionWord`'s doc comment in timeline/types.ts — SplitElementsCommand
		// never slices it).
		const element = buildCaptionElement({
			words: WORDS,
			trimStart: T(0.6),
			duration: T(1.9),
		});
		const visible = getVisibleCaptionWords({ element });
		expect(visible.map((v) => v.word.text)).toEqual(["fellow", "Americans"]);
		// Indices are into the FULL words array, not the visible slice — index 3
		// and 4, not 0 and 1.
		expect(visible.map((v) => v.index)).toEqual([3, 4]);
	});
});

describe("measureCaptionLine", () => {
	test("lays out words left to right with a one-space gap, uppercased if requested", () => {
		const line = measureCaptionLine({
			words: [
				{ text: "hi", startTime: ZERO_MEDIA_TIME, endTime: T(1) },
				{ text: "there", startTime: T(1), endTime: T(2) },
			],
			activeIndex: 1,
			uppercase: true,
			fontFamily: "Arial",
			fontSize: 20,
			fontWeight: "bold",
			canvasHeight: 1080,
			ctx: fakeMeasureContext(),
		});
		expect(line.words).toHaveLength(2);
		expect(line.words[0].text).toBe("HI");
		expect(line.words[0].x).toBe(0);
		expect(line.words[0].active).toBe(false);
		expect(line.words[1].text).toBe("THERE");
		expect(line.words[1].active).toBe(true);
		// "HI" = 2 chars * 10px = 20, plus a 1-char (10px) space gap -> word 2
		// starts at x=30.
		expect(line.words[1].x).toBe(30);
		expect(line.totalWidth).toBe(30 + 5 * 10); // 30 + "THERE".length*10
	});

	test("empty word list yields a zero-width, zero-word line", () => {
		const line = measureCaptionLine({
			words: [],
			activeIndex: null,
			uppercase: false,
			fontFamily: "Arial",
			fontSize: 20,
			fontWeight: "normal",
			canvasHeight: 1080,
			ctx: fakeMeasureContext(),
		});
		expect(line.words).toHaveLength(0);
		expect(line.totalWidth).toBe(0);
	});
});
