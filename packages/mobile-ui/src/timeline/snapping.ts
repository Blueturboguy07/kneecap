/**
 * Magnetic snapping (plan M7 item 5 / M5 item 3 / corpus 05 §3a). Anchor
 * set: other clip edges (across all tracks — the CapCut-specific sources
 * confirm clip-to-clip and clip-to-project-bounds; clip-to-playhead is
 * carried in per corpus 05's own "Medium confidence, architecturally
 * standard" read, §3a), the playhead, and the timeline start/end bounds.
 * Pure + unit-tested (src/__tests__/timeline-snapping.test.ts); the
 * pointer-drag hooks that call this own the haptic-tick side effect.
 */

export interface SnapTarget {
	timeSec: number;
	/** For debugging/testing which anchor won; not rendered. */
	source: "clip-edge" | "playhead" | "bounds";
}

export interface SnapResult {
	snappedSec: number;
	/** Non-null only when a target was within threshold. */
	target: SnapTarget | null;
}

export function buildSnapTargets({
	clipEdgesSec,
	playheadSec,
	durationSec,
}: {
	clipEdgesSec: readonly number[];
	playheadSec: number;
	durationSec: number;
}): SnapTarget[] {
	const targets: SnapTarget[] = clipEdgesSec.map((timeSec) => ({
		timeSec,
		source: "clip-edge" as const,
	}));
	targets.push({ timeSec: playheadSec, source: "playhead" });
	targets.push({ timeSec: 0, source: "bounds" });
	targets.push({ timeSec: durationSec, source: "bounds" });
	return targets;
}

/**
 * Resolves `candidateSec` to the nearest target within `thresholdSec`, or
 * returns it unchanged if nothing is close enough. Ties are broken by
 * target order (first-built wins), which in practice means clip edges beat
 * playhead/bounds when equidistant — a reasonable default, not a CapCut-
 * confirmed tie-break rule (source is silent on this).
 */
export function resolveSnap({
	candidateSec,
	targets,
	thresholdSec,
}: {
	candidateSec: number;
	targets: readonly SnapTarget[];
	thresholdSec: number;
}): SnapResult {
	let best: SnapTarget | null = null;
	let bestDistance = Infinity;

	for (const target of targets) {
		const distance = Math.abs(target.timeSec - candidateSec);
		if (distance <= thresholdSec && distance < bestDistance) {
			best = target;
			bestDistance = distance;
		}
	}

	return best
		? { snappedSec: best.timeSec, target: best }
		: { snappedSec: candidateSec, target: null };
}
