/**
 * REAL captured whisper.cpp DTW output — not synthetic.
 *
 * Provenance (reproducible): on this development machine (macOS, Apple
 * Silicon), `brew install whisper-cpp` gives whisper.cpp 1.9.2 with Metal
 * acceleration. Ran:
 *
 *   whisper-cli \
 *     -m ~/Library/Application\ Support/WhimprFlow/models/ggml-base.en.bin \
 *     -f /opt/homebrew/Cellar/whisper-cpp/1.9.2/share/whisper-cpp/jfk.wav \
 *     -dtw base.en -nfa -oj -ojf -of /tmp/jfk_dtw
 *
 * (`-nfa` / `--no-flash-attn` is required — whisper.cpp 1.9.2 silently
 * disables DTW token timestamps when flash attention is on, logging
 * `dtw_token_timestamps is not supported with flash_attn - disabling`. This
 * is itself a real, undocumented-in-the-corpus gotcha discovered by running
 * the tool, not something the corpus flagged — worth carrying forward into
 * the native plugin build notes.)
 *
 * Model: `ggml-base.en.bin` (base.en, 147,964,211 bytes on disk — matches
 * the plan's "142MiB" figure for `base`). Sample: whisper.cpp's own bundled
 * `jfk.wav` (11.0s, 16kHz mono PCM, the canonical whisper.cpp demo clip:
 * "And so my fellow Americans, ask not what your country can do for you,
 * ask what you can do for your country."). Full raw JSON capture (`-ojf`)
 * archived at the bottom of this file's sibling commit message for anyone
 * re-deriving these numbers; the values below are transcribed by hand from
 * that capture, `t0`/`t1` -> `coarseStart/EndMicros` (`ms * 1000`), `t_dtw`
 * -> `dtwStartMicros` (`t_dtw` is centiseconds per whisper.cpp's own source,
 * `src/whisper.cpp` ~line 9124: `int64_t timestamp = (time_index * 2) +
 * seek; // Each index on DTW result = 20mS audio` combined with the same
 * file's karaoke printer dividing by 100 for seconds — so `ms = t_dtw *
 * 10`, `micros = t_dtw * 10_000`). `[_BEG_]`/`[_TT_550]` special tokens
 * (t_dtw = -1, not real words) are already excluded, matching what a real
 * native plugin does by filtering `token.id >= whisper_token_eot(ctx)`
 * before ever building a `RawWordTiming`.
 *
 * TWO REAL DEFECTS this capture exhibits (both cited, in kind, by corpus
 * `12`'s "punctuation frequently misaligns... some segments completely
 * inaccurate" warning — found here empirically, not assumed):
 *
 *   1. The comma after "Americans": coarse window is [2850ms, 3300ms], but
 *      its own `t_dtw` estimate is 3360ms — AFTER its own coarse window
 *      closes, and bleeding into "ask"'s coarse window ([3300ms, 4140ms]).
 *   2. The comma after "you" (second sentence): its `t_dtw` (7300ms) is
 *      IDENTICAL, to the millisecond, to the immediately preceding word
 *      "you"'s own `t_dtw` (7300ms) — a zero-delta collision, and actually
 *      130ms EARLIER than its own coarse start (7810ms). This is exactly
 *      the "punctuation timestamp collapses onto the preceding token"
 *      failure the corpus's cited whisper.cpp PR discussion describes.
 *
 * Both are real inputs to the fixture test in `caption-smoothing.test.ts`,
 * which asserts the smoothing pass's punctuation-merge rule neutralizes
 * both by construction (their own timestamps are discarded, not repaired).
 */

import type { RawWordTiming } from "../../caption-smoothing";

export interface JfkSegmentFixture {
	segmentStartMicros: number;
	segmentEndMicros: number;
	tokens: RawWordTiming[];
}

export const JFK_DTW_FIXTURE: JfkSegmentFixture[] = [
	{
		segmentStartMicros: 0,
		segmentEndMicros: 6_740_000,
		tokens: [
			{ text: " And", coarseStartMicros: 320_000, coarseEndMicros: 370_000, dtwStartMicros: 500_000, confidence: 0.7108 },
			{ text: " so", coarseStartMicros: 370_000, coarseEndMicros: 530_000, dtwStartMicros: 740_000, confidence: 0.9851 },
			{ text: " my", coarseStartMicros: 690_000, coarseEndMicros: 850_000, dtwStartMicros: 1_100_000, confidence: 0.6976 },
			{ text: " fellow", coarseStartMicros: 850_000, coarseEndMicros: 1_590_000, dtwStartMicros: 1_520_000, confidence: 0.9946 },
			{ text: " Americans", coarseStartMicros: 1_590_000, coarseEndMicros: 2_100_000, dtwStartMicros: 1_980_000, confidence: 0.9038 },
			// Defect #1: t_dtw (3_360_000) lands after this token's own coarse
			// window closes (2_850_000..3_300_000) and inside "ask"'s.
			{ text: ",", coarseStartMicros: 2_850_000, coarseEndMicros: 3_300_000, dtwStartMicros: 3_360_000, confidence: 0.2878 },
			{ text: " ask", coarseStartMicros: 3_300_000, coarseEndMicros: 4_140_000, dtwStartMicros: 3_700_000, confidence: 0.8007 },
			{ text: " not", coarseStartMicros: 4_140_000, coarseEndMicros: 4_280_000, dtwStartMicros: 4_160_000, confidence: 0.7864 },
			{ text: " what", coarseStartMicros: 5_030_000, coarseEndMicros: 5_350_000, dtwStartMicros: 5_460_000, confidence: 0.9313 },
			{ text: " your", coarseStartMicros: 5_410_000, coarseEndMicros: 5_740_000, dtwStartMicros: 5_720_000, confidence: 0.9875 },
			{ text: " country", coarseStartMicros: 5_740_000, coarseEndMicros: 6_410_000, dtwStartMicros: 6_200_000, confidence: 0.9956 },
			{ text: " can", coarseStartMicros: 6_410_000, coarseEndMicros: 6_740_000, dtwStartMicros: 6_560_000, confidence: 0.9765 },
		],
	},
	{
		segmentStartMicros: 6_740_000,
		segmentEndMicros: 11_000_000,
		tokens: [
			{ text: " do", coarseStartMicros: 6_740_000, coarseEndMicros: 6_920_000, dtwStartMicros: 6_780_000, confidence: 0.9898 },
			{ text: " for", coarseStartMicros: 7_000_000, coarseEndMicros: 7_000_000, dtwStartMicros: 7_040_000, confidence: 0.9559 },
			{ text: " you", coarseStartMicros: 7_010_000, coarseEndMicros: 7_520_000, dtwStartMicros: 7_300_000, confidence: 0.9844 },
			// Defect #2: t_dtw (7_300_000) is IDENTICAL to the preceding word
			// "you"'s t_dtw, and earlier than this token's own coarse start
			// (7_810_000).
			{ text: ",", coarseStartMicros: 7_810_000, coarseEndMicros: 8_050_000, dtwStartMicros: 7_300_000, confidence: 0.4928 },
			{ text: " ask", coarseStartMicros: 8_190_000, coarseEndMicros: 8_370_000, dtwStartMicros: 8_340_000, confidence: 0.6462 },
			{ text: " what", coarseStartMicros: 8_370_000, coarseEndMicros: 8_750_000, dtwStartMicros: 8_720_000, confidence: 0.9875 },
			{ text: " you", coarseStartMicros: 8_910_000, coarseEndMicros: 9_040_000, dtwStartMicros: 8_980_000, confidence: 0.9806 },
			{ text: " can", coarseStartMicros: 9_040_000, coarseEndMicros: 9_320_000, dtwStartMicros: 9_280_000, confidence: 0.9686 },
			{ text: " do", coarseStartMicros: 9_320_000, coarseEndMicros: 9_380_000, dtwStartMicros: 9_520_000, confidence: 0.9083 },
			{ text: " for", coarseStartMicros: 9_440_000, coarseEndMicros: 9_760_000, dtwStartMicros: 9_760_000, confidence: 0.9066 },
			{ text: " your", coarseStartMicros: 9_760_000, coarseEndMicros: 9_990_000, dtwStartMicros: 9_900_000, confidence: 0.9808 },
			{ text: " country", coarseStartMicros: 10_020_000, coarseEndMicros: 10_360_000, dtwStartMicros: 10_340_000, confidence: 0.9955 },
			{ text: ".", coarseStartMicros: 10_510_000, coarseEndMicros: 10_990_000, dtwStartMicros: 10_720_000, confidence: 0.8738 },
		],
	},
];

/** The known-correct transcript, for the fixture test's text-reconstruction
 * assertion (whisper.cpp's own greedy decode of this clip — confirmed
 * against the classic, widely-published JFK inaugural excerpt). */
export const JFK_EXPECTED_TEXT =
	"And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.";
