/**
 * Blind test round 3, item 10: what happens to the project when the editor closes.
 *
 * The rule (closeEditorProject):
 *  1. The project NEVER got content: it had no element when the editor opened (a new
 *     project, or an old empty one) and it has no element on any track now (the main,
 *     overlay and audio tracks of every scene). The app deletes the project
 *     (editor.project.deleteProjects). No empty card stays on Home.
 *  2. Any other project: the app keeps it. A project that had content when the editor
 *     opened stays even when the user removed every clip.
 *     The app makes a new thumbnail from the frame at 0:00 (editor.project.prepareExit) and saves the project
 *     (editor.project.saveCurrentProject). Home then shows the card with its thumbnail
 *     at once. When no frame can be made, the card shows the neutral placeholder
 *     (ProjectCard in app-root.tsx).
 *
 * app-root.tsx runs this for each way out of the editor: the "Close project" button
 * (EditorShell onBack) and the editor error guard (afterError: then no thumbnail and
 * no extra save, only the delete of an empty project). The editor is off the screen
 * first, and Home shows only after this ends.
 *
 * Only types come from editor-core, so apps/mobile/test/round-3-ui.test.ts runs this
 * file with a fake editor.
 */
import type { EditorCore } from "@kneecap/editor-core";

/** The longest wait for the thumbnail. A slower thumbnail still lands later. */
export const CLOSE_THUMBNAIL_LIMIT_MS = 5_000;
/** The longest wait for a save that runs when an empty project is deleted. */
const SAVE_SETTLE_LIMIT_MS = 2_000;

/** "deleted": the project was empty and is gone. "kept": the project has content (or its
 *  state is not known) and stays. "delete-failed": the project was empty, but the
 *  delete did not work, so the card stays. "no-project": no project was open. */
export type CloseOutcome = "deleted" | "kept" | "delete-failed" | "no-project";

type CloseEditor = Pick<EditorCore, "project" | "scenes" | "save">;

/** The thumbnail work of the last close (it can end after the time limit). */
let lateWork: Promise<unknown> = Promise.resolve();

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for `work`, but at most `ms`. */
async function withTimeLimit(work: Promise<unknown>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * True when a track of a scene of the open project has an element; false when no track
 * has one. Null when the editor has no scenes: the state is not known, so the project
 * stays.
 */
export function projectHasElements({ editor }: { editor: Pick<EditorCore, "scenes"> }): boolean | null {
	const scenes = editor.scenes.getScenes();
	if (scenes.length === 0) return null;
	return scenes.some(({ tracks }) =>
		[tracks.main, ...tracks.overlay, ...tracks.audio].some((track) => track.elements.length > 0),
	);
}

/** A save that runs during the delete could write the project back: save now, then let
 *  a save that is still running end first. */
async function settleSaves({ editor }: { editor: CloseEditor }): Promise<void> {
	try {
		await editor.save.flush();
	} catch (error) {
		console.error("Failed to save before the delete:", error);
	}
	const end = Date.now() + SAVE_SETTLE_LIMIT_MS;
	while (editor.save.getIsDirty() && Date.now() < end) await wait(50);
}

/** Applies the rule above to the open project. It never throws. */
export async function closeEditorProject({
	editor,
	afterError = false,
	hadContentAtOpen = false,
	thumbnailLimitMs = CLOSE_THUMBNAIL_LIMIT_MS,
}: {
	editor: CloseEditor;
	afterError?: boolean;
	/** The project had an element (or its state was not known) when the editor
	 *  opened (app-root.tsx records it). Such a project is never deleted here. */
	hadContentAtOpen?: boolean;
	thumbnailLimitMs?: number;
}): Promise<CloseOutcome> {
	try {
		const project = editor.project.getActiveOrNull();
		if (!project) return "no-project";
		const id = project.metadata.id;
		if (!hadContentAtOpen && projectHasElements({ editor }) === false) {
			await settleSaves({ editor });
			await editor.project.deleteProjects({ ids: [id] });
			return editor.project.getSavedProjects().some((p) => p.id === id) ? "delete-failed" : "deleted";
		}
		// After an editor error: no thumbnail (the frame render can be what failed). The
		// save manager has already saved each change.
		if (afterError) return "kept";
		const thumbnail = editor.project.prepareExit().catch((error: unknown) => {
			console.error("Failed to make the project thumbnail:", error);
		});
		lateWork = thumbnail;
		await withTimeLimit(thumbnail, thumbnailLimitMs);
		if (editor.project.getActiveOrNull()?.metadata.id === id) await editor.project.saveCurrentProject();
		return "kept";
	} catch (error) {
		console.error("Failed to close the project:", error);
		return "kept";
	}
}

/** Home waits for this before it opens, makes or deletes a project, so a thumbnail that
 *  came after the time limit never lands on another project. */
export async function waitForCloseWork({ limitMs = CLOSE_THUMBNAIL_LIMIT_MS }: { limitMs?: number } = {}): Promise<void> {
	await withTimeLimit(lateWork, limitMs);
}
