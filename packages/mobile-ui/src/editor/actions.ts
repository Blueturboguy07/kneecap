/**
 * M8 panel <-> engine bridge. Every function here wraps a REAL
 * `@kneecap/editor-core` command and is called directly by panel
 * components (components/panels/*) — no mock layer, no local-only state
 * standing in for engine state. Each function returns nothing; callers
 * re-read state through `useEditor()` selectors (see use-selection.ts),
 * which is how the whole engine's React bridge is designed to be consumed
 * (see `@kneecap/editor-core/react`'s own header comment).
 */
import type { EditorCore, MediaAsset, MediaType, TCanvasSize } from "@kneecap/editor-core";
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
import { buildElementFromMedia } from "@kneecap/editor-core/timeline";
import { getNativeBridge } from "@kneecap/native-bridge";
import {
	importMediaFromNative,
	mediaTimeFromSeconds,
	ZERO_MEDIA_TIME,
	type MediaTime,
	type NativeImportProgress,
} from "@kneecap/editor-core";

export type NativeImportProgressHandler = (
	progress: NativeImportProgress,
) => void;
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

// ----------------------------- Media import ---------------------------------

const IMAGE_DEFAULT_DURATION_SEC = 3;

/**
 * The timeline's "+" add-clip button (capture-verified CapCut chrome,
 * 2026-08-18): native picker -> proxy -> asset registration via the real M4
 * import pipeline, then each imported asset is placed on the main track at
 * the playhead through the same InsertElementCommand path every other
 * insert action here uses. Returns how many clips landed.
 */
export async function importAndPlaceMedia({
	editor,
	onProgress,
}: {
	editor: EditorCore;
	onProgress?: NativeImportProgressHandler;
}): Promise<number> {
	const bridge = await getNativeBridge();
	const projectId = editor.project.getActive().metadata.id;
	const { imported } = await importMediaFromNative({
		editor,
		projectId,
		source: bridge,
		kinds: ["video", "image"],
		allowMultiple: true,
		onProgress,
	});
	for (const asset of imported) {
		const create = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			// `||`, not `??`: a native image import probes durationMicros: 0,
			// and a 0-length clip is invisible/untrimmable (found on device
			// 2026-08-19 alongside the image-proxy fix).
			duration: mediaTimeFromSeconds({ seconds: asset.duration || IMAGE_DEFAULT_DURATION_SEC }),
			startTime: editor.playback.getCurrentTime(),
		});
		editor.command.execute({
			command: new InsertElementCommand({ element: create, placement: { mode: "auto", trackType: "video" } }),
		});
	}
	return imported.length;
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

/**
 * Structural stand-in for editor-core's internal `MediaAssetData`
 * (`@/services/storage/types` — `buildEdl()`'s real `mediaAssets` param
 * type, field-for-field identical here). Not imported directly: that
 * subpath is reachable only through `@kneecap/editor-core`'s package.json
 * `"./*"` wildcard fallback (nothing explicitly lists
 * `services/storage/types`), which this package's own standalone `tsc
 * --project tsconfig.json --noEmit` — the exact command
 * scripts/invariants.sh's M8 gate runs — could not resolve (verified
 * directly this session: `Cannot find module
 * '@kneecap/editor-core/services/storage/types'`). `buildEdl` checks its
 * `mediaAssets` argument structurally, not nominally, so matching the shape
 * here satisfies it with no import of the unreachable type needed.
 */
interface EdlMediaAssetInput {
	id: string;
	name: string;
	type: MediaType;
	size: number;
	lastModified: number;
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	hasAudio?: boolean;
	ephemeral?: boolean;
	thumbnailUrl?: string;
}

/**
 * Maps the engine's live `MediaAsset[]` (`editor.media.getAssets()`) into
 * the `EdlMediaAssetInput[]` shape `buildEdl()` expects. Kept here rather
 * than inline in `export-sheet.tsx` for the same reason every other
 * engine-facing function in this file lives here: one place that knows the
 * real engine type shapes.
 *
 * `MediaAsset` is `Omit<MediaAssetData, "size" | "lastModified"> & { file:
 * File; url?: string }` (`@kneecap/editor-core`'s own `media/types.ts`) — the
 * two fields it drops are read straight off the asset's real `File` object,
 * not invented, since every `MediaAsset` genuinely wraps one.
 */
export function toEdlMediaAssets({ assets }: { assets: MediaAsset[] }): EdlMediaAssetInput[] {
	return assets.map((asset) => ({
		id: asset.id,
		name: asset.name,
		type: asset.type,
		size: asset.file.size,
		lastModified: asset.file.lastModified,
		width: asset.width,
		height: asset.height,
		duration: asset.duration,
		fps: asset.fps,
		hasAudio: asset.hasAudio,
		ephemeral: asset.ephemeral,
		thumbnailUrl: asset.thumbnailUrl,
	}));
}

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

/** Background panel (capture-verified toolbar item, 2026-08-18): a solid
 *  canvas background color through the same settings command the export
 *  sheet's resolution control uses. */
export function setProjectBackground({ editor, color }: { editor: EditorCore; color: string }): void {
	editor.command.execute({
		command: new UpdateProjectSettingsCommand({ background: { type: "color", color } }),
	});
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

/** Fixer pass (M7 mount): scrub/seek from the timeline's own float-second
 *  UI coordinate space into a real `editor.playback.seek()` call. The
 *  seconds->ticks conversion happens exactly once, here at the boundary,
 *  via the real `mediaTimeFromSeconds` — never by passing a float through
 *  as if it were already a `MediaTime`. */
export function seekToSeconds({ editor, seconds }: { editor: EditorCore; seconds: number }): void {
	editor.playback.seek({ time: mediaTimeFromSeconds({ seconds: Math.max(0, seconds) }) });
}

export { ZERO_MEDIA_TIME };
export type { MediaTime };
