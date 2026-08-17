import type { CcIconProps } from "./types";

/**
 * SpeedRampIcon — custom-drawn, NOT traced from CapCut.
 *
 * Functional brief (corpus 04 §4.1): speed's "Curve" mode — a velocity
 * ramp with manually-added points on the curve ("Add Point" for custom
 * ramps). Drawn as an S-shaped ease curve (slow-in, fast, slow-out — the
 * actual shape of a velocity ramp, not decorative) with two filled dots
 * marking user-added curve points, echoing the same "filled micro-glyph"
 * accenting convention as the rest of the custom set.
 */
export function SpeedRampIcon({ size = 24, strokeWidth = 2, ...props }: CcIconProps) {
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
				d="M4 18C8 18 8 6 12 6C16 6 16 6 20 6"
				stroke="currentColor"
				strokeWidth={strokeWidth}
				strokeLinecap="round"
			/>
			<circle cx="4" cy="18" r="1.75" fill="currentColor" />
			<circle cx="20" cy="6" r="1.75" fill="currentColor" />
		</svg>
	);
}
