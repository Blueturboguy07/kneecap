import { Copy, RotateCcw, Scissors, Trash2 } from "lucide-react";
import { CC_ICON_STROKE } from "../../tokens";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { ParamRow, ToggleRow } from "../editor/param-row";
import type { ElementRef, TimelineElement } from "@kneecap/editor-core/timeline";
import { DEFAULT_RETIME_RATE, MAX_RETIME_RATE, MIN_RETIME_RATE } from "@kneecap/editor-core/retime";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@kneecap/editor-core/timeline/audio-constants";

const RETIMABLE_TYPES = new Set(["video", "audio"]);

interface EditPanelProps {
	elementRef: ElementRef;
	element: TimelineElement;
	onClose: () => void;
	onSplit: () => void;
	onDelete: () => void;
	onDuplicate: () => void;
	onSetSpeed: (args: { rate: number; maintainPitch: boolean }) => void;
	onSetVolume: (db: number) => void;
	onToggleReverse: () => void;
}

/**
 * M8 Edit panel — task scope: "contextual: split/speed/volume/delete/
 * duplicate/reverse." Speed/volume/reverse only apply to retimable
 * elements (video/audio, per `RETIMABLE_ELEMENT_TYPES` in the engine) —
 * for a text/sticker/graphic selection those three controls are hidden
 * rather than shown-and-disabled, since there is no engine-side field for
 * them to write to on those types.
 */
export function EditPanel({
	element,
	onClose,
	onSplit,
	onDelete,
	onDuplicate,
	onSetSpeed,
	onSetVolume,
	onToggleReverse,
}: EditPanelProps) {
	const isRetimable = RETIMABLE_TYPES.has(element.type);
	const retime = "retime" in element ? element.retime : undefined;
	const rate = retime?.rate ?? DEFAULT_RETIME_RATE;
	const maintainPitch = retime?.maintainPitch ?? false;
	const volumeDb = typeof element.params.volume === "number" ? element.params.volume : 0;
	const reversed = Boolean(element.params.reversed);

	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			<div className="cc-panel-actions">
				<button type="button" className="cc-panel-actions__btn" onClick={onSplit}>
					<Scissors size={20} strokeWidth={CC_ICON_STROKE} />
					<span>Split</span>
				</button>
				<button type="button" className="cc-panel-actions__btn" onClick={onDuplicate}>
					<Copy size={20} strokeWidth={CC_ICON_STROKE} />
					<span>Duplicate</span>
				</button>
				<button type="button" className="cc-panel-actions__btn" onClick={onDelete}>
					<Trash2 size={20} strokeWidth={CC_ICON_STROKE} />
					<span>Delete</span>
				</button>
			</div>

			{isRetimable && (
				<>
					<ParamRow
						label="Speed"
						value={rate}
						min={MIN_RETIME_RATE}
						max={MAX_RETIME_RATE}
						step={0.05}
						formatValue={(v) => `${v.toFixed(2)}x`}
						onChange={(v) => onSetSpeed({ rate: v, maintainPitch })}
					/>
					<ToggleRow
						label="Maintain pitch"
						active={maintainPitch}
						onToggle={() => onSetSpeed({ rate, maintainPitch: !maintainPitch })}
					/>
					<ParamRow
						label="Volume"
						value={volumeDb}
						min={VOLUME_DB_MIN}
						max={VOLUME_DB_MAX}
						step={0.5}
						formatValue={(v) => `${v.toFixed(1)} dB`}
						onChange={onSetVolume}
					/>
					<ToggleRow
						label="Reverse"
						active={reversed}
						onToggle={onToggleReverse}
					/>
					{reversed && (
						<p className="cc-panel-note">
							<RotateCcw size={12} strokeWidth={CC_ICON_STROKE} aria-hidden="true" /> Reverse state is saved with the
							clip, but preview/export playback direction isn&apos;t implemented yet — see the M8 handoff.
						</p>
					)}
				</>
			)}
		</PanelSheet>
	);
}
