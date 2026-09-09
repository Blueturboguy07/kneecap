import { ChevronLeft, ChevronRight } from "lucide-react";
import { CC_ICON_STROKE } from "../../tokens";
import { KeyframeDiamondIcon } from "../../icons/keyframe-diamond";
import { cn } from "../../lib/cn";

interface KeyframeControlProps {
	/** True while the playhead sits on one of the clip's keyframes (± half a
	 *  frame) — the diamond fills and the tap REMOVES that keyframe. */
	isOnKeyframe: boolean;
	canPrevious: boolean;
	canNext: boolean;
	onToggle: () => void;
	onPrevious: () => void;
	onNext: () => void;
	className?: string;
}

/**
 * Round 47 — the CapCut keyframe diamond with its ‹ › neighbours, pinned
 * top-right of the timeline area (the timecode's mirror image, top-left).
 * Placement is from tutorial descriptions ("a small diamond icon above the
 * timeline", "arrow buttons next to the keyframe icon to move back and
 * forth between keyframes"); the exact chrome is still [NEEDS-CAPTURE] in
 * docs/capcut-reference (plan M6a), same as the diamond's empty/filled
 * states — this ships the outline = add, filled = on-a-keyframe convention
 * `KeyframeDiamondIcon` already documents. The arrows only render once the
 * clip has a keyframe to go to, so an un-keyed clip shows the bare diamond.
 */
export function KeyframeControl({
	isOnKeyframe,
	canPrevious,
	canNext,
	onToggle,
	onPrevious,
	onNext,
	className,
}: KeyframeControlProps) {
	const showArrows = canPrevious || canNext;
	return (
		<div className={cn("cc-keyframe-control", className)} role="group" aria-label="Keyframes">
			{showArrows && (
				<button
					type="button"
					className="cc-keyframe-control__btn"
					onClick={onPrevious}
					disabled={!canPrevious}
					aria-label="Previous keyframe"
				>
					<ChevronLeft size={18} strokeWidth={CC_ICON_STROKE} />
				</button>
			)}
			<button
				type="button"
				className={cn(
					"cc-keyframe-control__btn",
					"cc-keyframe-control__diamond",
					isOnKeyframe && "cc-keyframe-control__diamond--active",
				)}
				onClick={onToggle}
				aria-pressed={isOnKeyframe}
				aria-label={isOnKeyframe ? "Remove keyframe" : "Add keyframe"}
			>
				<KeyframeDiamondIcon size={22} strokeWidth={CC_ICON_STROKE} filled={isOnKeyframe} />
				<span className="cc-keyframe-control__glyph" aria-hidden="true">
					{isOnKeyframe ? "−" : "+"}
				</span>
			</button>
			{showArrows && (
				<button
					type="button"
					className="cc-keyframe-control__btn"
					onClick={onNext}
					disabled={!canNext}
					aria-label="Next keyframe"
				>
					<ChevronRight size={18} strokeWidth={CC_ICON_STROKE} />
				</button>
			)}
		</div>
	);
}
