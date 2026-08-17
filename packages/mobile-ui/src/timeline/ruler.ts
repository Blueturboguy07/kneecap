/**
 * Ruler tick-interval selection — pure, unit-tested. A simplified sibling
 * of apps/web/src/timeline/ruler-utils.ts's `getRulerConfig` (not imported:
 * this package can't depend on apps/web), scaled down to the mobile
 * ruler's single-row tabular-timecode design (corpus 04 §2: "ruler +
 * playhead" as one thin row, not desktop's separate label/tick density
 * split).
 */

const CANDIDATE_INTERVALS_SEC = [
	0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600,
] as const;

const MIN_TICK_SPACING_PX = 48;

export function rulerTickIntervalSec({
	pixelsPerSecond,
}: {
	pixelsPerSecond: number;
}): number {
	for (const interval of CANDIDATE_INTERVALS_SEC) {
		if (interval * pixelsPerSecond >= MIN_TICK_SPACING_PX) return interval;
	}
	return CANDIDATE_INTERVALS_SEC[CANDIDATE_INTERVALS_SEC.length - 1];
}

export function formatRulerTimecode({ timeSec }: { timeSec: number }): string {
	const totalSeconds = Math.max(0, Math.round(timeSec));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const mm = minutes.toString().padStart(2, "0");
	const ss = seconds.toString().padStart(2, "0");
	return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Every tick time from 0..durationSec at `intervalSec` spacing. */
export function rulerTicks({
	durationSec,
	intervalSec,
}: {
	durationSec: number;
	intervalSec: number;
}): number[] {
	if (intervalSec <= 0) return [0];
	const ticks: number[] = [];
	for (let t = 0; t <= durationSec + 1e-6; t += intervalSec) {
		ticks.push(Math.round(t * 1000) / 1000);
	}
	return ticks;
}
