import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { cn } from "../../lib/cn";
import { CLIP_KEYFRAME_EASINGS, type ClipKeyframeEasing } from "../../editor/keyframes";

const EASING_LABELS: Record<ClipKeyframeEasing, string> = {
	linear: "Linear",
	"ease-in": "Ease in",
	"ease-out": "Ease out",
	"ease-in-out": "Ease in & out",
	hold: "Hold",
};

const EASING_HINTS: Record<ClipKeyframeEasing, string> = {
	linear: "Constant speed to the next keyframe.",
	"ease-in": "Starts slow, speeds up.",
	"ease-out": "Starts fast, settles gently.",
	"ease-in-out": "Slow at both ends.",
	hold: "Stays put, then jumps at the next keyframe.",
};

interface KeyframeGraphSheetProps {
	/** The segment's current easing, `"custom"` for a desktop-authored bezier
	 *  that is none of the presets, `"mixed"` when the group's paths
	 *  disagree, or `null` when there is no segment to edit (fewer than two
	 *  keyframes, or the playhead is past the last one). */
	current: ClipKeyframeEasing | "custom" | "mixed" | null;
	/** "0:01.20 → 0:02.00" — which segment the sheet is editing. */
	segmentLabel: string | null;
	onSelect: (easing: ClipKeyframeEasing) => void;
	onClose: () => void;
}

/**
 * Round 47 — CapCut mobile's "Graph"/"Easing" for keyframes: presets only
 * (the handle-dragging graph editor is desktop-only there, per the 2026
 * tutorials; the engine's bezier handles are what the presets write, so a
 * desktop graph could edit the same data later). Applies to the segment
 * leaving the keyframe the playhead is on or just passed — "tap on the
 * keyframe timeline after setting multiple keyframes and tap on Easing".
 */
export function KeyframeGraphSheet({ current, segmentLabel, onSelect, onClose }: KeyframeGraphSheetProps) {
	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			<p className="cc-sheet-title">Graph</p>
			{segmentLabel ? (
				<p className="cc-panel-note">
					Keyframe {segmentLabel}
					{current === "custom" && " — custom curve (set on desktop)"}
					{current === "mixed" && " — properties currently use different curves"}
				</p>
			) : (
				<p className="cc-panel-note">Add two keyframes to this clip, then park the playhead between them.</p>
			)}
			<div className="cc-keyframe-easing">
				{CLIP_KEYFRAME_EASINGS.map((easing) => (
					<button
						key={easing}
						type="button"
						className={cn("cc-keyframe-easing__item", current === easing && "cc-keyframe-easing__item--active")}
						onClick={() => onSelect(easing)}
						disabled={!segmentLabel}
						aria-pressed={current === easing}
					>
						<span className="cc-keyframe-easing__label">{EASING_LABELS[easing]}</span>
						<span className="cc-keyframe-easing__hint">{EASING_HINTS[easing]}</span>
					</button>
				))}
			</div>
		</PanelSheet>
	);
}
