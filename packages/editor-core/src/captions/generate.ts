/**
 * Transcript -> caption timeline elements — plan M10 items 1/4/5.
 *
 * Converts `NativeBridge.transcribe()`'s output (`TranscriptSegment[]`,
 * already run through the mandatory word-timestamp smoothing pass in
 * `@kneecap/native-bridge` — see that package's `caption-smoothing.ts`) into
 * `CreateCaptionElement[]`, one caption clip per transcript segment, ready to
 * hand to `InsertElementCommand`/a dedicated caption-insert command.
 *
 * Unit discipline: `TranscriptSegment`/`TranscriptWord` carry integer
 * MICROSECONDS, source-relative (native-bridge's own unit — see that
 * package's `types.ts` header: "editor-core is the only place that turns it
 * into durationTicks via the WASM helper"). This module is that place. Every
 * microseconds->ticks conversion below goes through `mediaTimeFromSeconds`
 * (never a bare multiply), matching `edl/build.ts`'s `buildAssets` — the
 * ONLY other seconds/microseconds->ticks boundary in the engine.
 */

import { DEFAULT_TRACK_NAMES } from "@/timeline/tracks";
import type { CaptionWord, CreateCaptionElement } from "@/timeline/types";
import { buildDefaultParamValues, getBuiltInElementParams } from "@/params/registry";
import { buildCaptionStyleParamsPatch, DEFAULT_CAPTION_STYLE_PRESET_ID } from "./styles";
import {
	addMediaTime,
	mediaTime,
	mediaTimeFromSeconds,
	type MediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

/** Mirrors `@kneecap/native-bridge`'s `TranscriptWord`/`TranscriptSegment`
 * structurally rather than importing the package (editor-core has no
 * dependency on native-bridge — the dependency arrow only ever points the
 * other way, native-bridge -> editor-core, per `@kneecap/native-bridge`'s own
 * `package.json`). Any object shaped like this works, which is also exactly
 * what makes this module trivially testable with a plain fixture. */
export interface TranscriptWordInput {
	text: string;
	startMicros: number;
	endMicros: number;
}

export interface TranscriptSegmentInput {
	startMicros: number;
	endMicros: number;
	text: string;
	words: TranscriptWordInput[];
}

function ticksFromMicros({ micros }: { micros: number }): MediaTime {
	return mediaTimeFromSeconds({ seconds: micros / 1_000_000 });
}

/** First few words of a segment, for the element's own `name` field (shown
 * in the timeline UI / element list) — never used for rendering. */
function nameFromSegmentText({ text }: { text: string }): string {
	const trimmed = text.trim();
	if (trimmed.length <= 40) return trimmed || "Caption";
	return `${trimmed.slice(0, 37)}...`;
}

export interface BuildCaptionElementsParams {
	segments: readonly TranscriptSegmentInput[];
	/** Where the transcribed source begins on the TIMELINE (ticks). Segment
	 * offsets are added to this so generated captions land in sync with the
	 * audio/video clip that was transcribed — e.g. pass the source clip's own
	 * `element.startTime`. */
	timelineStartTime: MediaTime;
	/** Defaults to `DEFAULT_CAPTION_STYLE_PRESET_ID` ("classic" — see
	 * `captions/styles.ts`). */
	stylePresetId?: string;
}

/**
 * One `CreateCaptionElement` per transcript segment (plan M10 item 5: "a
 * dedicated caption track of individually timed, trimmable, splittable,
 * editable text clips"; corpus `05` §9: "a chain of individual caption clips
 * laid onto a dedicated caption track"). Segments with zero words are
 * skipped — the smoothing pass upstream only ever produces an empty `words`
 * array for a genuinely non-speech span (native-bridge's own contract, see
 * `TranscriptSegment`'s doc comment there), which has nothing to render or
 * edit as a caption.
 */
export function buildCaptionElementsFromTranscript({
	segments,
	timelineStartTime,
	stylePresetId = DEFAULT_CAPTION_STYLE_PRESET_ID,
}: BuildCaptionElementsParams): CreateCaptionElement[] {
	const params = {
		...buildDefaultParamValues(getBuiltInElementParams({ type: "caption" })),
		...buildCaptionStyleParamsPatch({ presetId: stylePresetId }),
	};

	const elements: CreateCaptionElement[] = [];

	for (const segment of segments) {
		if (segment.words.length === 0) continue;

		const segmentStartTicks = ticksFromMicros({ micros: segment.startMicros });
		const segmentEndTicks = ticksFromMicros({ micros: segment.endMicros });
		const rawDuration = subMediaTime({ a: segmentEndTicks, b: segmentStartTicks });
		const duration = mediaTime({ ticks: Math.max(1, rawDuration) });

		// Word times are stored RELATIVE TO THIS SEGMENT'S OWN START (ticks 0
		// = this element's own trimStart=0 origin) — see `CaptionWord`'s doc
		// comment in `timeline/types.ts` for why that is the coordinate space
		// every downstream consumer (renderer, EDL builder, split command)
		// expects.
		const words: CaptionWord[] = segment.words.map((word) => {
			const rawStart = subMediaTime({
				a: ticksFromMicros({ micros: word.startMicros }),
				b: segmentStartTicks,
			});
			const startTime = mediaTime({ ticks: Math.max(0, rawStart) });
			const rawEnd = subMediaTime({
				a: ticksFromMicros({ micros: word.endMicros }),
				b: segmentStartTicks,
			});
			const endTime = mediaTime({ ticks: Math.max(startTime + 1, rawEnd) });
			return { text: word.text, startTime, endTime };
		});

		elements.push({
			type: "caption",
			name: nameFromSegmentText({ text: segment.text }),
			duration,
			startTime: addMediaTime({ a: timelineStartTime, b: segmentStartTicks }),
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			words,
			params,
		});
	}

	return elements;
}

export const CAPTION_TRACK_DEFAULT_NAME = DEFAULT_TRACK_NAMES.caption;
