/**
 * Virtualization windowing — pure functions, unit-tested
 * (src/__tests__/timeline-virtualization.test.ts). This is the mechanism
 * behind plan M7 item 8 ("only render clips/thumbnails within the visible
 * window plus a small overscan") and the 60fps exit criterion: on a 20-clip
 * project this barely matters, but the same functions must hold at the
 * exit criterion's "10-minute project" scale where a filmstrip could
 * otherwise want thousands of thumbnail DOM nodes.
 */

import type { TimelineClipVM } from "./types";

/**
 * Which clips (by index into `clips`) intersect the visible time window,
 * plus a small overscan on each side. Assumes `clips` is sorted ascending
 * by `startSec` (true for every track this package renders — the mock data
 * generator and every real track model both maintain that invariant) and
 * uses that to break out early instead of scanning the whole array.
 */
export function visibleClipIndices({
	clips,
	viewStartSec,
	viewEndSec,
	overscanSec,
}: {
	clips: readonly TimelineClipVM[];
	viewStartSec: number;
	viewEndSec: number;
	overscanSec: number;
}): { startIndex: number; endIndex: number } {
	const lo = viewStartSec - overscanSec;
	const hi = viewEndSec + overscanSec;

	let startIndex = clips.length;
	let endIndex = -1;

	for (let i = 0; i < clips.length; i++) {
		const clip = clips[i];
		const clipEnd = clip.startSec + clip.durationSec;
		if (clipEnd < lo) continue; // ends before window — not visible yet
		if (clip.startSec > hi) break; // sorted ascending: everything after is further out
		if (startIndex === clips.length) startIndex = i;
		endIndex = i;
	}

	if (endIndex === -1) return { startIndex: 0, endIndex: -1 }; // empty range
	return { startIndex, endIndex };
}

/**
 * Which filmstrip thumbnail "slots" (clip-relative seconds, spaced
 * `slotIntervalSec` apart) intersect the visible pixel window of a single
 * clip. Used so a very long clip at low zoom renders one thumbnail every
 * N pixels instead of one per generated frame, and so a very long clip
 * scrolled mostly off-screen only renders the handful of slots still
 * on-screen.
 */
export function visibleThumbnailSlots({
	clipDurationSec,
	slotIntervalSec,
	clipVisibleStartSec,
	clipVisibleEndSec,
}: {
	clipDurationSec: number;
	slotIntervalSec: number;
	/** Clip-relative seconds — already clamped to [0, clipDurationSec] by the caller. */
	clipVisibleStartSec: number;
	clipVisibleEndSec: number;
}): number[] {
	if (slotIntervalSec <= 0 || clipDurationSec <= 0) return [0];

	const firstSlot = Math.max(
		0,
		Math.floor(clipVisibleStartSec / slotIntervalSec) * slotIntervalSec,
	);
	const lastSlot = Math.min(
		Math.floor(clipDurationSec / slotIntervalSec) * slotIntervalSec,
		Math.ceil(clipVisibleEndSec / slotIntervalSec) * slotIntervalSec,
	);

	const slots: number[] = [];
	for (let t = firstSlot; t <= lastSlot; t += slotIntervalSec) {
		slots.push(Math.round(t * 1000) / 1000); // avoid float-accumulation drift in keys
	}
	return slots.length > 0 ? slots : [0];
}

/**
 * How far apart (in clip-relative seconds) filmstrip thumbnails should be
 * generated, given the current pixels-per-second and a target on-screen
 * thumbnail width. Density steps with zoom (plan M7 item 3) without
 * recomputing on every pixel of pan — callers only need to recompute this
 * when `pixelsPerSecond` crosses a step, which `Math.max` below encourages
 * by snapping to round widths.
 */
export function thumbnailSlotIntervalSec({
	pixelsPerSecond,
	targetThumbWidthPx,
}: {
	pixelsPerSecond: number;
	targetThumbWidthPx: number;
}): number {
	if (pixelsPerSecond <= 0) return 1;
	return Math.max(targetThumbWidthPx / pixelsPerSecond, 1 / 30);
}
