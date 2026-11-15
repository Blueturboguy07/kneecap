/**
 * Fixer pass — wires M8's Captions panel to the REAL M10 captions engine
 * that merged into main after track/ui branched (commit order:
 * track/ui M8 was last, track/captions/M10 merged before it, but the panel
 * was never updated to use what M10 shipped). This was previously a
 * hardcoded `disabled` no-op with the doc-comment claim "no `TrackType` for
 * captions in the engine yet" — both false on this merge:
 * `packages/editor-core/src/timeline/types.ts`'s `TrackType` union includes
 * `"caption"`, and `packages/editor-core/src/captions/generate.ts` +
 * `commands/captions/*` are real, tested modules.
 *
 * "Generate" here calls the REAL pipeline end to end:
 *   1. `getNativeBridge()` (never `./web-fallback` directly — this is an
 *      editor UI file, so it's bound by the same bridge-import gate
 *      `scripts/invariants.sh` enforces for every other panel/action in
 *      this package) selects the web-fallback bridge in a plain browser.
 *   2. The web-fallback bridge's `transcribe()` recognizes exactly ONE
 *      sentinel `MediaHandle` (`DEV_FIXTURE_MEDIA_HANDLE`,
 *      `@kneecap/native-bridge`'s own dev-harness fixture, built
 *      specifically for "verify the full generate -> edit -> preview flow
 *      in the dev harness using the web fallback + a pre-transcribed
 *      fixture" per that fixture's own header) and yields real
 *      `TranscriptSegment[]` data — any other handle still throws the
 *      honest `UNSUPPORTED` error, this is not a general in-webview STT
 *      backdoor.
 *   3. `buildCaptionElementsFromTranscript` (editor-core's real M10
 *      module) converts those segments into `CreateCaptionElement[]`.
 *   4. `insertGeneratedCaptions` (editor-core's real M10 command helper)
 *      lands them on a brand-new caption track as one undoable action.
 *
 * There is still no real on-device whisper.cpp call reachable from THIS
 * panel — only the disclosed dev-fixture path above. A real file's audio
 * still cannot be transcribed from the web-fallback bridge (native shells
 * only, plan M10) or from this panel at all (no "pick a clip to
 * transcribe" affordance was added — out of scope for this fixer pass, see
 * the caller's own flags). That gap is real and left open, not papered
 * over: the panel's copy says exactly this.
 */
import type { EditorCore, MediaAsset, MediaTime } from "@kneecap/editor-core";
import {
	mediaTimeToSeconds,
	resolveNativeMediaRawPath,
	ZERO_MEDIA_TIME,
} from "@kneecap/editor-core";
import type { CaptionElement, CreateCaptionElement, VideoElement } from "@kneecap/editor-core/timeline";
import type { ParamValues } from "@kneecap/editor-core/params";
import {
	buildCaptionElementsFromTranscript,
	type TranscriptSegmentInput,
} from "@kneecap/editor-core/captions";
import {
	insertGeneratedCaptions,
	ApplyCaptionStyleCommand,
	UpdateElementsCommand,
} from "@kneecap/editor-core/commands";
import { DEFAULT_TEXT_BORDER_WIDTH } from "@kneecap/editor-core/text/typography";
import { windowSegmentsToClip } from "./caption-window";
import {
	getNativeBridge,
	NativeBridgeError,
	DEV_FIXTURE_MEDIA_HANDLE,
	type MediaHandle,
	type TranscriptSegment,
} from "@kneecap/native-bridge";

/**
 * The words the Captions panel shows when Generate cannot make captions
 * (blind test 1.0.4: the panel showed "audio not readable:
 * /kneecap-dev-fixture:sample-v1", a developer fixture). The messages never
 * name a file, a path or a developer fixture; the details go to the console.
 */
export const CAPTION_MESSAGES = {
	noClip: "Add a video clip with sound first. Captions come from the sound of your clips.",
	noAudio: "Your clips have no sound. Add a video clip with sound to make captions.",
	unreadable: "Captions could not read the sound of your clips. Try again.",
	noSpeech: "No speech was detected anywhere on the timeline.",
	permission: "Speech recognition is off for publik kneecap. Turn it on in Settings to make captions.",
	unsupported: "Captions need speech recognition on this phone, and this phone does not have it.",
} as const;

export interface GenerateCaptionsResult {
	trackId: string;
	elementIds: string[];
}

/**
 * Round 20 — REAL captions: transcribe audio on-device (iOS: Apple
 * Speech via NativeBridgePlugin+Transcribe.swift; Android: whisper.cpp)
 * and land the words as caption elements aligned under the clips.
 *
 * Round 30 (founder screenshot: a quiet first clip = "No speech was
 * detected" while the rest of the timeline was full of speech): the
 * generate no longer targets ONE clip — it processes EVERY audible clip
 * on the timeline (`collectTranscriptionJobs`), transcribing each SOURCE
 * once and windowing the shared transcript per clip to its
 * [trimStart, trimStart+duration), offset to the clip's timeline start.
 *
 * Throws with actionable messages ("no video clip", "no native media
 * file") — the caller (the panel, or generateCaptions below) decides how
 * to degrade.
 */
export interface TranscriptionJob {
	/** Raw on-device path fed to `NativeBridge.transcribe` (original
	 *  preferred, proxy accepted — the exporter's custody preference). */
	rawPath: string;
	assetId: string;
	assetKind: "video" | "audio";
	fileName: string;
	assetDurationMicros: number;
	/** The clip's audible source window, for `windowSegmentsToClip`. */
	trimStartMicros: number;
	windowMicros: number;
	/** Where the windowed words land on the timeline. */
	timelineStartTime: MediaTime;
}

/**
 * Round 30 (founder: "all audio from the entire timeline must be
 * exported and processed"): every transcribable clip in timeline order —
 * main-track video, overlay (PiP) video, and upload-audio clips
 * (voiceovers) — with muted/hidden/audio-disabled clips skipped (captions
 * follow what's AUDIBLE). Pure and unit-tested; clips without an
 * on-device file (web dev harness) simply drop out.
 */
export function collectTranscriptionJobs({
	tracks,
	assets,
}: {
	tracks: ReturnType<EditorCore["scenes"]["getActiveScene"]>["tracks"];
	assets: MediaAsset[];
}): TranscriptionJob[] {
	const assetById = new Map(assets.map((a) => [a.id, a]));
	const jobs: TranscriptionJob[] = [];

	const pushJob = ({
		element,
		assetKind,
	}: {
		element: {
			mediaId: string;
			startTime: MediaTime;
			duration: MediaTime;
			trimStart: MediaTime;
		};
		assetKind: "video" | "audio";
	}) => {
		const asset = assetById.get(element.mediaId);
		const rawPath = asset?.sourceNativeRelativePath
			? resolveNativeMediaRawPath(asset.sourceNativeRelativePath)
			: asset?.nativeRelativePath
				? resolveNativeMediaRawPath(asset.nativeRelativePath)
				: null;
		if (!asset || !rawPath) return;
		// A clip without an audio track has nothing to transcribe (a photo, or
		// a video with no sound): it is not a job, so it cannot fail as one.
		if (asset.hasAudio === false) return;
		jobs.push({
			rawPath,
			assetId: asset.id,
			assetKind,
			fileName: asset.name,
			assetDurationMicros: Math.round((asset.duration ?? 0) * 1_000_000),
			trimStartMicros: Math.round(
				mediaTimeToSeconds({ time: element.trimStart }) * 1_000_000,
			),
			windowMicros: Math.round(
				mediaTimeToSeconds({ time: element.duration }) * 1_000_000,
			),
			timelineStartTime: element.startTime,
		});
	};

	for (const el of tracks.main.elements) {
		if (el.type !== "video" || el.hidden) continue;
		if (el.params.muted === true || el.isSourceAudioEnabled === false) continue;
		pushJob({ element: el, assetKind: "video" });
	}
	for (const track of tracks.overlay) {
		if (track.type !== "video" || track.muted) continue;
		for (const el of track.elements) {
			if (el.type !== "video" || el.hidden) continue;
			if (el.params.muted === true || el.isSourceAudioEnabled === false) continue;
			pushJob({ element: el, assetKind: "video" });
		}
	}
	for (const track of tracks.audio) {
		if (track.muted) continue;
		for (const el of track.elements) {
			if (el.type !== "audio" || el.sourceType !== "upload") continue;
			if (el.params.muted === true) continue;
			pushJob({ element: el, assetKind: "audio" });
		}
	}

	jobs.sort((a, b) => a.timelineStartTime - b.timelineStartTime);
	return jobs;
}

export async function generateCaptionsForClip({
	editor,
	stylePresetId,
}: {
	editor: EditorCore;
	stylePresetId: string;
}): Promise<GenerateCaptionsResult | null> {
	const tracks = editor.scenes.getActiveScene().tracks;
	const hasAnyVideo = tracks.main.elements.some(
		(el): el is VideoElement => el.type === "video" && !el.hidden,
	);
	const hasAnyAudioClip = tracks.audio.some((track) =>
		track.elements.some((el) => el.type === "audio"),
	);
	if (!hasAnyVideo && !hasAnyAudioClip) {
		throw new Error(CAPTION_MESSAGES.noClip);
	}

	const jobs = collectTranscriptionJobs({
		tracks,
		assets: editor.media.getAssets(),
	});
	if (jobs.length === 0) {
		// Every clip is muted, has no audio track, or has no file on this phone.
		throw new Error(CAPTION_MESSAGES.noAudio);
	}

	const bridge = await getNativeBridge();
	// One transcription per SOURCE FILE, not per clip — a split-heavy
	// timeline references the same source many times; each clip then
	// windows the shared transcript to its own trim range.
	const transcriptBySource = new Map<string, TranscriptSegment[]>();
	const failures: string[] = [];
	// A "Don't Allow" on the iOS speech prompt rejects every job with
	// PERMISSION_DENIED (NativeBridgePlugin+Transcribe.swift): say that, not
	// "could not read the sound" (blind test round 2).
	let permissionDenied = false;
	// Blind test 1.0.7, item 8: speech recognition runs on this phone only. A phone without
	// on-device recognition rejects every job with UNSUPPORTED (AppleSpeechTranscriber.swift):
	// say that, not "could not read the sound … Try again".
	let onDeviceMissing = false;
	const allElements: ReturnType<typeof buildCaptionElementsFromTranscript> = [];
	for (const job of jobs) {
		let segments = transcriptBySource.get(job.rawPath);
		if (!segments) {
			try {
				segments = [];
				for await (const segment of bridge.transcribe({
					handle: {
						id: job.assetId,
						uri: job.rawPath,
						kind: job.assetKind,
						fileName: job.fileName,
						sizeBytes: 0,
						durationMicros: job.assetDurationMicros,
						width: 0,
						height: 0,
						rotationDegrees: 0,
						hasAudio: true,
						codec: "",
						frameRate: null,
					} satisfies MediaHandle,
					opts: { modelSize: "tiny" },
				})) {
					segments.push(segment);
				}
				transcriptBySource.set(job.rawPath, segments);
			} catch (error) {
				// One unreadable/undecodable source must not lose the rest of
				// the timeline's captions — collect and continue.
				if (error instanceof NativeBridgeError && error.code === "PERMISSION_DENIED") permissionDenied = true;
				if (error instanceof NativeBridgeError && error.code === "UNSUPPORTED") onDeviceMissing = true;
				failures.push(
					`${job.fileName}: ${error instanceof Error ? error.message : String(error)}`,
				);
				transcriptBySource.set(job.rawPath, []);
				continue;
			}
		}

		const windowed = windowSegmentsToClip({
			segments,
			trimStartMicros: job.trimStartMicros,
			durationMicros: job.windowMicros,
		});
		allElements.push(
			...buildCaptionElementsFromTranscript({
				segments: windowed,
				timelineStartTime: job.timelineStartTime,
				stylePresetId,
			}),
		);
	}

	if (failures.length > 0) console.error("captions: transcription failed for", failures);
	if (allElements.length === 0 && permissionDenied) {
		throw new Error(CAPTION_MESSAGES.permission);
	}
	if (allElements.length === 0 && onDeviceMissing) {
		throw new Error(CAPTION_MESSAGES.unsupported);
	}
	if (allElements.length === 0 && failures.length === jobs.length && failures.length > 0) {
		throw new Error(CAPTION_MESSAGES.unreadable);
	}

	const elements = inheritSharedCaptionParams({ editor, elements: allElements });
	const inserted = insertGeneratedCaptions({ editor, elements });
	if (!inserted) {
		// Round 21.1: an empty result must SAY so — the device bug shipped a
		// single empty token and the panel silently reported "done" with
		// nothing inserted.
		throw new Error(CAPTION_MESSAGES.noSpeech);
	}
	return inserted;
}

/**
 * The panel's one entry point: the person's own clips only. Before 1.0.4 a
 * timeline with no transcribable clip fell back to the developer sample
 * clip (`generateCaptionsFromSampleClip`); on a phone that showed "audio not
 * readable: /kneecap-dev-fixture:sample-v1". Now every failure is one of the
 * plain CAPTION_MESSAGES.
 */
export async function generateCaptions({
	editor,
	stylePresetId,
}: {
	editor: EditorCore;
	stylePresetId: string;
}): Promise<GenerateCaptionsResult | null> {
	return generateCaptionsForClip({ editor, stylePresetId });
}

/** Developer harness only (the app never calls it, see generateCaptions).
 *  Runs the real generate pipeline against the dev-fixture sample clip and
 *  lands real `CaptionElement`s on a real caption track. Returns `null` if
 *  the fixture yields zero usable segments (shouldn't happen with the
 *  bundled sample, but `insertGeneratedCaptions` itself returns `null` for
 *  an empty element list rather than inserting an empty track). */
export async function generateCaptionsFromSampleClip({
	editor,
	stylePresetId,
}: {
	editor: EditorCore;
	stylePresetId: string;
}): Promise<GenerateCaptionsResult | null> {
	const bridge = await getNativeBridge();
	const segments: TranscriptSegmentInput[] = [];
	for await (const segment of bridge.transcribe({
		handle: DEV_FIXTURE_MEDIA_HANDLE,
		opts: { modelSize: "tiny" },
	})) {
		segments.push(segment);
	}

	const elements = inheritSharedCaptionParams({
		editor,
		elements: buildCaptionElementsFromTranscript({
			segments,
			timelineStartTime: ZERO_MEDIA_TIME,
			stylePresetId,
		}),
	});

	return insertGeneratedCaptions({ editor, elements });
}

/** "Apply to all" caption style — the real `ApplyCaptionStyleCommand`
 *  (plan M10 item 6), not local-only chip-selection state. Undoable like
 *  every other engine mutation this package wires. */
export function applyCaptionStyleToAll({
	editor,
	presetId,
}: {
	editor: EditorCore;
	presetId: string;
}): void {
	editor.command.execute({
		command: new ApplyCaptionStyleCommand({ presetId, scope: { kind: "all" } }),
	});
}

/** Every caption element in the active scene, with its track. Captions are
 *  a synced FAMILY (round 23): position, size, and the highlight toggle
 *  always apply to all of them together. */
export function getAllCaptions({
	editor,
}: {
	editor: EditorCore;
}): Array<{ trackId: string; element: CaptionElement }> {
	const tracks = editor.scenes.getActiveScene().tracks;
	const out: Array<{ trackId: string; element: CaptionElement }> = [];
	for (const track of tracks.overlay) {
		if (track.type !== "caption") continue;
		for (const element of track.elements) {
			if (element.type === "caption") out.push({ trackId: track.id, element });
		}
	}
	return out;
}

/** Whether the spoken-word highlight is on, read from the first caption
 *  (they're kept in sync). `true` with no captions — the presets default
 *  to karaoke. */
export function getCaptionHighlightEnabled({ editor }: { editor: EditorCore }): boolean {
	const first = getAllCaptions({ editor })[0];
	if (!first) return true;
	return first.element.params.animationStyle !== "none";
}

/** Round 31 (founder: "a default thin black border I can add around any
 *  text or captions"): captions are a synced family, so the border reads
 *  from the first one. */
export function getCaptionBorderEnabled({ editor }: { editor: EditorCore }): boolean {
	const first = getAllCaptions({ editor })[0];
	if (!first) return false;
	const width = first.element.params.strokeWidth;
	return typeof width === "number" && width > 0;
}

/** Flips the thin black border on EVERY caption in one undoable patch.
 *  DEFAULT_TEXT_BORDER_WIDTH is the reference editor's default border weight
 *  (pixel-measured — see the constant's doc comment). */
export function setCaptionBorderEnabled({
	editor,
	enabled,
}: {
	editor: EditorCore;
	enabled: boolean;
}): void {
	const captions = getAllCaptions({ editor });
	if (captions.length === 0) return;
	editor.command.execute({
		command: new UpdateElementsCommand({
			updates: captions.map(({ trackId, element }) => ({
				trackId,
				elementId: element.id,
				patch: {
					params: {
						...element.params,
						strokeWidth: enabled ? DEFAULT_TEXT_BORDER_WIDTH : 0,
						strokeColor:
							typeof element.params.strokeColor === "string"
								? element.params.strokeColor
								: "#000000",
					},
				},
			})),
		}),
	});
}

/** Round 23 (founder: "highlighting the word ... should be optional") —
 *  one undoable patch flipping `animationStyle` on EVERY caption between
 *  karaoke (gold active word) and none (plain words, no highlight). */
export function setCaptionHighlightEnabled({
	editor,
	enabled,
}: {
	editor: EditorCore;
	enabled: boolean;
}): void {
	const captions = getAllCaptions({ editor });
	if (captions.length === 0) return;
	editor.command.execute({
		command: new UpdateElementsCommand({
			updates: captions.map(({ trackId, element }) => ({
				trackId,
				elementId: element.id,
				patch: { params: { ...element.params, animationStyle: enabled ? "karaoke" : "none" } },
			})),
		}),
	});
}

/** The params every caption shares as a family (round 23): layout
 *  transform + the highlight choice. Newly generated captions inherit
 *  these from the captions already on the timeline, so a moved/resized/
 *  un-highlighted caption setup survives "Generate again". */
const SHARED_CAPTION_PARAM_KEYS = [
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
	"animationStyle",
] as const;

function inheritSharedCaptionParams({
	editor,
	elements,
}: {
	editor: EditorCore;
	elements: CreateCaptionElement[];
}): CreateCaptionElement[] {
	const first = getAllCaptions({ editor })[0];
	if (!first) return elements;
	const inherited: ParamValues = {};
	for (const key of SHARED_CAPTION_PARAM_KEYS) {
		const value = first.element.params[key];
		if (value !== undefined) inherited[key] = value;
	}
	if (Object.keys(inherited).length === 0) return elements;
	return elements.map((element) => ({
		...element,
		params: { ...element.params, ...inherited },
	}));
}
