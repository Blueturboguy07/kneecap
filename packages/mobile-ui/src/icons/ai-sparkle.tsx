import type { CcIconProps } from "./types";

/**
 * AiSparkleIcon — custom-drawn, NOT traced from CapCut.
 *
 * Functional brief (corpus 06 §7.1: "the specific 'AI sparkle in a circle'
 * badge seen in ip_2.jpg's AI-prompt input field"). A four-point sparkle
 * inside a circle is a generic, industry-wide "AI/magic" glyph (used by
 * dozens of unrelated products) — drawn here as one large vertical spike
 * crossed with one small horizontal spike, the textbook twinkle
 * construction, not a copy of CapCut's specific badge artwork. Circle
 * outline + filled sparkle again matches this kit's "outline shell +
 * filled micro-glyph" convention.
 */
export function AiSparkleIcon({ size = 24, strokeWidth = 2, ...props }: CcIconProps) {
	const microStroke = Number(strokeWidth) * 0.6;
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth={strokeWidth} />
			<path
				d="M12.75 7.5C12.75 9.85625 14.6438 11.75 17 11.75C14.6438 11.75 12.75 13.6438 12.75 16C12.75 13.6438 10.8562 11.75 8.5 11.75C10.8562 11.75 12.75 9.85625 12.75 7.5Z"
				fill="currentColor"
				stroke="currentColor"
				strokeWidth={microStroke}
				strokeLinejoin="round"
			/>
		</svg>
	);
}
