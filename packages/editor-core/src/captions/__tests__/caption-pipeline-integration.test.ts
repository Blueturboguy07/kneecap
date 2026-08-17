/**
 * End-to-end proof of the generate -> edit -> preview -> EDL pipeline this
 * task (M10 part 2) implements, WITHOUT going through `EditorCore`/the
 * `Command` layer: no command in this codebase is unit-tested against a real
 * `EditorCore.getInstance()` today (grep confirms zero existing precedent —
 * every command class calls `EditorCore.getInstance()` internally, which
 * bootstraps `ProjectManager`/`storageService`, itself backed by
 * IndexedDB/OPFS that does not exist under `bun test`). What IS tested here,
 * directly and for real, is every PURE function `insertGeneratedCaptions`/
 * `UpdateCaptionWordCommand`/`ApplyCaptionStyleCommand` actually call —
 * `updateElementInSceneTracks` and `buildCaptionStyleParamsPatch` are the
 * exact same functions those commands use, called the exact same way, just
 * without the `EditorCore` wrapper around them (which itself is a thin
 * save/undo-history/state-broadcast shell, not where any of this task's
 * logic lives).
 *
 * "Preview" is verified the same honest way: `resolveCaptionNode` (the
 * function that would run per-frame in a real renderer) needs a working
 * Canvas2D context to construct (`CanvasRenderer` -> `OffscreenCanvas`),
 * which does not exist under `bun test` either — this is a PRE-EXISTING
 * environment gap (see `scripts/invariants.sh`'s own documented baseline:
 * "snaps text mask movement using intrinsic text bounds... needs a real 2D
 * canvas for text measurement; Bun has no DOM" — `resolveTextNode` has the
 * identical, never-tested status for the same reason). What this file DOES
 * verify directly is the actual karaoke logic `resolveCaptionNode` calls —
 * `getActiveCaptionWordIndex`, `resolveCaptionStyle`, `measureCaptionLine` —
 * with a deterministic fake measure context standing in for the missing
 * canvas.
 */
// This test file builds fixture data by widening `Create*Element` (an
// `Omit<X, "id">`) into a full element with a locally-assigned id, and hands
// raw JSON to the schema checker — the same "deliberate narrowing cast"
// pattern `edl/__tests__/edl.test.ts` already disables file-wide for
// identical reasons (see that file's own header comment).
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { describe, expect, test } from "bun:test";
import { buildCaptionElementsFromTranscript, type TranscriptSegmentInput } from "../generate";
import { buildCaptionStyleParamsPatch } from "../styles";
import {
	getActiveCaptionWordIndex,
	getVisibleCaptionWords,
	measureCaptionLine,
	type CaptionMeasureContext,
} from "../layout";
import { resolveCaptionStyle } from "../resolve-style";
import { updateElementInSceneTracks } from "@/timeline";
import type {
	CaptionElement,
	CaptionTrack,
	SceneTracks,
	TScene,
	VideoTrack,
} from "@/timeline/types";
import type { TProject } from "@/project/types";
import { buildEdl, validateEdl, type BuildEdlOutputArgs } from "@/edl";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";
import edlSchema from "../../../schema/edl-v1.json";
import { validateAgainstSchema } from "@/edl/__tests__/json-schema";
import type { MediaAssetData } from "@/services/storage/types";

const FIXTURE_MEDIA_ASSETS: MediaAssetData[] = [
	{
		id: "media-speech",
		name: "speech.mp4",
		type: "video",
		size: 1_000_000,
		lastModified: 1_755_000_000_000,
		width: 1080,
		height: 1920,
		duration: 5,
		fps: 30,
		hasAudio: true,
	},
];

const TRANSCRIPT: TranscriptSegmentInput[] = [
	{
		startMicros: 0,
		endMicros: 2_000_000,
		text: "and so my fellow Americans",
		words: [
			{ text: "and", startMicros: 0, endMicros: 300_000 },
			{ text: "so", startMicros: 300_000, endMicros: 500_000 },
			{ text: "my", startMicros: 500_000, endMicros: 700_000 },
			{ text: "fellow", startMicros: 700_000, endMicros: 1_200_000 },
			{ text: "Americans,", startMicros: 1_200_000, endMicros: 2_000_000 },
		],
	},
];

function fakeMeasureContext(): CaptionMeasureContext {
	return {
		font: "",
		measureText: (text: string) => ({ width: text.length * 10 }) as TextMetrics,
	};
}

function buildFixtureProject(): TProject {
	return {
		metadata: {
			id: "proj-caption-e2e",
			name: "caption e2e",
			duration: mediaTime({ ticks: 10 * TICKS_PER_SECOND }),
			createdAt: new Date("2026-08-17T00:00:00.000Z"),
			updatedAt: new Date("2026-08-17T00:00:00.000Z"),
		},
		scenes: [],
		currentSceneId: "scene-1",
		version: 31,
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		},
	};
}

function buildFixtureSceneWithCaptions({
	captionElements,
}: {
	captionElements: CaptionElement[];
}): TScene {
	const mainTrack: VideoTrack = {
		id: "track-main",
		name: "Main",
		type: "video",
		muted: false,
		hidden: false,
		elements: [
			{
				id: "clip-source",
				name: "speech.mp4",
				type: "video",
				mediaId: "media-speech",
				duration: mediaTime({ ticks: 5 * TICKS_PER_SECOND }),
				startTime: ZERO_MEDIA_TIME,
				trimStart: ZERO_MEDIA_TIME,
				trimEnd: ZERO_MEDIA_TIME,
				isSourceAudioEnabled: true,
				hidden: false,
				params: {},
			},
		],
	};

	const captionTrack: CaptionTrack = {
		id: "track-captions",
		name: "Captions",
		type: "caption",
		hidden: false,
		elements: captionElements,
	};

	return {
		id: "scene-1",
		name: "Scene 1",
		isMain: true,
		tracks: { overlay: [captionTrack], main: mainTrack, audio: [] },
		bookmarks: [],
		createdAt: new Date("2026-08-17T00:00:00.000Z"),
		updatedAt: new Date("2026-08-17T00:00:00.000Z"),
	};
}

const FIXTURE_OUTPUT: BuildEdlOutputArgs = {
	container: "mp4",
	videoCodec: "h264",
	audioCodec: "aac",
	bitrate: 8_000_000,
	includeAudio: true,
};

describe("caption pipeline: generate -> insert -> EDL burn-in", () => {
	test("generated captions round-trip through buildEdl as a schema-valid \"caption\" overlay", () => {
		const [captionElement] = buildCaptionElementsFromTranscript({
			segments: TRANSCRIPT,
			timelineStartTime: ZERO_MEDIA_TIME,
		}).map((el, i) => ({ ...el, id: `caption-${i}` }) as CaptionElement);

		const scene = buildFixtureSceneWithCaptions({ captionElements: [captionElement] });
		const edl = buildEdl({
			project: buildFixtureProject(),
			scene,
			mediaAssets: FIXTURE_MEDIA_ASSETS,
			output: FIXTURE_OUTPUT,
		});

		const validation = validateEdl({ edl });
		expect(validation.errors).toEqual([]);

		const schemaErrors = validateAgainstSchema({
			value: edl as unknown,
			schema: edlSchema as unknown as Record<string, unknown>,
		});
		expect(schemaErrors).toEqual([]);

		const captionOverlay = edl.overlays.find((o) => o.kind === "caption");
		expect(captionOverlay).toBeDefined();

		const captionClip = edl.tracks
			.find((t) => t.trackId === "track-captions")
			?.clips.find((c) => c.clipId === "caption-0");
		expect(captionClip).toBeDefined();
		expect(captionClip?.captionWords).toHaveLength(5);
		expect(captionClip?.captionWords[0]).toEqual({
			text: "and",
			startTicks: 0,
			endTicks: Math.round(0.3 * TICKS_PER_SECOND),
		});
		expect(captionClip?.captionWords[4].text).toBe("Americans,");
		// every non-caption clip carries the same field, always empty.
		const videoClip = edl.tracks
			.find((t) => t.trackId === "track-main")
			?.clips.find((c) => c.clipId === "clip-source");
		expect(videoClip?.captionWords).toEqual([]);
	});

	test("editing a word's text (UpdateCaptionWordCommand's own logic) changes only that word, and the EDL reflects it", () => {
		const [rawElement] = buildCaptionElementsFromTranscript({
			segments: TRANSCRIPT,
			timelineStartTime: ZERO_MEDIA_TIME,
		});
		const captionElement = { ...rawElement, id: "caption-0" } as CaptionElement;
		let tracks: SceneTracks = buildFixtureSceneWithCaptions({
			captionElements: [captionElement],
		}).tracks;

		// This is UpdateCaptionWordCommand.execute()'s update function, called
		// directly against the same tracks shape the command would receive
		// from `editor.scenes.getActiveScene().tracks`.
		tracks = updateElementInSceneTracks({
			tracks,
			trackId: "track-captions",
			elementId: "caption-0",
			update: (element) => {
				if (element.type !== "caption") return element;
				const words = element.words.slice();
				words[4] = { ...words[4], text: "citizens," };
				return { ...element, words };
			},
		});

		const edited = tracks.overlay.find((t) => t.id === "track-captions")
			?.elements[0] as CaptionElement;
		expect(edited.words.map((w) => w.text)).toEqual([
			"and",
			"so",
			"my",
			"fellow",
			"citizens,",
		]);
		// timing untouched by a text-only edit.
		expect(edited.words[4].startTime).toBe(captionElement.words[4].startTime);
		expect(edited.words[4].endTime).toBe(captionElement.words[4].endTime);

		const edl = buildEdl({
			project: buildFixtureProject(),
			scene: { ...buildFixtureSceneWithCaptions({ captionElements: [] }), tracks },
			mediaAssets: FIXTURE_MEDIA_ASSETS,
			output: FIXTURE_OUTPUT,
		});
		const clip = edl.tracks
			.find((t) => t.trackId === "track-captions")
			?.clips.find((c) => c.clipId === "caption-0");
		expect(clip?.captionWords[4].text).toBe("citizens,");
	});

	test("applying a style preset (ApplyCaptionStyleCommand's own logic) patches params, and the EDL params passthrough carries it", () => {
		const [rawElement] = buildCaptionElementsFromTranscript({
			segments: TRANSCRIPT,
			timelineStartTime: ZERO_MEDIA_TIME,
			stylePresetId: "classic",
		});
		const captionElement = { ...rawElement, id: "caption-0" } as CaptionElement;
		expect(captionElement.params.stylePresetId).toBe("classic");

		// This is ApplyCaptionStyleCommand's own patch-application logic.
		const patch = buildCaptionStyleParamsPatch({ presetId: "kneecap-cyan" });
		const restyled: CaptionElement = {
			...captionElement,
			params: { ...captionElement.params, ...patch },
		};
		expect(restyled.params.stylePresetId).toBe("kneecap-cyan");
		expect(restyled.params.highlightColor).toBe("#00CAE0");
		// text/timing untouched by a style-only change — the corpus's "per-
		// segment overrides still work afterward" guarantee, symmetrically:
		// a style apply doesn't clobber word data either.
		expect(restyled.words).toEqual(captionElement.words);

		const scene = buildFixtureSceneWithCaptions({ captionElements: [restyled] });
		const edl = buildEdl({
			project: buildFixtureProject(),
			scene,
			mediaAssets: FIXTURE_MEDIA_ASSETS,
			output: FIXTURE_OUTPUT,
		});
		const clip = edl.tracks
			.find((t) => t.trackId === "track-captions")
			?.clips.find((c) => c.clipId === "caption-0");
		expect(clip?.params.highlightColor).toBe("#00CAE0");
		expect(clip?.captionWords).toHaveLength(5);
	});

	test("applying a preset to ALL captions on a track (the 'Apply to all' primitive) touches every element", () => {
		const segments: TranscriptSegmentInput[] = [
			TRANSCRIPT[0],
			{
				startMicros: 3_000_000,
				endMicros: 4_000_000,
				text: "ask not",
				words: [
					{ text: "ask", startMicros: 3_000_000, endMicros: 3_400_000 },
					{ text: "not", startMicros: 3_400_000, endMicros: 4_000_000 },
				],
			},
		];
		const elements = buildCaptionElementsFromTranscript({
			segments,
			timelineStartTime: ZERO_MEDIA_TIME,
			stylePresetId: "classic",
		}).map((el, i) => ({ ...el, id: `caption-${i}` }) as CaptionElement);
		expect(elements).toHaveLength(2);

		const patch = buildCaptionStyleParamsPatch({ presetId: "minimal" });
		const restyled = elements.map((el) => ({
			...el,
			params: { ...el.params, ...patch },
		}));

		expect(restyled.every((el) => el.params.stylePresetId === "minimal")).toBe(true);
		expect(restyled.every((el) => el.params.position === "top")).toBe(true);
	});

	test("preview: the active word advances across the segment exactly at each word's boundary (karaoke logic)", () => {
		const [captionElement] = buildCaptionElementsFromTranscript({
			segments: TRANSCRIPT,
			timelineStartTime: ZERO_MEDIA_TIME,
		}) as unknown as CaptionElement[];
		const withId: CaptionElement = { ...captionElement, id: "caption-0" };

		const style = resolveCaptionStyle({ element: withId });
		expect(style.highlightColor).not.toBe(style.color);

		// Sample sourceLocalTime across the whole segment (trimStart=0, so
		// sourceLocalTime === localTime here) and record which word is active.
		const activeWordAt = (seconds: number) => {
			const sourceLocalTime = Math.round(seconds * TICKS_PER_SECOND);
			const idx = getActiveCaptionWordIndex({ element: withId, sourceLocalTime });
			return idx === null ? null : withId.words[idx].text;
		};

		expect(activeWordAt(-0.1)).toBeNull();
		expect(activeWordAt(0.1)).toBe("and");
		expect(activeWordAt(0.35)).toBe("so");
		expect(activeWordAt(0.55)).toBe("my");
		expect(activeWordAt(0.9)).toBe("fellow");
		expect(activeWordAt(1.8)).toBe("Americans,");

		// And the measured render line marks exactly one word `active` at a
		// time, in the same order — this is what `CaptionNode`'s
		// `renderCaptionToContext` fills with `style.highlightColor` instead of
		// `style.color`.
		const visible = getVisibleCaptionWords({ element: withId });
		for (const seconds of [0.1, 0.35, 0.55, 0.9, 1.8]) {
			const sourceLocalTime = Math.round(seconds * TICKS_PER_SECOND);
			const activeElementIndex = getActiveCaptionWordIndex({
				element: withId,
				sourceLocalTime,
			});
			const activeVisibleIndex = visible.findIndex((v) => v.index === activeElementIndex);
			const line = measureCaptionLine({
				words: visible.map((v) => v.word),
				activeIndex: activeVisibleIndex,
				uppercase: style.uppercase,
				fontFamily: style.fontFamily,
				fontSize: style.fontSize,
				fontWeight: style.fontWeight,
				canvasHeight: 1920,
				ctx: fakeMeasureContext(),
			});
			const activeCount = line.words.filter((w) => w.active).length;
			expect(activeCount).toBe(1);
		}
	});

	test("no id collisions: every element in buildCaptionElementsFromTranscript's output needs an id assigned by the caller (Omit<CaptionElement,'id'>)", () => {
		const created = buildCaptionElementsFromTranscript({
			segments: TRANSCRIPT,
			timelineStartTime: ZERO_MEDIA_TIME,
		});
		expect("id" in created[0]).toBe(false);
	});
});
