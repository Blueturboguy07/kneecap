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
import type { CaptionWord, ElementRef, RetimeConfig, TimelineElement } from "@kneecap/editor-core/timeline";
import type { ParamValues } from "@kneecap/editor-core/params";
import {
	DuplicateElementsCommand,
	SplitElementsCommand,
	UpdateElementsCommand,
	InsertElementCommand,
	AddClipEffectCommand,
	UpdateClipEffectParamsCommand,
	RemoveClipEffectCommand,
	ToggleClipEffectCommand,
	UpdateProjectSettingsCommand,
	TransitionsSnapshotCommand,
	TracksSnapshotCommand,
} from "@kneecap/editor-core/commands";
import {
	buildTextElement,
	buildLibraryAudioElement,
	buildStickerElement,
	buildGraphicElement,
	findTrackInSceneTracks,
	calculateTotalDuration,
	isVisualElement,
	computeGroupResize,
	type GroupResizeMember,
} from "@kneecap/editor-core/timeline";
import {
	addMediaTime,
	subMediaTime,
	maxMediaTime,
	mediaTime,
	mediaTimeToSeconds,
	roundFrameTicks,
} from "@kneecap/editor-core/wasm";
import { registerDefaultGraphics } from "@kneecap/editor-core/graphics";
import { buildElementFromMedia } from "@kneecap/editor-core/timeline";
import { rewriteCaptionWords } from "./caption-text";
import {
	adjacentClipKeyframeTime,
	applyClipKeyframeEasing,
	buildClipKeyframeRemovals,
	buildClipKeyframeUpserts,
	clipLocalTime,
	findClipKeyframeAtTime,
	frameTicksFor,
	getClipKeyframeTimes,
	hasClipKeyframes,
	isClipKeyframePath,
	segmentKeyframeTimeAt,
	snapLocalTimeToFrame,
	type ClipKeyframeEasing,
} from "./keyframes";
import { getNativeBridge } from "@kneecap/native-bridge";
import {
	importMediaFromNative,
	mediaTimeFromSeconds,
	resolveNativeMediaRawPath,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
	type MediaTime,
	type NativeImportProgress,
} from "@kneecap/editor-core";
import type { EdlAssetResolver } from "@kneecap/editor-core/edl";
import {
	DEFAULT_DEAD_SPACE_OPTIONS,
	detectDeadSpace,
	type DeadSpaceOptions,
	type DeadSpaceRefusal,
	type FrameFeatures,
} from "@kneecap/editor-core/media/dead-space";
import { getSourceDeadSpaceFeatures } from "@kneecap/editor-core/media/dead-space-analysis";
import {
	applyDeadSpaceCutToTracks,
	planDeadSpaceCut,
} from "@kneecap/editor-core/timeline/dead-space-cut";
import { getSourceSpanAtClipTime } from "@kneecap/editor-core/retime";

/**
 * The EDL asset resolver for native exports (2026-08-20, fixes the on-device
 * "asset could not be resolved to a readable URL" failure): maps each
 * asset's persisted custody-relative paths back to RAW absolute sandbox
 * paths for the native exporter. Prefers the full-resolution ORIGINAL
 * (export quality never depends on the 540p preview proxy); falls back to
 * the proxy for assets imported before source-path persistence — degraded
 * output beats a failed export. Returns null (asset skipped/erred by
 * buildEdl) only when neither path is known.
 */
export function buildNativeEdlAssetResolver(): EdlAssetResolver {
	return ({ asset }) => {
		const source = asset.sourceNativeRelativePath
			? resolveNativeMediaRawPath(asset.sourceNativeRelativePath)
			: null;
		const proxy = asset.nativeRelativePath
			? resolveNativeMediaRawPath(asset.nativeRelativePath)
			: null;
		const sourceUri = source ?? proxy;
		if (!sourceUri) return null;
		return {
			sourceUri,
			proxyUri: proxy,
			// The proxy is baked upright; only the original needs its
			// display rotation applied at export time.
			rotationDegrees: source ? (asset.sourceRotationDegrees ?? 0) : 0,
		};
	};
}

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

/**
 * MAGNETIC delete (founder, 2026-08-22: "split a clip twice and cut the
 * middle clip — the 2 clips don't snap together"): the main track never
 * keeps a hole. One TracksSnapshotCommand does the removal AND re-butts
 * the main track, so undo restores both in a single step. Overlay/audio
 * tracks are free-position — plain removal, no ripple. The generic
 * DeleteElementsCommand stays gap-preserving for the desktop timeline.
 */
export function deleteSelected({ editor, refs }: { editor: EditorCore; refs: ElementRef[] }): void {
	const before = editor.scenes.getActiveScene().tracks;
	const strip = <T extends { id: string; elements: TimelineElement[] }>(track: T): T => ({
		...track,
		elements: track.elements.filter(
			(el) => !refs.some((r) => r.trackId === track.id && r.elementId === el.id),
		),
	});
	const strippedMain = strip(before.main);
	let cursor = ZERO_MEDIA_TIME;
	const rebuttedElements = [...strippedMain.elements]
		.sort((a, b) => a.startTime - b.startTime)
		.map((el) => {
			const next = el.startTime === cursor ? el : { ...el, startTime: cursor };
			cursor = addMediaTime({ a: cursor, b: el.duration });
			return next;
		});
	const after = {
		main: { ...strippedMain, elements: rebuttedElements },
		overlay: before.overlay.map(strip),
		audio: before.audio.map(strip),
	};
	editor.command.execute({ command: new TracksSnapshotCommand({ before, after }) });
	editor.selection.setSelectedElements({ elements: [] });
}

export function duplicateSelected({ editor, refs }: { editor: EditorCore; refs: ElementRef[] }): void {
	editor.command.execute({ command: new DuplicateElementsCommand({ elements: refs }) });
}

/**
 * Timeline trim commit (the founder's "can't trim / can't extend back out
 * after split" fix): turns a finished handle drag into ONE undoable
 * UpdateElementsCommand through editor-core's `computeGroupResize` — the
 * same frame-snapped, source-extent-clamped math the desktop timeline uses
 * (trimStart/trimEnd move with the edge, so a split clip's cut-off material
 * can be pulled back out; extension stops at the real source extent).
 *
 * The MAIN track is magnetic, CapCut-style: the trimmed clip's neighbors
 * never bound the drag — instead every element at-or-after the clip's end
 * RIPPLES by the applied delta so the track stays butted. A left-edge trim
 * additionally pins the clip's startTime (the in-point changes, the clip
 * stays glued to its previous neighbor — magnetic-timeline semantics, not
 * the desktop's slide-the-start behavior). Free-position tracks keep their
 * neighbor bounds and don't ripple.
 */
export function commitElementTrim({
	editor,
	trackId,
	elementId,
	edge,
	boundarySec,
}: {
	editor: EditorCore;
	trackId: string;
	elementId: string;
	edge: "start" | "end";
	boundarySec: number;
}): void {
	// A trim drag scrubs through the engine's preview overlay
	// (scrubElementTrim) — the commit replaces it with the real command.
	editor.timeline.discardPreview();
	const result = computeTrimPatches({ editor, trackId, elementId, edge, boundarySec });
	if (!result || result.patches.length === 0) return;
	editor.command.execute({
		command: new UpdateElementsCommand({ updates: result.patches }),
	});
}

/**
 * Live trim scrub (round 27, founder: "the preview area should reflect
 * the frame that I'm trimming to"): every trim-preview tick pushes the
 * SAME patches the commit would make into the engine's preview overlay
 * (so the renderer composes the post-trim timeline — including the
 * main-track ripple, so nothing overlaps) and seeks to just inside the
 * dragged edge. The timeline STRIP keeps its own local preview; only the
 * renderer consumes the overlay (getRenderTracks).
 */
export function scrubElementTrim({
	editor,
	trackId,
	elementId,
	edge,
	boundarySec,
}: {
	editor: EditorCore;
	trackId: string;
	elementId: string;
	edge: "start" | "end";
	boundarySec: number;
}): void {
	const result = computeTrimPatches({ editor, trackId, elementId, edge, boundarySec });
	if (!result) return;
	if (result.patches.length > 0) {
		editor.timeline.previewElements({
			updates: result.patches.map((p) => ({
				trackId: p.trackId,
				elementId: p.elementId,
				updates: p.patch,
			})),
		});
	}
	seekToSeconds({ editor, seconds: result.seekSec });
}

function computeTrimPatches({
	editor,
	trackId,
	elementId,
	edge,
	boundarySec,
}: {
	editor: EditorCore;
	trackId: string;
	elementId: string;
	edge: "start" | "end";
	boundarySec: number;
}): {
	patches: Array<{ trackId: string; elementId: string; patch: Partial<TimelineElement> }>;
	/** Where the preview should sit to show the frame under the dragged
	 *  edge: one frame inside the (post-trim) clip. */
	seekSec: number;
} | null {
	const tracks = editor.scenes.getActiveScene().tracks;
	const track = findTrackInSceneTracks({ tracks, trackId });
	const element = track?.elements.find((el) => el.id === elementId);
	const fps = editor.project.getActive().settings.fps;
	if (!track || !element) return null;

	const isMainTrack = tracks.main.id === trackId;
	const side = edge === "start" ? ("left" as const) : ("right" as const);
	const originalEnd = addMediaTime({ a: element.startTime, b: element.duration });
	const boundary = mediaTimeFromSeconds({ seconds: boundarySec });
	const deltaTime =
		side === "left"
			? subMediaTime({ a: boundary, b: element.startTime })
			: subMediaTime({ a: boundary, b: originalEnd });

	let leftNeighborBound: MediaTime | null = null;
	let rightNeighborBound: MediaTime | null = null;
	if (isMainTrack && side === "left") {
		// Magnetic left-trim pins startTime, so the absolute-0 floor that a
		// null bound implies ("can't drag the start before time 0") does not
		// apply — extending the FIRST clip's in-point is legal and pushes
		// everything right. A far-left synthetic bound leaves the source
		// extent (or nothing, for unbounded elements) as the only clamp.
		leftNeighborBound = subMediaTime({
			a: element.startTime,
			b: mediaTime({ ticks: 2 ** 52 }),
		});
	}
	if (!isMainTrack) {
		for (const other of track.elements) {
			if (other.id === elementId) continue;
			const otherEnd = addMediaTime({ a: other.startTime, b: other.duration });
			if (otherEnd <= element.startTime) {
				leftNeighborBound =
					leftNeighborBound === null
						? otherEnd
						: maxMediaTime({ a: leftNeighborBound, b: otherEnd });
			}
			if (other.startTime >= originalEnd) {
				rightNeighborBound =
					rightNeighborBound === null || other.startTime < rightNeighborBound
						? other.startTime
						: rightNeighborBound;
			}
		}
	}

	const member: GroupResizeMember = {
		trackId,
		elementId,
		startTime: element.startTime,
		duration: element.duration,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		sourceDuration:
			element.type === "video" || element.type === "audio"
				? element.sourceDuration
				: undefined,
		retime: "retime" in element ? element.retime : undefined,
		leftNeighborBound,
		rightNeighborBound,
	};
	const { deltaTime: applied, updates } = computeGroupResize({
		members: [member],
		side,
		deltaTime,
		fps,
	});
	const frameSec = fps.denominator / fps.numerator;
	if (updates.length === 0 || applied === 0) {
		// No-op delta: still a valid scrub target — the frame just inside
		// the CURRENT edge.
		const startSec = mediaTimeToSeconds({ time: element.startTime });
		const endSec = mediaTimeToSeconds({ time: originalEnd });
		return {
			patches: [],
			seekSec:
				side === "right" ? Math.max(startSec, endSec - frameSec) : startSec,
		};
	}

	const patches: Array<{
		trackId: string;
		elementId: string;
		patch: Partial<TimelineElement>;
	}> = [
		{
			trackId,
			elementId,
			patch:
				isMainTrack && side === "left"
					? { ...updates[0].patch, startTime: element.startTime }
					: updates[0].patch,
		},
	];

	if (isMainTrack) {
		// Ripple: the clip's end edge moved by `applied` (right side) or by
		// `-applied` (left side, start pinned) — shift everything after it
		// by the same amount so the main track stays butted.
		const shift =
			side === "right" ? applied : subMediaTime({ a: ZERO_MEDIA_TIME, b: applied });
		if (shift !== 0) {
			for (const other of track.elements) {
				if (other.id === elementId || other.startTime < originalEnd) continue;
				patches.push({
					trackId,
					elementId: other.id,
					patch: {
						startTime: maxMediaTime({
							a: ZERO_MEDIA_TIME,
							b: addMediaTime({ a: other.startTime, b: shift }),
						}),
					},
				});
			}
		}
	}

	// Scrub target: one frame inside the post-trim clip at the dragged
	// edge. patches[0] always carries all four resize fields (main-left
	// pins startTime back to the original).
	const patched = patches[0].patch;
	const newStartSec = mediaTimeToSeconds({
		time: patched.startTime ?? element.startTime,
	});
	const newEndSec =
		newStartSec + mediaTimeToSeconds({ time: patched.duration ?? element.duration });
	const seekSec =
		side === "right"
			? Math.max(newStartSec, newEndSec - frameSec)
			: newStartSec;

	return { patches, seekSec };
}

/**
 * Timeline move commit (the founder's "can't move clips left and right"):
 * one finished clip-body drag → ONE undoable UpdateElementsCommand.
 *
 * Free-position tracks (audio/overlay/text) slide the clip inside the gap
 * between its neighbors. The MAIN track is magnetic: the drop position only
 * decides the clip's ORDER (sorted by midpoint, CapCut reorder semantics),
 * then the whole track re-lays out butted from 0 — which also heals any
 * gaps left by earlier deletes.
 */
export function commitElementMove({
	editor,
	trackId,
	elementId,
	startSec,
}: {
	editor: EditorCore;
	trackId: string;
	elementId: string;
	startSec: number;
}): void {
	const tracks = editor.scenes.getActiveScene().tracks;
	const track = findTrackInSceneTracks({ tracks, trackId });
	const element = track?.elements.find((el) => el.id === elementId);
	const fps = editor.project.getActive().settings.fps;
	if (!track || !element) return;

	const candidate = mediaTime({
		ticks: roundFrameTicks({
			ticks: Math.max(0, mediaTimeFromSeconds({ seconds: startSec })),
			fps,
		}),
	});
	const isMainTrack = tracks.main.id === trackId;

	if (!isMainTrack) {
		const originalEnd = addMediaTime({ a: element.startTime, b: element.duration });
		let lower = ZERO_MEDIA_TIME;
		let upper: MediaTime | null = null;
		for (const other of track.elements) {
			if (other.id === elementId) continue;
			const otherEnd = addMediaTime({ a: other.startTime, b: other.duration });
			if (otherEnd <= element.startTime) lower = maxMediaTime({ a: lower, b: otherEnd });
			if (other.startTime >= originalEnd) {
				const maxStart = subMediaTime({ a: other.startTime, b: element.duration });
				upper = upper === null || maxStart < upper ? maxStart : upper;
			}
		}
		let next = candidate < lower ? lower : candidate;
		if (upper !== null && next > upper) next = maxMediaTime({ a: lower, b: upper });
		if (next === element.startTime) return;
		editor.command.execute({
			command: new UpdateElementsCommand({
				updates: [{ trackId, elementId, patch: { startTime: next } }],
			}),
		});
		return;
	}

	// Main track: order by midpoint with the dragged clip at its candidate
	// position, then re-butt sequentially from 0 (see commitRebuttedMain). The
	// dragged clip's key is nudged half a tick toward its drag direction so
	// an exact midpoint tie (equal-duration clips with the candidate clamped
	// at 0) resolves in the direction the user pulled instead of silently
	// keeping the old order.
	const dragBias = candidate < element.startTime ? -0.5 : 0.5;
	const ordered = [...track.elements].sort((a, b) => {
		const aMid =
			a.id === elementId
				? candidate + a.duration / 2 + dragBias
				: a.startTime + a.duration / 2;
		const bMid =
			b.id === elementId
				? candidate + b.duration / 2 + dragBias
				: b.startTime + b.duration / 2;
		return aMid - bMid;
	});
	commitRebuttedMain({ editor, orderedIds: ordered.map((el) => el.id) });
}

/**
 * Re-lays the main track out in `orderedIds` order, butted from 0, in ONE
 * undoable TracksSnapshotCommand — and, critically, REWRITES THE ELEMENT
 * ARRAY in that order. Everything downstream assumes `main.elements` is
 * time-sorted (transition squares pair array-adjacent clips, trim bounds
 * read index neighbors, clip virtualization windows by index) — a commit
 * that only patched startTimes left the array stale, which is exactly why
 * the transition square vanished after a reorder (founder, 2026-08-22:
 * it rendered at the OLD array-neighbor boundary, off the end of the
 * timeline). Bails on a stale order (id missing/extra — e.g. an edit
 * landed mid-drag) rather than guessing.
 */
function commitRebuttedMain({
	editor,
	orderedIds,
}: {
	editor: EditorCore;
	orderedIds: readonly string[];
}): void {
	const before = editor.scenes.getActiveScene().tracks;
	if (orderedIds.length !== before.main.elements.length) return;
	const byId = new Map(before.main.elements.map((el) => [el.id, el]));
	let cursor = ZERO_MEDIA_TIME;
	let changed = false;
	const rebutted: typeof before.main.elements = [];
	for (const [index, id] of orderedIds.entries()) {
		const el = byId.get(id);
		if (!el) return;
		if (before.main.elements[index]?.id !== id) changed = true;
		const next = el.startTime === cursor ? el : { ...el, startTime: cursor };
		if (next !== el) changed = true;
		cursor = addMediaTime({ a: cursor, b: el.duration });
		rebutted.push(next);
	}
	if (!changed) return;
	editor.command.execute({
		command: new TracksSnapshotCommand({
			before,
			after: { ...before, main: { ...before.main, elements: rebutted } },
		}),
	});
}

/**
 * Hold-to-reorder commit (CapCut's long-press mode: clips collapse to
 * uniform tiles, the held one lifts, drop decides its slot). The view
 * hands over the final tile order; this re-butts the main track to it in
 * ONE undoable command. Bails on a stale order (an id missing or extra —
 * e.g. an edit landed mid-drag) rather than guessing.
 */
export function commitMainTrackReorder({
	editor,
	trackId,
	orderedElementIds,
}: {
	editor: EditorCore;
	trackId: string;
	orderedElementIds: string[];
}): void {
	const tracks = editor.scenes.getActiveScene().tracks;
	if (tracks.main.id !== trackId) return;
	commitRebuttedMain({ editor, orderedIds: orderedElementIds });
}

/** Round 21.4 — caption text edited as a plain string (see
 *  caption-text.ts for the timing-preserving rewrite rules). One undoable
 *  UpdateElementsCommand per change, same as every style row. */
export function setCaptionText({
	editor,
	ref,
	words,
	text,
}: {
	editor: EditorCore;
	ref: ElementRef;
	words: readonly CaptionWord[];
	text: string;
}): void {
	editor.command.execute({
		command: new UpdateElementsCommand({
			updates: [
				{
					trackId: ref.trackId,
					elementId: ref.elementId,
					patch: { words: rewriteCaptionWords({ words, newText: text }) },
				},
			],
		}),
	});
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
/**
 * Set / replace / remove ("none") the main-track transition after a clip —
 * one undoable TransitionsSnapshotCommand per confirm, apply-to-all
 * included. Durations arrive in the sheet's seconds and are stored as ticks
 * (the engine's MediaTime); the placement math clamps at render/export time,
 * so an over-long duration is stored as asked and simply clamps live.
 */
export function setMainTrackTransition({
	editor,
	afterElementId,
	kind,
	durationSec,
	applyToAll,
}: {
	editor: EditorCore;
	afterElementId: string;
	kind: string;
	durationSec: number;
	applyToAll: boolean;
}): void {
	const before = editor.scenes.getActiveTransitions();
	const mainElements = [...editor.scenes.getActiveScene().tracks.main.elements]
		.filter((element) => !("hidden" in element && element.hidden))
		.sort((a, b) =>
			a.startTime !== b.startTime
				? a.startTime - b.startTime
				: a.id.localeCompare(b.id),
		);
	const targets = applyToAll
		? mainElements.slice(0, -1).map((element) => element.id)
		: [afterElementId];

	const byAfterId = new Map(before.map((t) => [t.afterElementId, t]));
	const durationTicks = mediaTimeFromSeconds({
		seconds: Math.max(1 / TICKS_PER_SECOND, durationSec),
	});
	for (const id of targets) {
		if (kind === "none") {
			byAfterId.delete(id);
		} else {
			byAfterId.set(id, {
				id: byAfterId.get(id)?.id ?? `transition-${id}`,
				afterElementId: id,
				kind,
				duration: durationTicks,
			});
		}
	}

	const after = [...byAfterId.values()];
	if (after.length === before.length && after.every((t, i) => t === before[i])) {
		return; // nothing changed — don't pollute the undo stack
	}
	editor.command.execute({
		command: new TransitionsSnapshotCommand({ before, after }),
	});
}

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

/**
 * Round 29 (founder: "overlay doesn't mean overlay shape, it means
 * overlay image or video — use the exact same mechanism"): the Overlay
 * panel's add button runs the SAME native import pipeline as the "+"
 * button (picker → custody → proxy → asset), then lands each pick as a
 * picture-in-picture clip: an existing overlay video track with room at
 * the playhead, else a FRESH overlay track (placement mode "newTrack" —
 * plain auto would land on the MAIN track whenever it has space there,
 * which is exactly not what "Overlay" means). Clips start at half scale
 * so they read as PiP over the main video; the preview-gesture/Overlay
 * panel's opacity+blend controls already work on them.
 */
export async function importAndPlaceOverlay({
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
		const startTime = editor.playback.getCurrentTime();
		const duration = mediaTimeFromSeconds({
			seconds: asset.duration || IMAGE_DEFAULT_DURATION_SEC,
		});
		const create = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration,
			startTime,
		});
		create.params = {
			...create.params,
			"transform.scaleX": 0.5,
			"transform.scaleY": 0.5,
		};
		const overlayEnd = addMediaTime({ a: startTime, b: duration });
		const freeOverlayTrack = editor.scenes
			.getActiveScene()
			.tracks.overlay.find(
				(track) =>
					track.type === "video" &&
					!track.elements.some(
						(el) =>
							el.startTime < overlayEnd &&
							addMediaTime({ a: el.startTime, b: el.duration }) > startTime,
					),
			);
		editor.command.execute({
			command: new InsertElementCommand({
				element: create,
				placement: freeOverlayTrack
					? { mode: "explicit", trackId: freeOverlayTrack.id }
					: { mode: "newTrack", trackType: "video" },
			}),
		});
	}
	return imported.length;
}

/**
 * Round 22 (founder: "there needs to be audio import option when u tap
 * audio in menu where it opens up files picker. then puts it in audio
 * track"): Files-picker audio import — native UIDocumentPicker via the
 * same pickMedia bridge (kinds:["audio"]), custody-copied + probed like
 * every other import, then placed on an audio track at the playhead.
 */
export async function importAndPlaceAudio({
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
		kinds: ["audio"],
		allowMultiple: true,
		onProgress,
	});
	for (const asset of imported) {
		const create = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: "audio",
			name: asset.name,
			duration: mediaTimeFromSeconds({ seconds: asset.duration || 1 }),
			startTime: editor.playback.getCurrentTime(),
		});
		editor.command.execute({
			command: new InsertElementCommand({ element: create, placement: { mode: "auto", trackType: "audio" } }),
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
		// Custody identities — the EDL asset resolver
		// (buildNativeEdlAssetResolver) reads these; dropping them here
		// starved the resolver and re-broke export (caught 2026-08-20).
		nativeRelativePath: asset.nativeRelativePath,
		sourceNativeRelativePath: asset.sourceNativeRelativePath,
		sourceRotationDegrees: asset.sourceRotationDegrees,
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
		// SYNCHRONOUS, first thing in the gesture stack — the iOS WebAudio
		// unlock ritual (see AudioManager.unlock). The engine's own resume
		// runs after async hops and can miss gesture affinity on device.
		editor.audio.unlock();
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

// ------------------------------ cut dead space ------------------------------

export type DeadSpaceCutOutcome =
	| { status: "cut"; pieces: number; removedSec: number }
	| { status: "refused"; reason: DeadSpaceRefusal }
	| { status: "no-source" }
	| { status: "decode-failed" };

/** Resolves the bytes to analyse for a clip, or null when it has no audio. */
function resolveDeadSpaceSource({
	editor,
	element,
}: {
	editor: EditorCore;
	element: TimelineElement;
}): { sourceKey: string; file: File | null; url: string | null; durationSec?: number } | null {
	if (element.type === "audio" && element.sourceType === "library") {
		return { sourceKey: `library:${element.sourceUrl}`, file: null, url: element.sourceUrl };
	}
	if (element.type !== "video" && element.type !== "audio") return null;
	const asset = editor.media.getAssets().find((candidate) => candidate.id === element.mediaId);
	if (!asset) return null;
	// `hasAudio` is only trustworthy when explicitly false — assets imported
	// before the flag existed leave it undefined, and refusing those would
	// disable the button on a user's whole existing library.
	if (asset.hasAudio === false) return null;
	return {
		sourceKey: `media:${asset.id}`,
		file: asset.file ?? null,
		url: asset.url ?? null,
		durationSec: asset.duration,
	};
}

/**
 * "Cut gaps" (founder, 2026-08-25: "add a button so that when i select a
 * clip i can cut all deadspace without speech or any significant audio …
 * the clips that it makes should be concatenated but not connected").
 *
 * Measures the clip's own audio (`media/dead-space.ts`), turns the kept
 * spans into butted-but-separate elements (`timeline/dead-space-cut.ts`),
 * and swaps the whole thing in as ONE `TracksSnapshotCommand` so a single
 * undo puts the clip back however many pieces it became.
 *
 * The main track re-butts end to end afterwards — same magnetic rule as
 * `deleteSelected`, since removing dead space IS a delete and the founder's
 * "the 2 clips don't snap together" complaint applies identically here.
 * Free-position tracks (overlay/audio) keep their own place: the pieces
 * start where the clip started and the rest of that track doesn't move.
 *
 * Every refusal path leaves the timeline untouched and says why — a button
 * that shreds a music bed because it found no speech in it is worse than a
 * button that declines.
 */
export async function cutDeadSpace({
	editor,
	ref,
	onProgress,
	options,
}: {
	editor: EditorCore;
	ref: ElementRef;
	onProgress?: (progress: { fraction: number | null }) => void;
	options?: Partial<DeadSpaceOptions>;
}): Promise<DeadSpaceCutOutcome> {
	const element = getElement({ editor, ref });
	if (!element) return { status: "no-source" };
	const source = resolveDeadSpaceSource({ editor, element });
	if (!source) return { status: "no-source" };

	let features: FrameFeatures;
	try {
		features = await getSourceDeadSpaceFeatures({
			sourceKey: source.sourceKey,
			file: source.file,
			url: source.url,
			durationSecHint: source.durationSec,
			onProgress,
		});
	} catch (error) {
		console.warn("[kneecap-dead-space] analysis failed:", error);
		return { status: "decode-failed" };
	}

	const retime = "retime" in element ? element.retime : undefined;
	const windowStartSec = mediaTimeToSeconds({ time: element.trimStart });
	const analysis = detectDeadSpace({
		features,
		// Measure the clip's VISIBLE source window only — a floor taken from
		// material this clip doesn't show would set the gate for footage
		// nobody sees.
		window: {
			startSec: windowStartSec,
			endSec:
				windowStartSec +
				getSourceSpanAtClipTime({
					clipTime: mediaTimeToSeconds({ time: element.duration }),
					retime,
				}),
		},
		options: { ...DEFAULT_DEAD_SPACE_OPTIONS, ...options },
	});
	if (analysis.refusal) return { status: "refused", reason: analysis.refusal };

	const pieces = planDeadSpaceCut({
		element,
		segments: analysis.segments,
		fps: editor.project.getActive().settings.fps,
	});
	if (pieces.length === 0) {
		return { status: "refused", reason: "would-remove-everything" };
	}

	const before = editor.scenes.getActiveScene().tracks;
	editor.command.execute({
		command: new TracksSnapshotCommand({
			before,
			after: applyDeadSpaceCutToTracks({ tracks: before, ref, pieces }),
		}),
	});
	editor.selection.setSelectedElements({
		elements: [{ trackId: ref.trackId, elementId: pieces[0].id }],
	});

	return {
		status: "cut",
		pieces: pieces.length,
		removedSec: analysis.removedSec,
	};
}

// -------------------------------- keyframes ---------------------------------
// Round 47 (founder: "i want to add keyframes"). The CapCut-mobile diamond
// over the engine's per-property keyframe commands — see editor/keyframes.ts
// for the group model. Every mutation below is one undo step: the engine
// batches a multi-path upsert/removal into a single BatchCommand, and easing
// goes through one UpdateElementsCommand.

/** Half a frame: "the playhead is on this keyframe" tolerance. A scrubbed
 *  playhead lands on arbitrary ticks; the frame is the unit CapCut counts
 *  in, and every keyframe this UI writes sits on the frame grid. */
function keyframeToleranceTicks({ editor }: { editor: EditorCore }): number {
	return frameTicksFor({ fps: editor.project.getActive().settings.fps }) / 2;
}

export interface ClipKeyframeState {
	/** Every keyframe on the clip, clip-local ticks, ascending. */
	times: MediaTime[];
	/** The playhead as a clip-local, frame-snapped time. */
	localTime: MediaTime;
	/** The keyframe the playhead is on (± half a frame), else null. */
	onKeyframeTime: MediaTime | null;
	previousTime: MediaTime | null;
	nextTime: MediaTime | null;
	/** The keyframe whose outgoing segment the playhead is inside of — what
	 *  the Graph sheet edits. Null with fewer than two keyframes. */
	segmentTime: MediaTime | null;
}

/** Everything the diamond control and the Graph sheet render from, computed
 *  off the live playhead. Pure read; safe to call during render. */
export function readClipKeyframeState({
	editor,
	ref,
	element = getElement({ editor, ref }),
}: {
	editor: EditorCore;
	ref: ElementRef;
	element?: TimelineElement | null;
}): ClipKeyframeState | null {
	if (!element) return null;
	const fps = editor.project.getActive().settings.fps;
	const toleranceTicks = frameTicksFor({ fps }) / 2;
	const localTime = snapLocalTimeToFrame({
		localTime: clipLocalTime({ element, timelineTime: editor.playback.getCurrentTime() }),
		fps,
		duration: element.duration,
	});
	const times = getClipKeyframeTimes({ animations: element.animations });
	return {
		times,
		localTime,
		onKeyframeTime: findClipKeyframeAtTime({ times, time: localTime, toleranceTicks }),
		previousTime: adjacentClipKeyframeTime({ times, time: localTime, direction: "previous", toleranceTicks }),
		nextTime: adjacentClipKeyframeTime({ times, time: localTime, direction: "next", toleranceTicks }),
		segmentTime: segmentKeyframeTimeAt({ times, time: localTime, toleranceTicks }),
	};
}

/** The diamond tap: on a keyframe → remove it (every group path keyed at
 *  that time; the engine persists the value-at-playhead to the base params
 *  when a channel empties, so nothing visibly jumps); otherwise → add one
 *  holding the clip's current position/scale/rotation/opacity. */
export function toggleClipKeyframeAtPlayhead({
	editor,
	ref,
}: {
	editor: EditorCore;
	ref: ElementRef;
}): "added" | "removed" | null {
	const element = getElement({ editor, ref });
	if (!element) return null;
	const state = readClipKeyframeState({ editor, ref, element });
	if (!state) return null;
	if (state.onKeyframeTime !== null) {
		const removals = buildClipKeyframeRemovals({ ref, element, time: state.onKeyframeTime });
		if (removals.length === 0) return null;
		editor.timeline.removeKeyframes({ keyframes: removals });
		return "removed";
	}
	editor.timeline.upsertKeyframes({
		keyframes: buildClipKeyframeUpserts({ ref, element, localTime: state.localTime }),
	});
	return "added";
}

/** ‹ › arrows: seek the playhead to the neighbouring keyframe. Returns
 *  false when there is none in that direction. */
export function seekToClipKeyframe({
	editor,
	ref,
	direction,
}: {
	editor: EditorCore;
	ref: ElementRef;
	direction: "previous" | "next";
}): boolean {
	const element = getElement({ editor, ref });
	if (!element) return false;
	const state = readClipKeyframeState({ editor, ref, element });
	const target = direction === "previous" ? state?.previousTime : state?.nextTime;
	if (target === null || target === undefined) return false;
	seekToClipKeyframeTime({ editor, ref, time: target });
	return true;
}

/** Tap on a diamond drawn on the clip: land the playhead exactly on it. */
export function seekToClipKeyframeTime({
	editor,
	ref,
	time,
}: {
	editor: EditorCore;
	ref: ElementRef;
	time: MediaTime;
}): void {
	const element = getElement({ editor, ref });
	if (!element) return;
	editor.playback.seek({ time: mediaTime({ ticks: element.startTime + time }) });
}

/** Graph sheet: set how the value travels from the keyframe at `time` to the
 *  next one, on every keyed group path, as ONE undoable command. Returns
 *  false when nothing changed (no keyframe there, or it is the last one). */
export function setClipKeyframeEasing({
	editor,
	ref,
	time,
	easing,
}: {
	editor: EditorCore;
	ref: ElementRef;
	time: MediaTime;
	easing: ClipKeyframeEasing;
}): boolean {
	const element = getElement({ editor, ref });
	if (!element) return false;
	const animations = applyClipKeyframeEasing({ animations: element.animations, time, easing });
	if (animations === element.animations) return false;
	editor.timeline.updateElements({
		updates: [{ trackId: ref.trackId, elementId: ref.elementId, patch: { animations } }],
	});
	return true;
}

/** Panel sliders for a group property (opacity today): once the clip has
 *  keyframes, a change writes a keyframe at the playhead — CapCut's
 *  auto-add — instead of the base param the animation would override
 *  anyway. Un-keyed clips take the plain param write. Each slider tick is
 *  one command either way, same as `setElementParam` already is. */
export function setVisualParamKeyframeAware({
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
	if (isClipKeyframePath(key) && typeof value === "number" && hasClipKeyframes({ animations: element.animations })) {
		const state = readClipKeyframeState({ editor, ref, element });
		if (!state) return;
		editor.timeline.upsertKeyframes({
			keyframes: buildClipKeyframeUpserts({
				ref,
				element,
				localTime: state.localTime,
				overrides: { [key]: value },
			}),
		});
		return;
	}
	setElementParam({ editor, ref, key, value });
}

export { hasClipKeyframes };
