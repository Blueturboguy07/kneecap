import { useState } from "react";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { ChipRow } from "../chip-row";
import { SegmentedControl } from "../segmented-control";

interface CaptionsPanelProps {
	onClose: () => void;
}

const LANGUAGES = [
	{ id: "auto", label: "Auto-detect" },
	{ id: "en", label: "English" },
	{ id: "es", label: "Spanish" },
];

const STYLES = [
	{ id: "trending", label: "Trending" },
	{ id: "highlight", label: "Highlight" },
	{ id: "glow", label: "Glow" },
	{ id: "aesthetic", label: "Aesthetic" },
];

/**
 * M8 Captions panel — task scope: "UI shell; engine arrives from the
 * captions track." This is DELIBERATELY not wired to `EditorCore`: there
 * is no `TrackType` for captions in the engine yet (`timeline/types.ts`'s
 * `TrackType` union is `"video" | "text" | "audio" | "graphic" | "effect"`)
 * and no on-device ASR is implemented — corpus 04 §3.9 itself flags stock
 * CapCut's Auto Captions as SERVER-SIDE, which this project's zero-cost/
 * local-first directive explicitly forbids cloning as-is. Building the
 * real on-device transcription pipeline is out of scope for M8
 * (panels/toolbars); this panel exists so the toolbar item is reachable
 * and visually complete, not to claim a working captions feature.
 * "Generate" is intentionally a no-op — clicking it does not fabricate
 * caption data.
 */
export function CaptionsPanel({ onClose }: CaptionsPanelProps) {
	const [language, setLanguage] = useState("auto");
	const [stylePreset, setStylePreset] = useState("trending");

	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			<p className="cc-panel-note">
				UI shell only — no on-device transcription engine is wired up yet. See this component&apos;s header comment.
			</p>
			<div className="cc-param-row">
				<div className="cc-param-row__head">
					<span className="cc-param-row__label">Language</span>
				</div>
				<SegmentedControl aria-label="Caption language" segments={LANGUAGES} activeId={language} onSelect={setLanguage} />
			</div>
			<button type="button" className="cc-panel-actions__btn" disabled aria-disabled="true">
				<span>Generate (not implemented)</span>
			</button>
			<ChipRow chips={STYLES} activeIds={[stylePreset]} onSelect={setStylePreset} />
		</PanelSheet>
	);
}
