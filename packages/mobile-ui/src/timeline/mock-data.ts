/**
 * Synthetic project generator for the timeline dev harness
 * (apps/web/src/app/dev/mobile-timeline/page.tsx) and for tests. Produces
 * the exact stress shape named in plan M7's exit criterion — "a 20-clip,
 * 5-track, 10-minute project" — so the harness can be visually/perf-checked
 * against the scenario the plan actually asks for, not an arbitrary one.
 *
 * This is NOT real project data. No live editor-core wiring (mapping a real
 * `EditorCore` scene graph into `TimelineProjectVM`) was built this
 * session — see the M7 handoff notes.
 */

import type { TimelineProjectVM, TimelineTrackVM, TimelineClipVM } from "./types";

/** Deterministic LCG so the generated project is stable across runs/tests —
 *  no `Math.random()`, so a failing test or a screenshot diff is reproducible. */
function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0xffffffff;
	};
}

function synthesizeWaveform({
	rng,
	sampleCount,
}: {
	rng: () => number;
	sampleCount: number;
}): number[] {
	const peaks: number[] = [];
	let level = 0.4;
	for (let i = 0; i < sampleCount; i++) {
		level = Math.min(1, Math.max(0.05, level + (rng() - 0.5) * 0.3));
		peaks.push(level);
	}
	return peaks;
}

export function generateStressProject({
	totalDurationSec = 600,
	seed = 42,
}: {
	totalDurationSec?: number;
	seed?: number;
} = {}): TimelineProjectVM {
	const rng = makeRng(seed);
	let clipCounter = 0;
	const nextId = (prefix: string) => `${prefix}-${clipCounter++}`;

	// Main track: 9 clips covering the full duration back-to-back.
	const mainClipCount = 9;
	const mainClips: TimelineClipVM[] = [];
	let cursor = 0;
	for (let i = 0; i < mainClipCount; i++) {
		const remaining = totalDurationSec - cursor;
		const isLast = i === mainClipCount - 1;
		const durationSec = isLast
			? remaining
			: Math.max(8, (remaining / (mainClipCount - i)) * (0.6 + rng() * 0.8));
		mainClips.push({
			id: nextId("main"),
			trackId: "track-main",
			kind: "video",
			name: `Clip ${i + 1}`,
			startSec: cursor,
			durationSec,
			colorHue: (i * 47) % 360,
		});
		cursor += durationSec;
	}

	// Overlay tracks (2 of the 6-max cap): a handful of PIP clips scattered
	// across the timeline.
	const overlayTracks: TimelineTrackVM[] = [0, 1].map((trackIndex) => {
		const clipCount = 2;
		const clips: TimelineClipVM[] = [];
		for (let i = 0; i < clipCount; i++) {
			const startSec = (totalDurationSec / clipCount) * i + rng() * 20;
			const durationSec = 15 + rng() * 25;
			clips.push({
				id: nextId(`overlay${trackIndex}`),
				trackId: `track-overlay-${trackIndex}`,
				kind: "video",
				name: `Overlay ${trackIndex + 1}.${i + 1}`,
				startSec,
				durationSec,
				colorHue: (trackIndex * 90 + i * 30 + 200) % 360,
			});
		}
		return {
			id: `track-overlay-${trackIndex}`,
			kind: "overlay" as const,
			name: `Overlay ${trackIndex + 1}`,
			clips,
		};
	});

	// Text track: short caption-shaped clips.
	const textClipCount = 4;
	const textClips: TimelineClipVM[] = [];
	for (let i = 0; i < textClipCount; i++) {
		const startSec = (totalDurationSec / textClipCount) * i + 5;
		textClips.push({
			id: nextId("text"),
			trackId: "track-text",
			kind: "text",
			name: `Caption ${i + 1}`,
			startSec,
			durationSec: 6 + rng() * 4,
			colorHue: 45,
			keyframes:
				i % 2 === 0
					? [
							{ id: nextId("kf"), timeSec: 0 },
							{ id: nextId("kf"), timeSec: 3 },
						]
					: undefined,
		});
	}

	// Audio track: 3 music/VO clips with synthetic waveforms.
	const audioClipCount = 3;
	const audioClips: TimelineClipVM[] = [];
	let audioCursor = 0;
	for (let i = 0; i < audioClipCount; i++) {
		const durationSec = totalDurationSec / audioClipCount - 5;
		audioClips.push({
			id: nextId("audio"),
			trackId: "track-audio",
			kind: "audio",
			name: `Track ${i + 1}.mp3`,
			startSec: audioCursor,
			durationSec,
			colorHue: 150,
			waveformPeaks: synthesizeWaveform({ rng, sampleCount: 120 }),
		});
		audioCursor += durationSec + 5;
	}

	// 9 main + 2×2 overlay + 4 text + 3 audio = 20 clips, 5 tracks — matches
	// plan M7's exit-criterion stress scenario exactly (STRESS_PROJECT_*
	// constants below are asserted against this in the test suite so a
	// future edit here can't silently drift from "20 clips, 5 tracks").
	const tracks: TimelineTrackVM[] = [
		{ id: "track-main", kind: "main", name: "Video", clips: mainClips },
		...overlayTracks,
		{ id: "track-text", kind: "text", name: "Text", clips: textClips },
		{ id: "track-audio", kind: "audio", name: "Audio", clips: audioClips },
	];

	return { tracks, durationSec: totalDurationSec, fps: 30 };
}

export const STRESS_PROJECT_CLIP_COUNT = 9 + 2 + 2 + 4 + 3; // = 20
export const STRESS_PROJECT_TRACK_COUNT = 5;
