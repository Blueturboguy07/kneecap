import type { CcIconProps } from "./types";

/**
 * RippleDeleteIcon — custom-drawn, NOT traced from CapCut.
 *
 * Functional brief: delete a clip and close the resulting gap by shifting
 * everything after it backward — the "ripple" is the shift, not just the
 * delete. Drawn as a clip rectangle marked for removal (X) with a
 * leftward chevron beside it standing for the gap-closing shift, the same
 * bracket-plus-arrow grammar independently common across timeline editors
 * because it's the functionally obvious way to draw "delete + shift left,"
 * not a copy of any one editor's specific glyph.
 */
export function RippleDeleteIcon({ size = 24, strokeWidth = 2, ...props }: CcIconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<rect
				x="11"
				y="5"
				width="10"
				height="14"
				rx="2"
				stroke="currentColor"
				strokeWidth={strokeWidth}
			/>
			<path
				d="M14.5 9.5L17.5 14.5M17.5 9.5L14.5 14.5"
				stroke="currentColor"
				strokeWidth={strokeWidth}
				strokeLinecap="round"
			/>
			<path
				d="M7 8L3 12L7 16"
				stroke="currentColor"
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
