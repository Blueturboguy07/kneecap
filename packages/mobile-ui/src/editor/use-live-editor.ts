import { useEditor } from "@kneecap/editor-core/react";
import { mediaTimeToSeconds, type EditorCore } from "@kneecap/editor-core";
import type { ElementRef, TimelineElement } from "@kneecap/editor-core/timeline";
import { findTrackInSceneTracks, calculateTotalDuration } from "@kneecap/editor-core/timeline";

/** Live `EditorCore` instance, re-rendering the caller on ANY manager
 *  change (selection, timeline, playback, project...). Every M8 panel
 *  component uses this instead of holding its own copy of engine state. */
export function useLiveEditor(): EditorCore {
	return useEditor();
}

/** Live selected element refs — empty array when nothing is selected. */
export function useSelectedElementRefs(): ElementRef[] {
	return useEditor((editor) => editor.selection.getSelectedElements());
}

/** Live single selected element (first ref only — M8 panels operate on a
 *  single selection; multi-select bulk edit is out of scope), or null.
 *
 *  Returns a TUPLE, not an object: `useEditor`'s snapshot cache only
 *  special-cases arrays for its `isShallowEqual` check (see its own header
 *  comment) — a freshly-allocated object literal would compare unequal to
 *  itself on every call and defeat `useSyncExternalStore`'s "getSnapshot
 *  must be stable when nothing changed" contract, which can manifest as an
 *  infinite re-render loop. `ref`/`element` are themselves the underlying
 *  manager's own object references (not copies), so the per-slot
 *  `Object.is` check inside the array comparison holds when neither
 *  actually changed. */
export function useSelectedElement(): readonly [ElementRef, TimelineElement] | readonly [null, null] {
	return useEditor((editor) => {
		const refs = editor.selection.getSelectedElements();
		const ref = refs[0];
		if (!ref) return [null, null] as const;
		const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!tracks) return [null, null] as const;
		const track = findTrackInSceneTracks({ tracks, trackId: ref.trackId });
		const element = track?.elements.find((el) => el.id === ref.elementId);
		return element ? ([ref, element] as const) : ([null, null] as const);
	});
}

/** `PlaybackManager.getCurrentTime()` returns integer-tick `MediaTime`
 *  (plan §2.2: "never float seconds" across the EDL bridge) — converted to
 *  seconds ONLY here, at the UI-display boundary, via the real
 *  `mediaTimeToSeconds` wasm-backed helper, never by treating ticks as
 *  seconds directly. */
export function useCurrentTimeSeconds(): number {
	return useEditor((editor) => mediaTimeToSeconds({ time: editor.playback.getCurrentTime() }));
}

export function useIsPlaying(): boolean {
	return useEditor((editor) => editor.playback.getIsPlaying());
}

/** Live total scene duration in seconds, for the playback bar's "/ mm:ss". */
export function useProjectDurationSeconds(): number {
	return useEditor((editor) => {
		const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!tracks) return 0;
		return mediaTimeToSeconds({ time: calculateTotalDuration({ tracks }) });
	});
}
