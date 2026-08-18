/**
 * Fixer pass: maps the REAL `EditorCore` scene graph
 * (`editor.scenes.getActiveSceneOrNull()?.tracks`, a `SceneTracks` of
 * `main`/`overlay[]`/`audio[]` `TimelineTrack`s) into M7's
 * `TimelineProjectVM` view-model, so `TimelineView` can be mounted against
 * live project state instead of only `mock-data.ts`'s synthetic stress
 * project.
 *
 * This closes the "never imported/mounted, never sees real EditorCore
 * state" gap. It does NOT close the separate, pre-existing gap disclosed in
 * timeline-view.tsx's own `handleTrimCommit` comment and the M7 handoff
 * notes: trim/reorder gestures still don't write back through editor-core's
 * resize/move commands from inside `TimelineView` itself. That's real
 * follow-on wiring work (each gesture needs its own command call, the same
 * way `packages/mobile-ui/src/editor/actions.ts` wires panel buttons to
 * commands), left for a dedicated M7-completion pass rather than papered
 * over here.
 *
 * Time rule: every field read off an element/track here is a `MediaTime`
 * (integer ticks) converted to float seconds exactly once, at this
 * UI-boundary mapping — never treated as seconds before that conversion.
 *
 * Snapshot-caching rule (real bug hit and fixed during this pass): the
 * first version of this hook returned a freshly-allocated `{tracks,
 * durationSec, fps}` object literal directly from a `useEditor(selector)`
 * call. `useEditor`'s own `isShallowEqual` cache (packages/editor-core/
 * react/use-editor.ts) only special-cases ARRAYS — a plain object always
 * compares unequal to its own previous snapshot by `Object.is`, so
 * `getSnapshot()` never hit the cache and `useSyncExternalStore` re-fired
 * on every render, which re-triggered a re-render, forever. Reproduced
 * live: React logged "The result of getSnapshot should be cached" followed
 * by "Maximum update depth exceeded," and `/dev/mobile-editor` rendered
 * only a client-side-exception error boundary — this file's OWN doc-header
 * intent (mount `TimelineView` against live state) was fully broken by
 * this bug, not just degraded. Same failure mode `use-live-editor.ts`'s
 * `useSelectedElement` doc comment already warns about, for the identical
 * reason. Fixed by pulling only REFERENTIALLY STABLE values out of
 * `useEditor` (the manager's own `tracks`/`fps` objects, which the engine
 * only replaces on an actual mutation — `Object.is` correctly detects "no
 * change" on those) and doing the object-literal mapping in a local
 * `useMemo` keyed on those stable references instead, so the mapping only
 * re-runs when something real changed.
 */
import { useMemo } from "react";
import { useEditor } from "@kneecap/editor-core/react";
import { mediaTimeToSeconds } from "@kneecap/editor-core/wasm";
import { calculateTotalDuration } from "@kneecap/editor-core/timeline";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@kneecap/editor-core/timeline";
import type { FrameRate } from "opencut-wasm";
import type {
	TimelineClipKind,
	TimelineClipVM,
	TimelineProjectVM,
	TimelineTrackKind,
	TimelineTrackVM,
} from "../timeline/types";

/** `rate.numerator / rate.denominator` — the exact same one-line
 *  computation as editor-core's own `frameRateToFloat` (packages/editor-core
 *  /src/fps/utils.ts), inlined here rather than deep-imported through a
 *  package-exports wildcard subpath (`@kneecap/editor-core/fps/utils`) that
 *  this package's `tsc --noEmit` could not resolve (`TS2307`) even though
 *  the exports map's `"./*"` catch-all resolves it correctly at the
 *  bundler/runtime level — a real, narrow gap between this package's type
 *  program and its build-time resolver, not worth widening scope to fix
 *  generally in this pass. UI-boundary use only (the timeline's DISPLAYED
 *  fps readout), same "never cross the EDL bridge as a float" rule as
 *  everywhere else in this file. */
function frameRateToFloatInline(rate: FrameRate): number {
	return rate.numerator / rate.denominator;
}

/** Stable per-id hash so a given real element always gets the same
 *  placeholder color bar across re-renders (no `Math.random()`). */
function colorHueForId(id: string): number {
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
	}
	return hash % 360;
}

function clipKindForElement(element: TimelineElement): TimelineClipKind {
	switch (element.type) {
		case "video":
			return "video";
		case "image":
			return "image";
		case "audio":
			return "audio";
		case "text":
			return "text";
		case "sticker":
			return "sticker";
		case "graphic":
			// Closest visual family to a single non-media shape/effect node —
			// `TimelineClipVM` has no dedicated "graphic" kind.
			return "sticker";
		case "caption":
			// Founder capture 2026-08-18: captions are orange blocks in CapCut,
			// not text-styled clips — dedicated kind + CSS class.
			return "caption";
		default:
			return "text";
	}
}

function trackKindFor({ track, isMain }: { track: TimelineTrack; isMain: boolean }): TimelineTrackKind {
	if (isMain) return "main";
	switch (track.type) {
		case "video":
			return "overlay";
		case "text":
			return "text";
		case "audio":
			return "audio";
		case "graphic":
			return "sticker";
		case "effect":
			return "overlay";
		case "caption":
			return "caption";
		default:
			return "overlay";
	}
}

function mapTrack({ track, isMain }: { track: TimelineTrack; isMain: boolean }): TimelineTrackVM {
	const clips: TimelineClipVM[] = track.elements.map((element) => ({
		id: element.id,
		trackId: track.id,
		kind: clipKindForElement(element),
		name: element.name,
		startSec: mediaTimeToSeconds({ time: element.startTime }),
		durationSec: mediaTimeToSeconds({ time: element.duration }),
		colorHue: colorHueForId(element.id),
	}));
	return {
		id: track.id,
		kind: trackKindFor({ track, isMain }),
		name: track.name,
		clips,
		muted: "muted" in track ? track.muted : undefined,
		hidden: "hidden" in track ? track.hidden : undefined,
	};
}

/** Live `TimelineProjectVM` built from the real active scene/project, or
 *  `null` before a project exists yet. */
export function useTimelineProjectVM(): TimelineProjectVM | null {
	// Referentially stable reads only — see this file's header re: why the
	// object-literal MAPPING must not happen inside the `useEditor` selector
	// itself.
	const tracks = useEditor(
		(editor): SceneTracks | null => editor.scenes.getActiveSceneOrNull()?.tracks ?? null,
	);
	const fps = useEditor(
		(editor): FrameRate | null => editor.project.getActiveOrNull()?.settings.fps ?? null,
	);

	return useMemo(() => {
		if (!tracks || !fps) return null;

		const trackVMs: TimelineTrackVM[] = [
			mapTrack({ track: tracks.main, isMain: true }),
			...tracks.overlay.map((track) => mapTrack({ track, isMain: false })),
			...tracks.audio.map((track) => mapTrack({ track, isMain: false })),
		];

		return {
			tracks: trackVMs,
			durationSec: mediaTimeToSeconds({ time: calculateTotalDuration({ tracks }) }),
			fps: frameRateToFloatInline(fps),
		};
	}, [tracks, fps]);
}
