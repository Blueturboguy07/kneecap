import { useState } from "react";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { ChipRow } from "../chip-row";
import { SegmentedControl } from "../segmented-control";
import type { EditorCore } from "@kneecap/editor-core";
import type { ElementRef } from "@kneecap/editor-core/timeline";
import { CAPTION_STYLE_PRESETS, DEFAULT_CAPTION_STYLE_PRESET_ID } from "@kneecap/editor-core/captions";
import { generateCaptionsFromSampleClip, applyCaptionStyleToAll } from "../../editor/captions-actions";

interface CaptionsPanelProps {
	editor: EditorCore;
	onClose: () => void;
	onInserted: (ref: ElementRef) => void;
}

const LANGUAGES = [
	{ id: "auto", label: "Auto-detect" },
	{ id: "en", label: "English" },
	{ id: "es", label: "Spanish" },
];

const STYLES = CAPTION_STYLE_PRESETS.map((preset) => ({ id: preset.id, label: preset.name }));

type GenerateState = "idle" | "generating" | "done" | "error";

/**
 * M8 Captions panel — fixer pass. This IS now wired to the real M10
 * captions engine (`@kneecap/editor-core/captions` +
 * `commands/captions/*`), not the placeholder from before: "Generate"
 * calls `generateCaptionsFromSampleClip`, which runs the real
 * `getNativeBridge()` -> `transcribe()` -> `buildCaptionElementsFromTranscript`
 * -> `insertGeneratedCaptions` pipeline against `@kneecap/native-bridge`'s
 * own disclosed dev-fixture sample clip (the exact mechanism plan M10's
 * exit criterion names: "verify the full generate -> edit -> preview flow
 * in the dev harness using the web fallback + a pre-transcribed fixture").
 * The style chips call the real `ApplyCaptionStyleCommand` ("apply to
 * all"), not local-only UI state.
 *
 * Still genuinely NOT built: transcribing a REAL user-picked clip (only
 * the bundled sample fixture is reachable from this panel — the
 * web-fallback bridge itself still throws honest `UNSUPPORTED` for any
 * other file, and no native whisper.cpp call is wired from this panel
 * either), and per-word caption editing UI (`UpdateCaptionWordCommand`
 * exists in editor-core but has no UI control here yet). Both are
 * disclosed below, not hidden.
 */
export function CaptionsPanel({ editor, onClose, onInserted }: CaptionsPanelProps) {
	const [language, setLanguage] = useState("auto");
	const [stylePreset, setStylePreset] = useState(DEFAULT_CAPTION_STYLE_PRESET_ID);
	const [state, setState] = useState<GenerateState>("idle");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const handleGenerate = () => {
		setState("generating");
		setErrorMessage(null);
		generateCaptionsFromSampleClip({ editor, stylePresetId: stylePreset })
			.then((result) => {
				setState("done");
				if (result && result.elementIds[0]) {
					onInserted({ trackId: result.trackId, elementId: result.elementIds[0] });
				}
			})
			.catch((error: unknown) => {
				setState("error");
				setErrorMessage(error instanceof Error ? error.message : String(error));
			});
	};

	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			<p className="cc-panel-note">
				Generate transcribes the bundled dev-fixture sample clip on-device (zero network, zero
				cloud) — a real user-picked clip cannot be transcribed yet; that needs the native
				whisper.cpp shell (plan M10).
			</p>
			<div className="cc-param-row">
				<div className="cc-param-row__head">
					<span className="cc-param-row__label">Language</span>
				</div>
				<SegmentedControl aria-label="Caption language" segments={LANGUAGES} activeId={language} onSelect={setLanguage} />
			</div>
			<button
				type="button"
				className="cc-panel-actions__btn"
				disabled={state === "generating"}
				onClick={handleGenerate}
			>
				<span>
					{state === "generating"
						? "Generating…"
						: state === "done"
							? "Generate again"
							: "Generate"}
				</span>
			</button>
			{state === "error" && errorMessage && <p className="cc-panel-note">{errorMessage}</p>}
			<ChipRow
				chips={STYLES}
				activeIds={[stylePreset]}
				onSelect={(id) => {
					setStylePreset(id);
					applyCaptionStyleToAll({ editor, presetId: id });
				}}
			/>
		</PanelSheet>
	);
}
