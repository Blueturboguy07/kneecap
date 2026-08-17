import { describe, expect, test } from "bun:test";
import {
	BASE_PIXELS_PER_SECOND,
	clampTime,
	clampZoom,
	fitZoom,
	pixelsPerSecondForZoom,
	pixelsToTime,
	timeToPixels,
} from "../timeline/time-scale";
import {
	thumbnailSlotIntervalSec,
	visibleClipIndices,
	visibleThumbnailSlots,
} from "../timeline/virtualization";
import { buildSnapTargets, resolveSnap } from "../timeline/snapping";
import {
	generateStressProject,
	STRESS_PROJECT_CLIP_COUNT,
	STRESS_PROJECT_TRACK_COUNT,
} from "../timeline/mock-data";
import type { TimelineClipVM } from "../timeline/types";

describe("time-scale", () => {
	test("timeToPixels / pixelsToTime round-trip", () => {
		const pixelsPerSecond = pixelsPerSecondForZoom({ zoom: 2 });
		expect(pixelsPerSecond).toBe(BASE_PIXELS_PER_SECOND * 2);
		const px = timeToPixels({ timeSec: 12.5, pixelsPerSecond });
		expect(pixelsToTime({ px, pixelsPerSecond })).toBeCloseTo(12.5, 6);
	});

	test("pixelsToTime is 0 for non-positive pixelsPerSecond (no NaN/Infinity)", () => {
		expect(pixelsToTime({ px: 100, pixelsPerSecond: 0 })).toBe(0);
	});

	test("clampZoom stays within [min, max]", () => {
		expect(clampZoom({ zoom: -5 })).toBeGreaterThan(0);
		expect(clampZoom({ zoom: 999 })).toBeLessThanOrEqual(12);
		expect(clampZoom({ zoom: 1, min: 0.5, max: 2 })).toBe(1);
	});

	test("clampTime clamps to [0, duration]", () => {
		expect(clampTime({ timeSec: -10, durationSec: 100 })).toBe(0);
		expect(clampTime({ timeSec: 200, durationSec: 100 })).toBe(100);
		expect(clampTime({ timeSec: 50, durationSec: 100 })).toBe(50);
	});

	test("fitZoom fits a project that isn't floored by MIN_ZOOM", () => {
		const zoom = fitZoom({ durationSec: 60, viewportWidthPx: 390 });
		expect(zoom).toBeGreaterThan(0);
		const pixelsPerSecond = pixelsPerSecondForZoom({ zoom });
		expect(60 * pixelsPerSecond).toBeLessThanOrEqual(390 + 1);
	});

	test("fitZoom never goes below MIN_ZOOM even for a very long project", () => {
		// A 10-minute project can't fit a 390px phone viewport without going
		// under MIN_ZOOM — fitZoom is clamped, so the content legitimately
		// overflows and the user must scroll. This documents that tradeoff.
		const zoom = fitZoom({ durationSec: 600, viewportWidthPx: 390 });
		expect(zoom).toBe(clampZoom({ zoom: 390 / (600 * BASE_PIXELS_PER_SECOND) }));
	});
});

function makeClip(overrides: Partial<TimelineClipVM>): TimelineClipVM {
	return {
		id: "c",
		trackId: "t",
		kind: "video",
		name: "c",
		startSec: 0,
		durationSec: 10,
		colorHue: 0,
		...overrides,
	};
}

describe("virtualization", () => {
	const clips: TimelineClipVM[] = [
		makeClip({ id: "a", startSec: 0, durationSec: 10 }),
		makeClip({ id: "b", startSec: 10, durationSec: 10 }),
		makeClip({ id: "c", startSec: 20, durationSec: 10 }),
		makeClip({ id: "d", startSec: 100, durationSec: 10 }),
	];

	test("returns only clips intersecting the view window + overscan", () => {
		const { startIndex, endIndex } = visibleClipIndices({
			clips,
			viewStartSec: 5,
			viewEndSec: 15,
			overscanSec: 0,
		});
		expect(clips.slice(startIndex, endIndex + 1).map((c) => c.id)).toEqual([
			"a",
			"b",
		]);
	});

	test("overscan pulls in one more clip on each side", () => {
		const { startIndex, endIndex } = visibleClipIndices({
			clips,
			viewStartSec: 12,
			viewEndSec: 18,
			overscanSec: 5,
		});
		expect(clips.slice(startIndex, endIndex + 1).map((c) => c.id)).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	test("far-off-screen clips are excluded (the whole point of virtualizing)", () => {
		const { startIndex, endIndex } = visibleClipIndices({
			clips,
			viewStartSec: 0,
			viewEndSec: 25,
			overscanSec: 2,
		});
		expect(clips.slice(startIndex, endIndex + 1).map((c) => c.id)).toEqual([
			"a",
			"b",
			"c",
		]);
		expect(clips.slice(startIndex, endIndex + 1).map((c) => c.id)).not.toContain(
			"d",
		);
	});

	test("empty result when nothing intersects", () => {
		const { startIndex, endIndex } = visibleClipIndices({
			clips,
			viewStartSec: 50,
			viewEndSec: 60,
			overscanSec: 1,
		});
		expect(endIndex).toBeLessThan(startIndex);
	});

	test("thumbnailSlotIntervalSec grows as pixelsPerSecond shrinks (fewer slots when zoomed out)", () => {
		const zoomedIn = thumbnailSlotIntervalSec({
			pixelsPerSecond: 300,
			targetThumbWidthPx: 40,
		});
		const zoomedOut = thumbnailSlotIntervalSec({
			pixelsPerSecond: 10,
			targetThumbWidthPx: 40,
		});
		expect(zoomedOut).toBeGreaterThan(zoomedIn);
	});

	test("visibleThumbnailSlots only returns slots inside the visible clip-relative range", () => {
		const slots = visibleThumbnailSlots({
			clipDurationSec: 60,
			slotIntervalSec: 5,
			clipVisibleStartSec: 12,
			clipVisibleEndSec: 22,
		});
		expect(slots[0]).toBeLessThanOrEqual(12);
		expect(slots[slots.length - 1]).toBeGreaterThanOrEqual(22);
		for (const slot of slots) {
			expect(slot).toBeGreaterThanOrEqual(0);
			expect(slot).toBeLessThanOrEqual(60);
		}
	});

	test("visibleThumbnailSlots never returns an empty array (always at least one)", () => {
		const slots = visibleThumbnailSlots({
			clipDurationSec: 2,
			slotIntervalSec: 5,
			clipVisibleStartSec: 0,
			clipVisibleEndSec: 2,
		});
		expect(slots.length).toBeGreaterThan(0);
	});
});

describe("snapping", () => {
	test("snaps to the nearest target within threshold", () => {
		const targets = buildSnapTargets({
			clipEdgesSec: [10, 20],
			playheadSec: 15,
			durationSec: 100,
		});
		const result = resolveSnap({ candidateSec: 10.2, targets, thresholdSec: 0.5 });
		expect(result.snappedSec).toBe(10);
		expect(result.target?.source).toBe("clip-edge");
	});

	test("does not snap when nothing is within threshold", () => {
		const targets = buildSnapTargets({
			clipEdgesSec: [10, 20],
			playheadSec: 15,
			durationSec: 100,
		});
		const result = resolveSnap({ candidateSec: 12, targets, thresholdSec: 0.5 });
		expect(result.snappedSec).toBe(12);
		expect(result.target).toBeNull();
	});

	test("snaps to the playhead", () => {
		const targets = buildSnapTargets({
			clipEdgesSec: [10, 20],
			playheadSec: 15,
			durationSec: 100,
		});
		const result = resolveSnap({ candidateSec: 15.1, targets, thresholdSec: 0.5 });
		expect(result.target?.source).toBe("playhead");
	});

	test("snaps to timeline bounds (0 and duration)", () => {
		const targets = buildSnapTargets({
			clipEdgesSec: [],
			playheadSec: 50,
			durationSec: 100,
		});
		expect(
			resolveSnap({ candidateSec: 0.2, targets, thresholdSec: 0.5 }).snappedSec,
		).toBe(0);
		expect(
			resolveSnap({ candidateSec: 99.8, targets, thresholdSec: 0.5 }).snappedSec,
		).toBe(100);
	});
});

describe("mock-data (stress scenario matches plan M7's exit criterion)", () => {
	test("generates exactly 20 clips across 5 tracks", () => {
		const project = generateStressProject();
		expect(project.tracks.length).toBe(STRESS_PROJECT_TRACK_COUNT);
		expect(project.tracks.length).toBe(5);
		const totalClips = project.tracks.reduce((sum, t) => sum + t.clips.length, 0);
		expect(totalClips).toBe(STRESS_PROJECT_CLIP_COUNT);
		expect(totalClips).toBe(20);
	});

	test("is deterministic for a given seed (reproducible screenshots/perf runs)", () => {
		const a = generateStressProject({ seed: 7 });
		const b = generateStressProject({ seed: 7 });
		expect(a).toEqual(b);
	});

	test("main track clips are contiguous and cover the full duration", () => {
		const project = generateStressProject({ totalDurationSec: 300 });
		const main = project.tracks.find((t) => t.kind === "main");
		expect(main).toBeDefined();
		let cursor = 0;
		for (const clip of main!.clips) {
			expect(clip.startSec).toBeCloseTo(cursor, 6);
			cursor += clip.durationSec;
		}
		expect(cursor).toBeCloseTo(300, 6);
	});

	test("audio clips carry synthetic waveform peaks in [0,1]", () => {
		const project = generateStressProject();
		const audio = project.tracks.find((t) => t.kind === "audio");
		expect(audio!.clips.length).toBeGreaterThan(0);
		for (const clip of audio!.clips) {
			expect(clip.waveformPeaks).toBeDefined();
			for (const peak of clip.waveformPeaks!) {
				expect(peak).toBeGreaterThanOrEqual(0);
				expect(peak).toBeLessThanOrEqual(1);
			}
		}
	});
});
