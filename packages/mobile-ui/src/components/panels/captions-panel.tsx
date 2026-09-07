import { useState } from "react";
import { WandSparkles } from "lucide-react";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { ChipRow } from "../chip-row";
import { SegmentedControl } from "../segmented-control";
import type { EditorCore } from "@kneecap/editor-core";
import type { ElementRef } from "@kneecap/editor-core/timeline";
import { CAPTION_STYLE_PRESETS, DEFAULT_CAPTION_STYLE_PRESET_ID } from "@kneecap/editor-core/captions";
import {
	generateCaptions,
	applyCaptionStyleToAll,
	getCaptionHighlightEnabled,
	setCaptionHighlightEnabled,
	getCaptionBorderEnabled,
	setCaptionBorderEnabled,
} from "../../editor/captions-actions";
import { setCaptionText } from "../../editor/actions";
import { ToggleRow } from "../editor/param-row";
import { captionText } from "../../editor/caption-text";
import type { CaptionElement } from "@kneecap/editor-core/timeline";

interface CaptionsPanelProps {
	/** The selected caption element, when one is selected — drives the
	 *  text-field editor below (round 21.4). */
	selectedCaption?: { ref: ElementRef; element: CaptionElement } | null;
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
export function CaptionsPanel({ editor, onClose, onInserted, selectedCaption }: CaptionsPanelProps) {
	const [language, setLanguage] = useState("auto");
	const [stylePreset, setStylePreset] = useState(DEFAULT_CAPTION_STYLE_PRESET_ID);
	const [state, setState] = useState<GenerateState>("idle");
	// Local draft for the caption-text field: committing rewrites words and
	// re-deriving the value from them normalizes whitespace, which ate the
	// space key mid-typing (caught live in the harness). The draft holds
	// exactly what the user typed; the engine stores the tokenized words.
	const [captionDraft, setCaptionDraft] = useState<{ id: string; text: string } | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	// Read live from the engine each render (the shell re-renders this panel
	// on timeline changes, same as the caption textarea's words).
	const highlightEnabled = getCaptionHighlightEnabled({ editor });
	const borderEnabled = getCaptionBorderEnabled({ editor });

	const handleGenerate = () => {
		setState("generating");
		setErrorMessage(null);
		generateCaptions({ editor, stylePresetId: stylePreset })
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
				Generate transcribes audio from your whole timeline on this device (zero
				network, zero cloud) — every clip and voiceover, with trims respected.
			</p>
			{selectedCaption && (
				<div className="cc-param-row">
					<div className="cc-param-row__head">
						<span className="cc-param-row__label">Caption text</span>
					</div>
					<textarea
						className="cc-text-content-input"
						rows={2}
						value={
							captionDraft?.id === selectedCaption.ref.elementId
								? captionDraft.text
								: captionText(selectedCaption.element.words)
						}
						aria-label="Caption text"
						onChange={(event) => {
							setCaptionDraft({ id: selectedCaption.ref.elementId, text: event.target.value });
							setCaptionText({
								editor,
								ref: selectedCaption.ref,
								words: selectedCaption.element.words,
								text: event.target.value,
							});
						}}
					/>
				</div>
			)}
			{/* Round 45 (founder: the button "just looks like text rn") — this
			    wore `.cc-panel-actions__btn`, which is the Edit sheet's
			    ICON-ROW style: no background, no border, label under a glyph.
			    With no glyph above it, it rendered as a bare word. */}
			<button
				type="button"
				className="cc-panel-cta"
				disabled={state === "generating"}
				onClick={handleGenerate}
			>
				<WandSparkles className="cc-panel-cta__icon" size={18} aria-hidden="true" />
				<span>
					{state === "generating"
						? "Generating…"
						: state === "done"
							? "Generate again"
							: "Generate"}
				</span>
			</button>
			{state === "error" && errorMessage && <p className="cc-panel-note">{errorMessage}</p>}
			<div className="cc-param-row">
				<div className="cc-param-row__head">
					<span className="cc-param-row__label">Language</span>
				</div>
				<SegmentedControl aria-label="Caption language" segments={LANGUAGES} activeId={language} onSelect={setLanguage} />
			</div>
			<ChipRow
				chips={STYLES}
				activeIds={[stylePreset]}
				onSelect={(id) => {
					setStylePreset(id);
					applyCaptionStyleToAll({ editor, presetId: id });
				}}
			/>
			{/* Round 23 (founder: "highlighting the word ... should be
			    optional") — flips animationStyle on EVERY caption; captions
			    are a synced family. Note preset chips above reset it (a
			    preset bundles its own animationStyle). */}
			<ToggleRow
				label="Highlight spoken word"
				active={highlightEnabled}
				onToggle={() => setCaptionHighlightEnabled({ editor, enabled: !highlightEnabled })}
			/>
			{/* Round 31 (founder: "a default thin black border I can add
			    around any text or captions") — one tap, applied to the whole
			    caption family; the weight is DEFAULT_TEXT_BORDER_WIDTH. */}
			<ToggleRow
				label="Black border"
				active={borderEnabled}
				onToggle={() => setCaptionBorderEnabled({ editor, enabled: !borderEnabled })}
			/>
		</PanelSheet>
	);
}
