/**
 * Inline word-text correction — plan M10 item 5 / corpus `05` §9 Editing:
 * "Tap any line to edit its text directly." `wordIndex` indexes into the
 * element's OWN `words` array (not the currently-visible-after-trim
 * subset) — callers should get it from
 * `captions/layout.ts`'s `getVisibleCaptionWords()`, which returns exactly
 * that index alongside each visible word.
 */
import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks } from "@/timeline";
import { updateElementInSceneTracks } from "@/timeline";

export interface UpdateCaptionWordParams {
	trackId: string;
	elementId: string;
	wordIndex: number;
	text: string;
}

export class UpdateCaptionWordCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly wordIndex: number;
	private readonly text: string;

	constructor({ trackId, elementId, wordIndex, text }: UpdateCaptionWordParams) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.wordIndex = wordIndex;
		this.text = text;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const updatedTracks = updateElementInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			elementId: this.elementId,
			update: (element) => {
				if (element.type !== "caption") {
					return element;
				}
				if (this.wordIndex < 0 || this.wordIndex >= element.words.length) {
					console.error(
						`UpdateCaptionWordCommand: wordIndex ${this.wordIndex} out of range (element has ${element.words.length} words)`,
					);
					return element;
				}
				const words = element.words.slice();
				words[this.wordIndex] = { ...words[this.wordIndex], text: this.text };
				return { ...element, words };
			},
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
}
