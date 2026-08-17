import { Layers } from "lucide-react";
import { CC_ICON_STROKE } from "../../tokens";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { SegmentedControl } from "../segmented-control";
import { ParamRow } from "../editor/param-row";
import type { EditorCore } from "@kneecap/editor-core";
import type { ElementRef, VisualElement } from "@kneecap/editor-core/timeline";
import { getBuiltInElementParams } from "@kneecap/editor-core/params/registry";
import { setElementParam } from "../../editor/actions";

interface OverlayPanelProps {
	editor: EditorCore;
	elementRef: ElementRef | null;
	element: VisualElement | null;
	onClose: () => void;
	onAddOverlay: () => void;
}

/**
 * M8 Overlay panel — corpus 04 §3.5: "Add overlay... Opacity... Blend
 * mode... default Normal." Opacity and blend mode are NOT new engine
 * surface — both are existing `visualElementParams` entries
 * (`params/registry.ts`) every visual element already carries, so this
 * panel is a thin, fully-generic UI over state that was already real
 * before M8. "Add overlay" inserts a bundled shape graphic onto a new
 * overlay track (real media picture-in-picture import is M4 scope, not
 * built this session — see demo-project.ts's header for why a graphic
 * stands in for it here).
 */
export function OverlayPanel({ editor, elementRef, element, onClose, onAddOverlay }: OverlayPanelProps) {
	const blendModeParam = getBuiltInElementParams({ type: "graphic" }).find((p) => p.key === "blendMode");
	const blendOptions = blendModeParam?.type === "select" ? blendModeParam.options : [];
	const opacity = element && typeof element.params.opacity === "number" ? element.params.opacity : 1;
	const blendMode = element && typeof element.params.blendMode === "string" ? element.params.blendMode : "normal";

	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			<button type="button" className="cc-panel-actions__btn" onClick={onAddOverlay}>
				<Layers size={20} strokeWidth={CC_ICON_STROKE} />
				<span>Add overlay</span>
			</button>

			{element && elementRef && (
				<>
					<ParamRow
						label="Opacity"
						value={Math.round(opacity * 100)}
						min={0}
						max={100}
						step={1}
						formatValue={(v) => `${v}%`}
						onChange={(v) => setElementParam({ editor, ref: elementRef, key: "opacity", value: v / 100 })}
					/>
					{blendOptions.length > 0 && (
						<div className="cc-param-row">
							<div className="cc-param-row__head">
								<span className="cc-param-row__label">Blend mode</span>
							</div>
							<SegmentedControl
								aria-label="Blend mode"
								segments={blendOptions.slice(0, 4).map((o) => ({ id: o.value, label: o.label }))}
								activeId={blendMode}
								onSelect={(value) => setElementParam({ editor, ref: elementRef, key: "blendMode", value })}
							/>
						</div>
					)}
				</>
			)}
			{!element && <p className="cc-panel-note">Select an overlay element to edit its opacity and blend mode.</p>}
		</PanelSheet>
	);
}
