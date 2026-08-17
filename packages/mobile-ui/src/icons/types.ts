import type { SVGProps } from "react";

/**
 * Drop-in-compatible with lucide-react's own props shape (size, strokeWidth,
 * absoluteStrokeWidth) so these custom glyphs can sit in the same toolbar
 * arrays as real Lucide icons without a special case at the call site.
 */
export interface CcIconProps extends SVGProps<SVGSVGElement> {
	size?: number | string;
	strokeWidth?: number | string;
	/** Some of these glyphs (keyframe diamond, freeze frame) have a
	 *  documented empty/filled state distinction — see corpus 06/plan M6a.
	 *  Ignored by icons that don't have one. */
	filled?: boolean;
}
