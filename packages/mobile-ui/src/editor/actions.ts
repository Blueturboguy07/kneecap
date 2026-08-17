/**
 * M8 panel <-> engine bridge. Every function here wraps a REAL
 * `@kneecap/editor-core` command and is called directly by panel
 * components (components/panels/*) — no mock layer, no local-only state
 * standing in for engine state. Each function returns nothing; callers
 * re-read state through `useEditor()` selectors (see use-selection.ts),
 * which is how the whole engine's React bridge is designed to be consumed
 * (see `@kneecap/editor-core/react`'s own header comment).
 */
import type { EditorCore, TCanvasSize } from "@kneecap/editor-core";
import type { ElementRef, RetimeConfig, TimelineElement } from "@kneecap/editor-core/timeline";
import type { ParamValues } from "@kneecap/editor-core/params";
import {
	DeleteElementsCommand,
	DuplicateElementsCommand,
	SplitElementsCommand,
	UpdateElementsCommand,
	InsertElementCommand,
	AddClipEffectCommand,
	UpdateClipEffectParamsCommand,
	RemoveClipEffectCommand,
	ToggleClipEffectCommand,
	UpdateProjectSettingsCommand,
} from "@kneecap/editor-core/commands";
import {
	buildTextElement,
	buildLibraryAudioElement,
	buildStickerElement,
	buildGraphicElement,
	findTrackInSceneTracks,
	calculateTotalDuration,
	isVisualElement,
} from "@kneecap/editor-core/timeline";
import { registerDefaultGraphics } from "@kneecap/editor-core/graphics";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME, type MediaTime } from "@kneecap/editor-core";
import type { FrameRate } from "opencut-wasm";

// --------------------------------- reads -----------------------------------

export function getElement({
	editor,
	ref,
}: {
	editor: EditorCore;
	ref: ElementRef;
}): TimelineElement | null {
	const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
	if (!tracks) return null;
	const track = findTrackInSceneTracks({ tracks, trackId: ref.trackId });
	return track?.elements.find((el) => el.id === ref.elementId) ?? null;
}

// -------------------------------- selection ---------------------------------

export function selectElement({ editor, ref }: { editor: EditorCore; ref: ElementRef | null }): void {
	editor.selection.setSelectedElements({ elements: ref ? [ref] : [] });
}

// ----------------------------- Edit panel (clip) ----------------------------

export function splitAtPlayhead({ editor, ref }: { editor: EditorCore; ref: ElementRef }): void {
	editor.command.execute({
		command: new SplitElementsCommand({
			elements: [ref],
			splitTime: editor.playback.getCurrentTime(),
		}),
	});
}

export function deleteSelected({ editor, refs }: { editor: EditorCore; refs: ElementRef[] }): void {
	editor.command.execute({ command: new DeleteElementsCommand({ elements: refs }) });
	editor.selection.setSelectedElements({ elements: [] });
}

export function duplicateSelected({ editor, refs }: { editor: EditorCore; refs: ElementRef[] }): void {
	editor.command.execute({ command: new DuplicateElementsCommand({ elements: refs }) });
}

export function setElementParam({
	editor,
	ref,
	key,
	value,
}: {
	editor: EditorCore;
	ref: ElementRef;
	key: string;
	value: ParamValues[string];
}): void {
	const element = getElement({ editor, ref });
	if (!element) return;
	editor.command.execute({
		command: new UpdateElementsCommand({
			updates: [
				{
					trackId: ref.trackId,
					elementId: ref.elementId,
					patch: { params: { ...element.params, [key]: value } },
				},
			],
		}),
	});
}

/** Speed panel control: flat multiplier + Maintain Pitch, both real
 *  `RetimeConfig` fields consumed by `@/retime` (soundtouchjs pitch shift
 *  at `retime/audio-stretch.ts`, already implemented per plan M8 item 3). */
export function setRetime({
	editor,
	ref,
	rate,
	maintainPitch,
}: {
	editor: EditorCore;
	ref: ElementRef;
	rate: number;
	maintainPitch: boolean;
}): void {
	const retime: RetimeConfig = { rate, maintainPitch };
	editor.command.execute({
		command: new UpdateElementsCommand({
			updates: [{ trackId: ref.trackId, elementId: ref.elementId, patch: { retime } }],
		}),
	});
}

export function toggleReversed({ editor, ref }: { editor: EditorCore; ref: ElementRef }): void {
	const element = getElement({ editor, ref });
	if (!element) return;
	const current = Boolean(element.params.reversed);
	setElementParam({ editor, ref, key: "reversed", value: !current });
}

// ------------------------------- Effects/Filters/Adjust ---------------------

/** Ensures exactly one instance of `effectType` exists on the element,
 *  returning its effect id. Filters and Adjust are both modeled as a
 *  single instance per element (matches CapCut: picking a new filter
 *  preset replaces the current one rather than stacking). */
export function ensureSingleEffect({
	editor,
	ref,
	effectType,
}: {
	editor: EditorCore;
	ref: ElementRef;
	effectType: string;
}): string | null {
	const element = getElement({ editor, ref });
	// `element.effects` is an OPTIONAL field on every `VisualElement` variant
	// (video/image/text/sticker/graphic) — an element built via one of the
	// `build*Element` helpers (e.g. `buildStickerElement`) often never sets
	// the key at all rather than setting it to `undefined`, so `"effects"
	// in element` is FALSE for a freshly-inserted element even though its
	// TYPE fully supports effects. Found via real in-browser testing: the
	// Adjust panel got stuck on "Setting up adjustments…" forever for a
	// just-inserted sticker because this used to check key presence
	// instead of element type. `isVisualElement` is the correct check —
	// it tests the element's `type` field, matching how every effects
	// COMMAND (`AddClipEffectCommand` et al.) already gates itself.
	if (!element || !isVisualElement(element)) return null;
	const existing = element.effects?.find((e) => e.type === effectType);
	if (existing) return existing.id;
	const command = new AddClipEffectCommand({ trackId: ref.trackId, elementId: ref.elementId, effectType });
	editor.command.execute({ command });
	return command.getEffectId();
}

export function updateEffectParam({
	editor,
	ref,
	effectId,
	key,
	value,
}: {
	editor: EditorCore;
	ref: ElementRef;
	effectId: string;
	key: string;
	value: ParamValues[string];
}): void {
	editor.command.execute({
		command: new UpdateClipEffectParamsCommand({
			trackId: ref.trackId,
			elementId: ref.elementId,
			effectId,
			params: { [key]: value },
		}),
	});
}

export function removeEffect({
	editor,
	ref,
	effectId,
}: {
	editor: EditorCore;
	ref: ElementRef;
	effectId: string;
}): void {
	editor.command.execute({
		command: new RemoveClipEffectCommand({ trackId: ref.trackId, elementId: ref.elementId, effectId }),
	});
}

export function toggleEffectEnabled({
	editor,
	ref,
	effectId,
}: {
	editor: EditorCore;
	ref: ElementRef;
	effectId: string;
}): void {
	editor.command.execute({
		command: new ToggleClipEffectCommand({ trackId: ref.trackId, elementId: ref.elementId, effectId }),
	});
}

// ---------------------------------- Text ------------------------------------

export function insertTextElement({
	editor,
	content,
}: {
	editor: EditorCore;
	content: string;
}): ElementRef | null {
	const create = buildTextElement({
		raw: { params: { content } },
		startTime: editor.playback.getCurrentTime(),
	});
	const command = new InsertElementCommand({ element: create, placement: { mode: "auto", trackType: "text" } });
	editor.command.execute({ command });
	const trackId = command.getTrackId();
	return trackId ? { trackId, elementId: command.getElementId() } : null;
}

// --------------------------------- Audio ------------------------------------

export function insertLocalSound({
	editor,
	sourceUrl,
	name,
	durationSeconds,
}: {
	editor: EditorCore;
	sourceUrl: string;
	name: string;
	durationSeconds: number;
}): ElementRef | null {
	const create = buildLibraryAudioElement({
		sourceUrl,
		name,
		duration: mediaTimeFromSeconds({ seconds: durationSeconds }),
		startTime: editor.playback.getCurrentTime(),
	});
	const command = new InsertElementCommand({ element: create, placement: { mode: "auto", trackType: "audio" } });
	editor.command.execute({ command });
	const trackId = command.getTrackId();
	return trackId ? { trackId, elementId: command.getElementId() } : null;
}

// -------------------------------- Stickers ----------------------------------

export function insertStickerElement({
	editor,
	stickerId,
}: {
	editor: EditorCore;
	stickerId: string;
}): ElementRef | null {
	const create = buildStickerElement({ stickerId, startTime: editor.playback.getCurrentTime() });
	const command = new InsertElementCommand({ element: create, placement: { mode: "auto", trackType: "graphic" } });
	editor.command.execute({ command });
	const trackId = command.getTrackId();
	return trackId ? { trackId, elementId: command.getElementId() } : null;
}

// -------------------------------- Overlay -----------------------------------

/** "Add overlay" — real media picture-in-picture import needs a decoded
 *  `MediaAsset` (plan M4, not built this session — see demo-project.ts's
 *  header). This inserts a bundled shape graphic onto a NEW overlay track
 *  instead, through the exact same `InsertElementCommand` +
 *  `buildGraphicElement` path the demo bootstrap uses, so opacity/blend
 *  mode have something real to act on immediately after tapping it. */
export function insertOverlayShape({ editor }: { editor: EditorCore }): ElementRef | null {
	registerDefaultGraphics();
	const create = buildGraphicElement({
		definitionId: "rectangle",
		name: "Overlay shape",
		startTime: editor.playback.getCurrentTime(),
		params: { "transform.scaleX": 0.4, "transform.scaleY": 0.4, opacity: 0.8 },
	});
	const command = new InsertElementCommand({ element: create, placement: { mode: "auto", trackType: "graphic" } });
	editor.command.execute({ command });
	const trackId = command.getTrackId();
	return trackId ? { trackId, elementId: command.getElementId() } : null;
}

/** Opacity + blend mode both write to the SAME `element.params` keys every
 *  `VisualElement` already has (`opacity`, `blendMode` —
 *  `params/registry.ts`'s `visualElementParams`), so this is exactly
 *  `setElementParam` under a name the Overlay panel's own controls read. */
export const setOverlayOpacity = setElementParam;
export const setOverlayBlendMode = setElementParam;

// -------------------------------- Export sheet ------------------------------

export function setProjectResolution({
	editor,
	canvasSize,
}: {
	editor: EditorCore;
	canvasSize: TCanvasSize;
}): void {
	editor.command.execute({
		command: new UpdateProjectSettingsCommand({ canvasSize, canvasSizeMode: "preset" }),
	});
}

export function setProjectFps({ editor, fps }: { editor: EditorCore; fps: FrameRate }): void {
	editor.command.execute({ command: new UpdateProjectSettingsCommand({ fps }) });
}

// -------------------------------- Playback ----------------------------------

export function togglePlayback({ editor }: { editor: EditorCore }): void {
	if (editor.playback.getIsPlaying()) {
		editor.playback.pause();
	} else {
		editor.playback.play();
	}
}

export function seekToStart({ editor }: { editor: EditorCore }): void {
	editor.playback.seek({ time: ZERO_MEDIA_TIME });
}

export function seekToEnd({ editor }: { editor: EditorCore }): void {
	const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
	if (!tracks) return;
	editor.playback.seek({ time: calculateTotalDuration({ tracks }) });
}

export { ZERO_MEDIA_TIME };
export type { MediaTime };
