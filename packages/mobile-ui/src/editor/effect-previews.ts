/**
 * Blind test round 4, item 9: the Effects sheet showed the Blur tile as an empty grey square.
 * The cause: effects-panel.tsx gave the grid only `{ id, label }`, so ThumbnailGrid had no
 * `imageSrc` to show. This module gives each effect a preview image: a small sample scene
 * with the effect applied. The image is an inline SVG data URL (the app CSP allows `data:`
 * in img-src), so there is no asset to bundle and no network fetch.
 *
 * Pure module (no runtime imports), so bun tests can read the SVG.
 */

/** The blur radius of the Blur tile, in view-box units (the view box is 96 x 96). */
export const BLUR_PREVIEW_STD_DEVIATION = 3.5;

/**
 * A sample scene: sky, sun, hills, a tree and a dark ground band (the tile label sits on
 * it). The shapes run past the view box, so a blur keeps the tile edges filled.
 */
function sampleScene(): string {
	return [
		'<rect x="-24" y="-24" width="144" height="144" fill="url(#sky)"/>',
		'<circle cx="66" cy="30" r="13" fill="#ffd36e"/>',
		'<path d="M-24 66 L14 40 L38 58 L60 36 L120 70 L120 120 L-24 120 Z" fill="#3f7d6e"/>',
		'<path d="M-24 76 Q24 58 56 72 T120 70 L120 120 L-24 120 Z" fill="#2c5f53"/>',
		'<rect x="22" y="52" width="4" height="20" fill="#3b2a20"/>',
		'<circle cx="24" cy="50" r="9" fill="#24493f"/>',
		'<rect x="-24" y="80" width="144" height="40" fill="#14211f"/>',
	].join("");
}

/** The SVG text of the Blur tile: the sample scene under an feGaussianBlur. */
export function blurPreviewSvg({
	stdDeviation = BLUR_PREVIEW_STD_DEVIATION,
}: { stdDeviation?: number } = {}): string {
	return [
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">',
		"<defs>",
		'<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">',
		'<stop offset="0" stop-color="#5aa9e6"/><stop offset="1" stop-color="#f4b69a"/>',
		"</linearGradient>",
		'<filter id="blur" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB">',
		`<feGaussianBlur stdDeviation="${stdDeviation}"/>`,
		"</filter>",
		"</defs>",
		`<g filter="url(#blur)">${sampleScene()}</g>`,
		"</svg>",
	].join("");
}

/** Wraps SVG text as a data URL for an <img src>. */
export function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The preview image of an effect tile, or undefined when the effect has no preview yet. */
export function effectPreviewImage({ effectType }: { effectType: string }): string | undefined {
	switch (effectType) {
		case "blur":
			return svgDataUrl(blurPreviewSvg());
		default:
			return undefined;
	}
}
