import { Copy, Scissors, ScissorsLineDashed, Trash2 } from "lucide-react";
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
	/** Absent for element types that can't carry audio — the row is then
	 *  hidden rather than shown-and-disabled, matching how this panel already
	 *  treats speed/volume on a text or sticker selection. */
	onCutDeadSpace?: () => void;
	onSetSpeed: (args: { rate: number; maintainPitch: boolean }) => void;
	onSetVolume: (db: number) => void;
}

/**
 * M8 Edit panel: split, duplicate, delete, cut gaps, speed and volume.
 * Speed and volume only apply to retimable elements (video/audio, per
 * `RETIMABLE_ELEMENT_TYPES` in the engine) — for a text/sticker/graphic
 * selection those controls are hidden rather than shown-and-disabled,
 * since there is no engine-side field for them to write to on those types.
 *
 * No Reverse switch (App Store rule 2.1, completeness): preview and export
 * do not play a clip backwards, so the switch did nothing.
 */
export function EditPanel({
	element,
	onClose,
	onSplit,
	onDelete,
	onDuplicate,
	onCutDeadSpace,
	onSetSpeed,
	onSetVolume,
}: EditPanelProps) {
	const isRetimable = RETIMABLE_TYPES.has(element.type);
	const retime = "retime" in element ? element.retime : undefined;
	const rate = retime?.rate ?? DEFAULT_RETIME_RATE;
	const maintainPitch = retime?.maintainPitch ?? false;
	const volumeDb = typeof element.params.volume === "number" ? element.params.volume : 0;

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
				{onCutDeadSpace && (
					<button type="button" className="cc-panel-actions__btn" onClick={onCutDeadSpace}>
						<ScissorsLineDashed size={20} strokeWidth={CC_ICON_STROKE} />
						<span>Cut gaps</span>
					</button>
				)}
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
					{/* Volume: a LINEAR percent slider 0–1000
					    (100 = original, 1000 = 10×) — the raw dB slider
					    crammed the whole audible boost into its top edge and
					    read as "won't go loud enough" (founder, 2026-08-22).
					    Storage stays dB engine-wide: pct↔dB converts at this
					    UI boundary only. 0% pins to VOLUME_DB_MIN (silence);
					    1000% is exactly VOLUME_DB_MAX (+20 dB = 10×). */}
					<ParamRow
						label="Volume"
						value={Math.round(10 ** (volumeDb / 20) * 100)}
						min={0}
						max={1000}
						step={1}
						formatValue={(v) => `${Math.round(v)}`}
						onChange={(pct) =>
							onSetVolume(
								pct <= 0
									? VOLUME_DB_MIN
									: Math.min(
											VOLUME_DB_MAX,
											Math.max(VOLUME_DB_MIN, 20 * Math.log10(pct / 100)),
										),
							)
						}
					/>
				</>
			)}
		</PanelSheet>
	);
}
