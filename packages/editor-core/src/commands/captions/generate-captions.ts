/**
 * "Generate captions" — plan M10 items 1/5: takes already-built
 * `CreateCaptionElement[]` (from `captions/generate.ts`, itself fed by
 * `NativeBridge.transcribe()`'s output) and lands them as a brand-new caption
 * track, undoable as a single history entry.
 *
 * Deliberately NOT a bespoke `Command` subclass with its own track-splice
 * logic — `apps/web/src/subtitles/insert.ts`'s `insertCaptionChunksAsTextTrack`
 * already established the exact right pattern for "insert a batch of
 * generated text-like elements as one new track, one undo step" (used today
 * for SRT/ASS subtitle import, landing plain `TextElement`s onto a `"text"`
 * track): `AddTrackCommand` + one `InsertElementCommand` per element, wrapped
 * in a `BatchCommand` so `editor.command.execute()` records it as a single
 * undoable action. This function is that exact same pattern, generalised to
 * live in `editor-core` (rather than `apps/web`) so both the web dev harness
 * and the eventual mobile shell can call it — caption generation is a
 * cross-platform feature (the NativeBridge STT call that feeds it runs on
 * the phone), unlike SRT import, which is a desktop-only affordance today.
 */
import type { EditorCore } from "@/core";
import { AddTrackCommand, BatchCommand, InsertElementCommand } from "@/commands";
import type { CreateCaptionElement } from "@/timeline";

export interface InsertGeneratedCaptionsParams {
	editor: EditorCore;
	elements: CreateCaptionElement[];
	/** Explicit index into `tracks.overlay`; defaults to
	 * `AddTrackCommand`'s own default placement for a caption track (same
	 * default every other overlay track type gets). */
	trackIndex?: number;
}

export interface InsertGeneratedCaptionsResult {
	trackId: string;
	elementIds: string[];
}

export function insertGeneratedCaptions({
	editor,
	elements,
	trackIndex,
}: InsertGeneratedCaptionsParams): InsertGeneratedCaptionsResult | null {
	if (elements.length === 0) {
		return null;
	}

	const addTrackCommand = new AddTrackCommand({ type: "caption", index: trackIndex });
	const trackId = addTrackCommand.getTrackId();
	const insertCommands = elements.map(
		(element) =>
			new InsertElementCommand({
				placement: { mode: "explicit", trackId },
				element,
			}),
	);

	editor.command.execute({
		command: new BatchCommand([addTrackCommand, ...insertCommands]),
	});

	return {
		trackId,
		elementIds: insertCommands.map((command) => command.getElementId()),
	};
}
