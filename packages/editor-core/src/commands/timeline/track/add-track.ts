import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks, TrackType } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import {
	buildEmptyTrack,
	getDefaultInsertIndexForTrack,
} from "@/timeline/placement";

export class AddTrackCommand extends Command {
	private trackId: string;
	private savedState: SceneTracks | null = null;

	constructor({
		type,
		index,
	}: {
		type: TrackType;
		index?: number;
	}) {
		super();
		this.type = type;
		this.index = index;
		this.trackId = generateUUID();
	}

	private type: TrackType;
	private index?: number;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const insertIndex =
			this.index ??
			getDefaultInsertIndexForTrack({
				tracks: this.savedState,
				trackType: this.type,
			});

		const updatedTracks =
			this.type === "audio"
				? buildAudioTrackState({
						tracks: this.savedState,
						insertIndex,
						trackId: this.trackId,
					})
				: buildOverlayTrackState({
						tracks: this.savedState,
						insertIndex,
						trackId: this.trackId,
						trackType: this.type,
					});

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getTrackId(): string {
		return this.trackId;
	}
}

function buildAudioTrackState({
	tracks,
	insertIndex,
	trackId,
}: {
	tracks: SceneTracks;
	insertIndex: number;
	trackId: string;
}): SceneTracks {
	const audioInsertIndex = Math.max(0, insertIndex - tracks.overlay.length - 1);
	const newTrack = buildEmptyTrack({
		id: trackId,
		type: "audio",
	});
	return {
		...tracks,
		audio: [
			...tracks.audio.slice(0, audioInsertIndex),
			newTrack,
			...tracks.audio.slice(audioInsertIndex),
		],
	};
}

function buildOverlayTrackState({
	tracks,
	insertIndex,
	trackId,
	trackType,
}: {
	tracks: SceneTracks;
	insertIndex: number;
	trackId: string;
	trackType: Exclude<TrackType, "audio">;
}): SceneTracks {
	const overlayInsertIndex = Math.min(insertIndex, tracks.overlay.length);
	// Fixer pass: this ternary chain's final `else` used to catch BOTH
	// "effect" and "caption" (M10 added the "caption" `TrackType` variant to
	// timeline/types.ts but never touched this command), silently building
	// an "effect" track for a caption request. `insertGeneratedCaptions`
	// (commands/captions/generate-captions.ts) calls `new AddTrackCommand({
	// type: "caption" })` then places `CaptionElement`s onto the track it
	// creates via `getTrackId()` — with the old fallback, that placement
	// failed downstream in `InsertElementCommand` with a genuine, reproduced
	// runtime error ("caption elements cannot be placed on effect tracks",
	// from `timeline/placement/compatibility.ts`'s type-compatibility
	// check), even though `editor.command.execute()` itself didn't throw —
	// so the M8 Captions panel's "Generate" appeared to succeed (button
	// flipped to "Generate again", no error state) while silently inserting
	// NOTHING. `placement/apply.ts` and `placement/track-factory.ts` (the
	// OTHER, "auto"-placement track-creation path) already both switch on
	// "caption" correctly — only this command's own separate
	// explicit-track-creation path had the gap. Verified live after this
	// fix: Generate on the dev-fixture sample now actually lands two real
	// caption clips on a real caption track, visible on the mounted
	// timeline.
	const newTrack =
		trackType === "video"
			? buildEmptyTrack({ id: trackId, type: "video" })
			: trackType === "text"
				? buildEmptyTrack({ id: trackId, type: "text" })
				: trackType === "graphic"
					? buildEmptyTrack({ id: trackId, type: "graphic" })
					: trackType === "caption"
						? buildEmptyTrack({ id: trackId, type: "caption" })
						: buildEmptyTrack({ id: trackId, type: "effect" });
	return {
		...tracks,
		overlay: [
			...tracks.overlay.slice(0, overlayInsertIndex),
			newTrack,
			...tracks.overlay.slice(overlayInsertIndex),
		],
	};
}
