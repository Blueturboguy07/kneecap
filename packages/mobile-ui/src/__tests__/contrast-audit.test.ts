import { describe, expect, test } from "bun:test";
import { CONTRAST_PAIRS } from "../tokens";

/**
 * WCAG 2.1 relative-luminance + contrast-ratio formulas, implemented from
 * the spec directly (no dependency) — https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
function hexToRgb(hex: string): [number, number, number] {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m) throw new Error(`not a hex color: ${hex}`);
	return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function relativeLuminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio({ fgHex, bgHex }: { fgHex: string; bgHex: string }): number {
	const l1 = relativeLuminance(fgHex);
	const l2 = relativeLuminance(bgHex);
	const lighter = Math.max(l1, l2);
	const darker = Math.min(l1, l2);
	return (lighter + 0.05) / (darker + 0.05);
}

describe("CapCut-mobile token contrast audit (plan M6 exit criterion)", () => {
	for (const pair of CONTRAST_PAIRS) {
		test(`${pair.name} meets WCAG AA (>= ${pair.minRatio}:1)`, () => {
			const ratio = contrastRatio({ fgHex: pair.fg, bgHex: pair.bg });
			expect(ratio).toBeGreaterThanOrEqual(pair.minRatio);
		});
	}
});

describe("contrastRatio()", () => {
	test("black on white is the theoretical maximum, 21:1", () => {
		expect(contrastRatio({ fgHex: "#000000", bgHex: "#ffffff" })).toBeCloseTo(21, 1);
	});
	test("identical colors are the theoretical minimum, 1:1", () => {
		expect(contrastRatio({ fgHex: "#202020", bgHex: "#202020" })).toBeCloseTo(1, 5);
	});
});
