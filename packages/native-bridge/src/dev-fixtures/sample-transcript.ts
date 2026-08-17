/**
 * A pre-transcribed, dev-harness-only sample — plan M10's exit criterion
 * "verify the full generate -> edit -> preview flow in the dev harness using
 * the web fallback + a pre-transcribed fixture."
 *
 * NOT a capture of real whisper.cpp DTW output (that's
 * `caption-smoothing.ts`'s own fixture, `__tests__/fixtures/jfk-dtw-raw.ts`,
 * built specifically to verify the SMOOTHING pass against real, documented
 * defects). This fixture's job is different: it's already-smoothed, clean,
 * hand-authored `TranscriptSegment[]` data — exactly the SHAPE
 * `NativeBridge.transcribe()` yields after smoothing — so the web-fallback
 * bridge can hand it to the UI and exercise generate -> edit -> preview end
 * to end in a plain browser, with zero native STT, zero network, and zero
 * ambiguity about whether a rendering bug is really a smoothing bug wearing
 * a UI costume.
 *
 * Word timings are illustrative (a plausible ~150-280ms/word reading pace),
 * not measured from any real audio — there is no real audio file backing
 * this fixture, only the sentinel `MediaHandle` below. This is a deliberate,
 * disclosed simplification: `DEV_FIXTURE_MEDIA_URI` is recognized
 * ONLY by the web-fallback bridge (see `../web-fallback.ts`), never by the
 * Capacitor bridge, and never treated as a real file anywhere else.
 */
import type { MediaHandle, TranscriptSegment } from "../types";

export const DEV_FIXTURE_MEDIA_URI = "kneecap-dev-fixture:sample-v1";

export const DEV_SAMPLE_TRANSCRIPT_SEGMENTS: TranscriptSegment[] = [
	{
		startMicros: 0,
		endMicros: 2_650_000,
		text: "kneecap turns any phone into a full video editor",
		confidence: 0.94,
		words: [
			{ text: "kneecap", startMicros: 0, endMicros: 480_000, confidence: 0.95 },
			{ text: "turns", startMicros: 480_000, endMicros: 780_000, confidence: 0.96 },
			{ text: "any", startMicros: 780_000, endMicros: 990_000, confidence: 0.97 },
			{ text: "phone", startMicros: 990_000, endMicros: 1_280_000, confidence: 0.96 },
			{ text: "into", startMicros: 1_280_000, endMicros: 1_480_000, confidence: 0.95 },
			{ text: "a", startMicros: 1_480_000, endMicros: 1_560_000, confidence: 0.9 },
			{ text: "full", startMicros: 1_560_000, endMicros: 1_800_000, confidence: 0.94 },
			{ text: "video", startMicros: 1_800_000, endMicros: 2_150_000, confidence: 0.95 },
			{ text: "editor", startMicros: 2_150_000, endMicros: 2_650_000, confidence: 0.93 },
		],
	},
	{
		startMicros: 3_300_000,
		endMicros: 5_450_000,
		text: "no cloud, no account, no watermark.",
		confidence: 0.92,
		words: [
			{ text: "no", startMicros: 3_300_000, endMicros: 3_500_000, confidence: 0.93 },
			{ text: "cloud,", startMicros: 3_500_000, endMicros: 3_950_000, confidence: 0.92 },
			{ text: "no", startMicros: 4_050_000, endMicros: 4_250_000, confidence: 0.93 },
			{ text: "account,", startMicros: 4_250_000, endMicros: 4_800_000, confidence: 0.91 },
			{ text: "no", startMicros: 4_900_000, endMicros: 5_080_000, confidence: 0.93 },
			{ text: "watermark.", startMicros: 5_080_000, endMicros: 5_450_000, confidence: 0.9 },
		],
	},
];

/** Ready-to-use `MediaHandle` for a "Try a sample clip" affordance — the dev
 * harness passes this straight to `NativeBridge.transcribe()` without ever
 * needing a real file. `durationMicros` covers the full transcript span. */
export const DEV_FIXTURE_MEDIA_HANDLE: MediaHandle = {
	id: "dev-fixture-sample-v1",
	uri: DEV_FIXTURE_MEDIA_URI,
	kind: "video",
	fileName: "kneecap-sample.mp4",
	sizeBytes: 0,
	durationMicros: 5_450_000,
	width: 1080,
	height: 1920,
	rotationDegrees: 0,
	hasAudio: true,
	codec: "fixture",
	frameRate: { numerator: 30, denominator: 1 },
};
