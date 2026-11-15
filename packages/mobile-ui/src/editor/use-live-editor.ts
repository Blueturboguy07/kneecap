import { useCallback, useSyncExternalStore } from "react";
import { useEditor } from "@kneecap/editor-core/react";
import { mediaTimeToSeconds, type EditorCore, type TProjectSettings } from "@kneecap/editor-core";
import type { ElementRef, TimelineElement } from "@kneecap/editor-core/timeline";
import { findTrackInSceneTracks, calculateTotalDuration } from "@kneecap/editor-core/timeline";

/** The `EditorCore` instance. NOTE: `useEditor()` without a selector does
 *  NOT subscribe to anything, so this alone never re-renders the caller.
 *  A component that shows engine state must also read it through a
 *  selector hook (`useEditor(selector)` or one of the hooks below). */
export function useLiveEditor(): EditorCore {
	return useEditor();
}

/** Live settings of the open project (canvas size, background, fps), or null
 *  when no project is open. `UpdateProjectSettingsCommand` makes a new
 *  settings object on each change (export sheet resolution, Aspect ratio,
 *  Background), so the caller re-renders after each one (blind test round 3,
 *  item 3: the top-bar resolution chip stayed at "1080p" after the export
 *  sheet set 720p, because nothing re-rendered the editor shell). */
export function useProjectSettings(): TProjectSettings | null {
	return useEditor((editor) => editor.project.getActiveOrNull()?.settings ?? null);
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
	const editor = useEditor();
	// PlaybackManager splits its channels: `subscribe` (what `useEditor`
	// rides) fires on play/pause/seek ONLY, while per-frame time during
	// playback goes out on `onUpdate`. A selector on `subscribe` alone
	// freezes for the whole duration of playback — on device that read as
	// "the timecode and timeline don't track the video" (2026-08-19).
	return useSyncExternalStore(
		useCallback(
			(onStoreChange) => {
				const unsubscribe = editor.playback.subscribe(onStoreChange);
				const unsubscribeUpdate = editor.playback.onUpdate(onStoreChange);
				const unsubscribeSeek = editor.playback.onSeek(onStoreChange);
				return () => {
					unsubscribe();
					unsubscribeUpdate();
					unsubscribeSeek();
				};
			},
			[editor],
		),
		() => mediaTimeToSeconds({ time: editor.playback.getCurrentTime() }),
		// Server snapshot for apps/web's prerendered dev harness routes —
		// there is no live playback clock during SSR; hydration re-reads the
		// client snapshot immediately.
		() => 0,
	);
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

/** Live main-track transitions of the active scene (engine-backed; stable
 *  empty array when none — see ScenesManager.getActiveTransitions). */
export function useSceneTransitions() {
	return useEditor((editor) => editor.scenes.getActiveTransitions());
}
