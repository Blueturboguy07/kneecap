import type { MediaAssetData } from "@/services/storage/types";
import type { TProject } from "@/project/types";
import type {
	AudioTrack,
	TScene,
	TextTrack,
	VideoTrack,
} from "@/timeline/types";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import type { BuildEdlOutputArgs, EdlAssetResolver } from "../build";

/**
 * The fixture behind `golden-edl-v1.json`.
 *
 * Deliberately exercises every corner of the contract that a native mapper can
 * get wrong: a non-integer frame rate (29.97 = 30000/1001), a retimed clip, a
 * trimmed clip, an overlay track above the main track (so the z-order
 * inversion in `scene-builder` is visible), a text overlay with a keyframed
 * composite property, an audio track, and an asset whose duration only exists
 * in seconds and so has to cross the seconds→ticks boundary.
 *
 * Keep it stable. Changing it changes the golden file, and the whole point of
 * the golden file is that a diff there is a deliberate act.
 */

const TPS = 120_000; // ticks/second, matching TICKS_PER_SECOND

export function buildFixtureProject(): TProject {
	return {
		metadata: {
			id: "proj-fixture-1",
			name: "EDL v1 golden fixture",
			duration: mediaTime({ ticks: 10 * TPS }),
			createdAt: new Date("2026-08-17T00:00:00.000Z"),
			updatedAt: new Date("2026-08-17T00:00:00.000Z"),
		},
		scenes: [],
		currentSceneId: "scene-1",
		version: 31,
		settings: {
			// 29.97 drop-frame. If a mapper collapses this to 30.0, a ten-minute
			// export drifts by ~18 frames.
			fps: { numerator: 30_000, denominator: 1001 },
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		},
	};
}

export function buildFixtureScene(): TScene {
	const mainTrack: VideoTrack = {
		id: "track-main",
		name: "Main",
		type: "video",
		muted: false,
		hidden: false,
		elements: [
			{
				id: "clip-a",
				name: "intro.mp4",
				type: "video",
				mediaId: "asset-video-1",
				startTime: ZERO_MEDIA_TIME,
				// 2 s on the timeline.
				duration: mediaTime({ ticks: 2 * TPS }),
				// Starts 0.5 s into the source.
				trimStart: mediaTime({ ticks: TPS / 2 }),
				trimEnd: ZERO_MEDIA_TIME,
				sourceDuration: mediaTime({ ticks: 6 * TPS }),
				params: {
					"transform.positionX": 0,
					"transform.positionY": 0,
					"transform.scaleX": 1,
					"transform.scaleY": 1,
					"transform.rotate": 0,
					opacity: 1,
					blendMode: "normal",
					volume: 0,
					muted: false,
				},
			},
			{
				id: "clip-b",
				name: "action.mp4",
				type: "video",
				mediaId: "asset-video-1",
				startTime: mediaTime({ ticks: 2 * TPS }),
				// 2 s on the timeline at 1.5x => 3 s of source consumed.
				duration: mediaTime({ ticks: 2 * TPS }),
				trimStart: mediaTime({ ticks: 3 * TPS }),
				trimEnd: ZERO_MEDIA_TIME,
				sourceDuration: mediaTime({ ticks: 6 * TPS }),
				retime: { rate: 1.5, maintainPitch: true },
				params: {
					"transform.positionX": 0,
					"transform.positionY": 0,
					"transform.scaleX": 1,
					"transform.scaleY": 1,
					"transform.rotate": 0,
					opacity: 1,
					blendMode: "normal",
					volume: -3,
					muted: false,
				},
				effects: [
					{
						id: "fx-1",
						type: "brightness",
						enabled: true,
						params: { amount: 0.2 },
					},
				],
			},
		],
	};

	const textTrack: TextTrack = {
		id: "track-text",
		name: "Text",
		type: "text",
		hidden: false,
		elements: [
			{
				id: "clip-title",
				name: "Title",
				type: "text",
				startTime: mediaTime({ ticks: TPS / 2 }),
				duration: mediaTime({ ticks: 3 * TPS }),
				trimStart: ZERO_MEDIA_TIME,
				trimEnd: ZERO_MEDIA_TIME,
				params: {
					content: "kneecap",
					fontFamily: "Inter",
					fontSize: 72,
					color: "#00CAE0",
					textAlign: "center",
					"transform.positionX": 0,
					"transform.positionY": -200,
					"transform.scaleX": 1,
					"transform.scaleY": 1,
					"transform.rotate": 0,
					opacity: 1,
					blendMode: "normal",
				},
				animations: {
					opacity: {
						keys: [
							{
								id: "kf-1",
								time: ZERO_MEDIA_TIME,
								value: 0,
								segmentToNext: "linear",
								tangentMode: "auto",
							},
							{
								id: "kf-2",
								time: mediaTime({ ticks: TPS / 2 }),
								value: 1,
								// The engine calls a stepped segment "step"; the EDL calls it
								// "hold", matching how both native sides name it.
								segmentToNext: "step",
								tangentMode: "auto",
							},
						],
						extrapolation: { before: "hold", after: "hold" },
					},
				},
			},
		],
	};

	const audioTrack: AudioTrack = {
		id: "track-audio",
		name: "Audio",
		type: "audio",
		muted: false,
		elements: [
			{
				id: "clip-music",
				name: "bed.m4a",
				type: "audio",
				sourceType: "upload",
				mediaId: "asset-audio-1",
				startTime: ZERO_MEDIA_TIME,
				duration: mediaTime({ ticks: 4 * TPS }),
				trimStart: ZERO_MEDIA_TIME,
				trimEnd: mediaTime({ ticks: TPS }),
				sourceDuration: mediaTime({ ticks: 5 * TPS }),
				params: { volume: -6, muted: false },
			},
		],
	};

	return {
		id: "scene-1",
		name: "Scene 1",
		isMain: true,
		bookmarks: [],
		createdAt: new Date("2026-08-17T00:00:00.000Z"),
		updatedAt: new Date("2026-08-17T00:00:00.000Z"),
		tracks: {
			main: mainTrack,
			overlay: [textTrack],
			audio: [audioTrack],
		},
	};
}

export function buildFixtureMediaAssets(): MediaAssetData[] {
	return [
		{
			id: "asset-video-1",
			name: "intro.mp4",
			type: "video",
			size: 12_345_678,
			lastModified: 1_755_000_000_000,
			width: 1080,
			height: 1920,
			// SECONDS. This is the one place the EDL builder crosses the
			// seconds -> ticks boundary, and it goes through the wasm helper.
			duration: 6,
			fps: 30,
			hasAudio: true,
		},
		{
			id: "asset-audio-1",
			name: "bed.m4a",
			type: "audio",
			size: 2_345_678,
			lastModified: 1_755_000_000_000,
			duration: 5,
			hasAudio: true,
		},
	];
}

export const FIXTURE_OUTPUT: BuildEdlOutputArgs = {
	container: "mp4",
	videoCodec: "h264",
	audioCodec: "aac",
	bitrate: 12_000_000,
	includeAudio: true,
};

/** Stands in for M4's native media custody. */
export const fixtureAssetResolver: EdlAssetResolver = ({ mediaId }) => ({
	sourceUri: `kneecap-media://sandbox/${mediaId}`,
	proxyUri: `kneecap-media://proxy/${mediaId}`,
	codec: mediaId.includes("audio") ? "mp4a.40.2" : "avc1.640028",
	rotationDegrees: 0,
});
