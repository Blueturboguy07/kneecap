import { Plus } from "lucide-react";
import { CC_ICON_STROKE } from "../../tokens";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { ChipRow } from "../chip-row";
import { SegmentedControl } from "../segmented-control";
import { ParamRow, ToggleRow } from "../editor/param-row";
import type { EditorCore } from "@kneecap/editor-core";
import type { ElementRef, TextElement } from "@kneecap/editor-core/timeline";
import { getLocallyAvailableFonts } from "@kneecap/editor-core/fonts/local-fonts";
import { setElementParam } from "../../editor/actions";

const SWATCHES = ["#f5f5f5", "#00cae0", "#ff5a5f", "#ffd54a", "#4ade80", "#000000"];

interface TextPanelProps {
	editor: EditorCore;
	elementRef: ElementRef | null;
	element: TextElement | null;
	onClose: () => void;
	onAddText: () => void;
}

/**
 * M8 Text panel — task scope "fonts/styles." Style controls write directly
 * to the real `textElementParams` set (`params/registry.ts`) already
 * shipped with the inherited engine: content/fontFamily/fontSize/color/
 * textAlign/fontWeight/fontStyle/letterSpacing/lineHeight/background.*.
 * Font FAMILY choice is honestly limited to `getLocallyAvailableFonts()`
 * (today: just Inter) — see local-fonts.ts's own header for why a wider
 * bundled OFL set is still a follow-up, not fabricated as done here.
 */
export function TextPanel({ editor, elementRef, element, onClose, onAddText }: TextPanelProps) {
	const fonts = getLocallyAvailableFonts();
	const fontFamily = element && typeof element.params.fontFamily === "string" ? element.params.fontFamily : fonts[0];
	const fontSize = element && typeof element.params.fontSize === "number" ? element.params.fontSize : 32;
	const color = element && typeof element.params.color === "string" ? element.params.color : "#f5f5f5";
	const textAlign = element && typeof element.params.textAlign === "string" ? element.params.textAlign : "center";
	const bold = element?.params.fontWeight === "bold";
	const italic = element?.params.fontStyle === "italic";
	const backgroundEnabled = Boolean(element?.params["background.enabled"]);

	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			<button type="button" className="cc-panel-actions__btn" onClick={onAddText}>
				<Plus size={20} strokeWidth={CC_ICON_STROKE} />
				<span>Add text</span>
			</button>

			{element && elementRef && (
				<>
					<ChipRow
						chips={fonts.map((f) => ({ id: f, label: f }))}
						activeIds={[fontFamily]}
						onSelect={(value) => setElementParam({ editor, ref: elementRef, key: "fontFamily", value })}
					/>
					<ParamRow
						label="Size"
						value={fontSize}
						min={8}
						max={160}
						step={1}
						onChange={(value) => setElementParam({ editor, ref: elementRef, key: "fontSize", value })}
					/>
					<div className="cc-param-row">
						<div className="cc-param-row__head">
							<span className="cc-param-row__label">Color</span>
						</div>
						<div className="cc-swatch-row">
							{SWATCHES.map((swatch) => (
								<button
									key={swatch}
									type="button"
									className="cc-swatch"
									style={{ background: swatch, outline: color === swatch ? "2px solid var(--cc-accent)" : undefined }}
									aria-label={swatch}
									aria-pressed={color === swatch}
									onClick={() => setElementParam({ editor, ref: elementRef, key: "color", value: swatch })}
								/>
							))}
						</div>
					</div>
					<div className="cc-param-row">
						<div className="cc-param-row__head">
							<span className="cc-param-row__label">Align</span>
						</div>
						<SegmentedControl
							aria-label="Text align"
							segments={[
								{ id: "left", label: "Left" },
								{ id: "center", label: "Center" },
								{ id: "right", label: "Right" },
							]}
							activeId={textAlign}
							onSelect={(value) => setElementParam({ editor, ref: elementRef, key: "textAlign", value })}
						/>
					</div>
					<ToggleRow
						label="Bold"
						active={bold}
						onToggle={() => setElementParam({ editor, ref: elementRef, key: "fontWeight", value: bold ? "normal" : "bold" })}
					/>
					<ToggleRow
						label="Italic"
						active={italic}
						onToggle={() =>
							setElementParam({ editor, ref: elementRef, key: "fontStyle", value: italic ? "normal" : "italic" })
						}
					/>
					<ToggleRow
						label="Background"
						active={backgroundEnabled}
						onToggle={() =>
							setElementParam({ editor, ref: elementRef, key: "background.enabled", value: !backgroundEnabled })
						}
					/>
				</>
			)}
			{!element && <p className="cc-panel-note">Select a text element to edit its style.</p>}
		</PanelSheet>
	);
}
