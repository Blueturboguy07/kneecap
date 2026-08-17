/**
 * "Apply to all" — plan M10 item 6, corpus `05` §9 Styling: "look for the
 * Apply to All... button — this applies your style to every Auto Caption
 * clip in the project simultaneously," and the corpus's own note that this
 * pattern recurs across transitions/filters/captions and is "worth building
 * once as a shared primitive." This is that primitive's caption instance —
 * see `captions/styles.ts`'s header comment for why applying a preset is a
 * plain params snapshot-copy, not a live binding, which is exactly what lets
 * "per-segment overrides still work afterward" (corpus, same section): once
 * applied, a caption's params are ordinary params, editable one at a time via
 * `UpdateElementsCommand` like any other element.
 */
import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { CaptionElement, SceneTracks } from "@/timeline";
import type { ParamValues } from "@/params";
import { buildCaptionStyleParamsPatch } from "@/captions/styles";

export type ApplyCaptionStyleScope =
	| { kind: "all" }
	| { kind: "single"; trackId: string; elementId: string };

export interface ApplyCaptionStyleParams {
	presetId: string;
	scope: ApplyCaptionStyleScope;
}

function applyPatchToCaption({
	element,
	patch,
}: {
	element: CaptionElement;
	patch: ParamValues;
}): CaptionElement {
	return {
		...element,
		params: {
			...element.params,
			...patch,
		},
	};
}

export class ApplyCaptionStyleCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly presetId: string;
	private readonly scope: ApplyCaptionStyleScope;

	constructor({ presetId, scope }: ApplyCaptionStyleParams) {
		super();
		this.presetId = presetId;
		this.scope = scope;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		const patch = buildCaptionStyleParamsPatch({ presetId: this.presetId });
		const scope = this.scope;

		const updatedTracks: SceneTracks = {
			...this.savedState,
			overlay: this.savedState.overlay.map((track) => {
				if (track.type !== "caption") return track;
				if (scope.kind === "single" && track.id !== scope.trackId) return track;

				return {
					...track,
					elements: track.elements.map((element) => {
						if (scope.kind === "single" && element.id !== scope.elementId) {
							return element;
						}
						return applyPatchToCaption({ element, patch });
					}),
				};
			}),
		};

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
