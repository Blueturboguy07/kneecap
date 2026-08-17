/**
 * Pure pixel<->time math for the CapCut-mobile timeline. Kept dependency-
 * free and unit-tested directly (src/__tests__/timeline-time-scale.test.ts)
 * because every rendering/virtualization/snap decision downstream is only
 * as correct as this file.
 */

/** Pixels-per-second at zoom level 1.0. Not a CapCut measurement — corpus
 *  06/05 give no absolute pixel-density figure, only relative ("pinch to
 *  zoom for smoother trimming"). Chosen so a 5s clip is comfortably
 *  tappable (300px) at the default zoom. */
export const BASE_PIXELS_PER_SECOND = 60;

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 12;

export function pixelsPerSecondForZoom({ zoom }: { zoom: number }): number {
	return BASE_PIXELS_PER_SECOND * zoom;
}

export function timeToPixels({
	timeSec,
	pixelsPerSecond,
}: {
	timeSec: number;
	pixelsPerSecond: number;
}): number {
	return timeSec * pixelsPerSecond;
}

export function pixelsToTime({
	px,
	pixelsPerSecond,
}: {
	px: number;
	pixelsPerSecond: number;
}): number {
	if (pixelsPerSecond <= 0) return 0;
	return px / pixelsPerSecond;
}

export function clampZoom({
	zoom,
	min = MIN_ZOOM,
	max = MAX_ZOOM,
}: {
	zoom: number;
	min?: number;
	max?: number;
}): number {
	return Math.min(max, Math.max(min, zoom));
}

export function clampTime({
	timeSec,
	durationSec,
}: {
	timeSec: number;
	durationSec: number;
}): number {
	return Math.min(durationSec, Math.max(0, timeSec));
}

/**
 * The minimum zoom that still fits the whole project in `viewportWidthPx`
 * without going below MIN_ZOOM — mirrors the intent of the existing desktop
 * timeline's `getTimelineZoomMin` (apps/web/src/timeline) without importing
 * it (this package cannot depend on apps/web).
 */
export function fitZoom({
	durationSec,
	viewportWidthPx,
}: {
	durationSec: number;
	viewportWidthPx: number;
}): number {
	if (durationSec <= 0 || viewportWidthPx <= 0) return 1;
	const zoom = viewportWidthPx / (durationSec * BASE_PIXELS_PER_SECOND);
	return clampZoom({ zoom });
}
