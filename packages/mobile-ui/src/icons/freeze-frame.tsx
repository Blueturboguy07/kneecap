import type { CcIconProps } from "./types";

/**
 * FreezeFrameIcon — custom-drawn, NOT traced from CapCut.
 *
 * Functional brief (corpus 04 §3.1, App Store copy: "Highlight the best
 * moments with the freeze feature"): hold a single frame in place. Drawn
 * as the same outline video-frame shell measured across CapCut's real
 * toolbar icons (corpus 06 §4), with a filled snowflake/asterisk burst as
 * the "frozen" micro-glyph — the generic freeze/frost motif, not any
 * specific app's icon.
 */
export function FreezeFrameIcon({ size = 24, strokeWidth = 2, ...props }: CcIconProps) {
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
				x="2.5"
				y="4.5"
				width="19"
				height="15"
				rx="2.5"
				stroke="currentColor"
				strokeWidth={strokeWidth}
			/>
			<g stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round">
				<line x1="12" y1="8.2" x2="12" y2="15.8" />
				<line x1="8.8" y1="9.4" x2="15.2" y2="14.6" />
				<line x1="15.2" y1="9.4" x2="8.8" y2="14.6" />
			</g>
		</svg>
	);
}
