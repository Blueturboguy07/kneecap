/**
 * View-model types for the CapCut-mobile timeline (plan M7). These are
 * deliberately NOT `EdlClip`/`EdlTrack` (packages/editor-core/src/edl/types.ts)
 * and NOT the engine's own `TimelineTrack`/`TimelineElement`
 * (apps/web/src/timeline) — this package must type-check standalone with no
 * dependency on either (see tsconfig.json's `@/*`-scoped-to-src comment,
 * same rule editor-core and native-bridge already follow).
 *
 * A consuming app (apps/web today; apps/mobile's Vite shell eventually) is
 * responsible for mapping its real editor state into this shape. The dev
 * harness at apps/web/src/app/dev/mobile-timeline/page.tsx does this with
 * SYNTHETIC data (packages/mobile-ui/src/timeline/mock-data.ts) — mapping
 * from the real `EditorCore`/`useEditor()` scene graph to this view-model is
 * NOT done this session (see that page's header comment and the M7 handoff).
 *
 * Time fields here are float SECONDS, not integer ticks. This is UI-only
 * layout/interaction math (pixel positions, scroll offsets, drag deltas) —
 * it never crosses the EDL bridge (packages/editor-core/src/edl/types.ts),
 * where the "integer ticks + rational frame rate, never float seconds" rule
 * is a checked invariant (`validateEdl`). A real integration maps a
 * `MediaTime`/tick value to this view-model's `startSec`/`durationSec` at
 * the boundary, once, the same way the existing apps/web/src/timeline
 * desktop UI already does (it also uses float seconds internally, e.g.
 * `timeline/pixel-utils.ts`).
 */

export type TimelineTrackKind = "main" | "overlay" | "text" | "sticker" | "audio" | "caption";

export type TimelineClipKind =
	| "video"
	| "image"
	| "audio"
	| "text"
	| "sticker"
	/** Founder capture 2026-08-18: caption clips render as ORANGE blocks in
	 *  CapCut (capture-editor-toolbar-start.png), visually distinct from
	 *  text clips — a dedicated kind, not a text-shaped stand-in. */
	| "caption";

export interface TimelineKeyframeVM {
	id: string;
	/** Seconds relative to the CLIP's own start (matches EdlKeyframe's convention). */
	timeSec: number;
}

export interface TimelineClipVM {
	id: string;
	trackId: string;
	kind: TimelineClipKind;
	name: string;
	/** Seconds from timeline origin. */
	startSec: number;
	durationSec: number;
	/**
	 * A stable per-clip color, used for the color bar under filmstrip
	 * thumbnails / behind the waveform, and for the placeholder thumbnail
	 * pattern (see filmstrip-thumbnail.tsx) — NOT a CapCut-measured token,
	 * a view-model convenience so different source clips are visually
	 * distinguishable in the harness/tests.
	 */
	colorHue: number;
	/**
	 * Real per-frame thumbnail URIs, keyed by the frame's clip-relative
	 * second (rounded to the density the caller decided to generate).
	 * `undefined` (the harness's synthetic clips) falls back to the
	 * generated placeholder pattern in filmstrip-thumbnail.tsx — plan M4
	 * (native thumbnail-strip generation) is not built yet, so no
	 * consumer of this package has real entries to put here today.
	 */
	thumbnails?: Record<number, string>;
	/** Audio-only: amplitude samples 0..1 across the clip's SOURCE duration. */
	waveformPeaks?: number[];
	keyframes?: TimelineKeyframeVM[];
}

export interface TimelineTrackVM {
	id: string;
	kind: TimelineTrackKind;
	name: string;
	clips: TimelineClipVM[];
	muted?: boolean;
	hidden?: boolean;
}

export interface TimelineProjectVM {
	tracks: TimelineTrackVM[];
	durationSec: number;
	fps: number;
}
