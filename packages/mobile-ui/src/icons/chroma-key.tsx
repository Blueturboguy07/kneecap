import type { CcIconProps } from "./types";

/**
 * ChromaKeyIcon — custom-drawn, NOT traced from CapCut.
 *
 * Functional brief (corpus 04 §3.1/§3.5): green-screen keying — pick a
 * background color from the frame and remove it. Drawn as the same
 * "outline shell + filled micro-glyph" convention corpus 06 §4 measured
 * across CapCut's real toolbar icons (rounded-rect frame outline, small
 * solid accent shape inside) — reused deliberately for visual consistency
 * with the rest of the kit, applied to an original composition: a video
 * frame with an eyedropper-style color-sample dot targeting one corner,
 * rather than any traced glyph.
 */
export function ChromaKeyIcon({ size = 24, strokeWidth = 2, ...props }: CcIconProps) {
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
				x="3"
				y="5"
				width="14"
				height="14"
				rx="2.5"
				stroke="currentColor"
				strokeWidth={strokeWidth}
			/>
			<circle cx="17.5" cy="16.5" r="3.5" fill="currentColor" />
			<line
				x1="8"
				y1="10.5"
				x2="12"
				y2="10.5"
				stroke="currentColor"
				strokeWidth={strokeWidth}
				strokeLinecap="round"
			/>
		</svg>
	);
}
