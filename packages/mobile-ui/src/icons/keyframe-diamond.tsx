import type { CcIconProps } from "./types";

/**
 * KeyframeDiamondIcon — custom-drawn, NOT traced from CapCut.
 *
 * Functional brief (corpus 04 §2 / §4.1): a diamond marker placed above the
 * timeline at a clip's playhead position once an animatable property has a
 * keyframe. Drawn from first principles as a simple rotated square on
 * Lucide's 24px/2px grid, round joins, matching every other icon in this
 * kit — not a copy of any specific editor's asset.
 *
 * Empty vs filled state: plan M6a flags "keyframe diamond empty/filled
 * states" as [NEEDS-CAPTURE] — CapCut's own exact rendering for
 * has-keyframe-here vs. no-keyframe-here was not resolvable from the
 * available screenshots. This component ships both states (`filled` prop)
 * as a reasonable placeholder convention common to timeline editors
 * generally (outline = no keyframe at this time, filled = keyframe here),
 * pending the founder capture session confirming CapCut's actual pair.
 */
export function KeyframeDiamondIcon({
	size = 24,
	strokeWidth = 2,
	filled = false,
	...props
}: CcIconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<path
				d="M12 4L20 12L12 20L4 12L12 4Z"
				fill={filled ? "currentColor" : "none"}
				stroke="currentColor"
				strokeWidth={strokeWidth}
				strokeLinejoin="round"
			/>
		</svg>
	);
}
