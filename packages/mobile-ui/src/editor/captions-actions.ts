/**
 * Fixer pass — wires M8's Captions panel to the REAL M10 captions engine
 * that merged into main after track/ui branched (commit order:
 * track/ui M8 was last, track/captions/M10 merged before it, but the panel
 * was never updated to use what M10 shipped). This was previously a
 * hardcoded `disabled` no-op with the doc-comment claim "no `TrackType` for
 * captions in the engine yet" — both false on this merge:
 * `packages/editor-core/src/timeline/types.ts`'s `TrackType` union includes
 * `"caption"`, and `packages/editor-core/src/captions/generate.ts` +
 * `commands/captions/*` are real, tested modules.
 *
 * "Generate" here calls the REAL pipeline end to end:
 *   1. `getNativeBridge()` (never `./web-fallback` directly — this is an
 *      editor UI file, so it's bound by the same bridge-import gate
 *      `scripts/invariants.sh` enforces for every other panel/action in
 *      this package) selects the web-fallback bridge in a plain browser.
 *   2. The web-fallback bridge's `transcribe()` recognizes exactly ONE
 *      sentinel `MediaHandle` (`DEV_FIXTURE_MEDIA_HANDLE`,
 *      `@kneecap/native-bridge`'s own dev-harness fixture, built
 *      specifically for "verify the full generate -> edit -> preview flow
 *      in the dev harness using the web fallback + a pre-transcribed
 *      fixture" per that fixture's own header) and yields real
 *      `TranscriptSegment[]` data — any other handle still throws the
 *      honest `UNSUPPORTED` error, this is not a general in-webview STT
 *      backdoor.
 *   3. `buildCaptionElementsFromTranscript` (editor-core's real M10
 *      module) converts those segments into `CreateCaptionElement[]`.
 *   4. `insertGeneratedCaptions` (editor-core's real M10 command helper)
 *      lands them on a brand-new caption track as one undoable action.
 *
 * There is still no real on-device whisper.cpp call reachable from THIS
 * panel — only the disclosed dev-fixture path above. A real file's audio
 * still cannot be transcribed from the web-fallback bridge (native shells
 * only, plan M10) or from this panel at all (no "pick a clip to
 * transcribe" affordance was added — out of scope for this fixer pass, see
 * the caller's own flags). That gap is real and left open, not papered
 * over: the panel's copy says exactly this.
 */
import type { EditorCore } from "@kneecap/editor-core";
import { ZERO_MEDIA_TIME } from "@kneecap/editor-core";
import {
	buildCaptionElementsFromTranscript,
	type TranscriptSegmentInput,
} from "@kneecap/editor-core/captions";
import { insertGeneratedCaptions, ApplyCaptionStyleCommand } from "@kneecap/editor-core/commands";
import { getNativeBridge, DEV_FIXTURE_MEDIA_HANDLE } from "@kneecap/native-bridge";

export interface GenerateCaptionsResult {
	trackId: string;
	elementIds: string[];
}

/** Runs the real generate pipeline against the dev-fixture sample clip and
 *  lands real `CaptionElement`s on a real caption track. Returns `null` if
 *  the fixture yields zero usable segments (shouldn't happen with the
 *  bundled sample, but `insertGeneratedCaptions` itself returns `null` for
 *  an empty element list rather than inserting an empty track). */
export async function generateCaptionsFromSampleClip({
	editor,
	stylePresetId,
}: {
	editor: EditorCore;
	stylePresetId: string;
}): Promise<GenerateCaptionsResult | null> {
	const bridge = await getNativeBridge();
	const segments: TranscriptSegmentInput[] = [];
	for await (const segment of bridge.transcribe({
		handle: DEV_FIXTURE_MEDIA_HANDLE,
		opts: { modelSize: "tiny" },
	})) {
		segments.push(segment);
	}

	const elements = buildCaptionElementsFromTranscript({
		segments,
		timelineStartTime: ZERO_MEDIA_TIME,
		stylePresetId,
	});

	return insertGeneratedCaptions({ editor, elements });
}

/** "Apply to all" caption style — the real `ApplyCaptionStyleCommand`
 *  (plan M10 item 6), not local-only chip-selection state. Undoable like
 *  every other engine mutation this package wires. */
export function applyCaptionStyleToAll({
	editor,
	presetId,
}: {
	editor: EditorCore;
	presetId: string;
}): void {
	editor.command.execute({
		command: new ApplyCaptionStyleCommand({ presetId, scope: { kind: "all" } }),
	});
}
