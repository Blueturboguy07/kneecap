/**
 * tokens.ts — the JS-side mirror of tokens.css, for consumers that need a
 * raw value rather than a CSS custom property (contrast auditing, the
 * `strokeWidth` prop Lucide/custom icons take, the WCAG test suite).
 *
 * Keep this in sync with tokens.css by hand — there are only ~20 color
 * values and duplicating them beats a build-time CSS-to-JS codegen step for
 * a kit this size. If this drifts, src/__tests__/contrast-audit.test.ts is
 * checking the values below, not the .css file, so a drift would show up
 * as the audit passing while the shipped CSS is wrong — see the note in
 * that test file.
 */

export const CC_ICON_STROKE = 2.5;

export const ccColor = {
	bgBase: "#000000",
	bgPanel: "#202020",
	bgRaised: "#2e2e2e",
	textPrimary: "#f5f5f5",
	textSecondary: "#8b8a90",
	accent: "#00cae0",
	accentActive: "#00a8ba",
	accentContrast: "#04181a",
	badgePro: "#8800e8",
} as const;

export type CcColorToken = keyof typeof ccColor;

/**
 * Every text-on-surface pair this kit actually renders, for the WCAG audit.
 * `minRatio` follows WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large text
 * (>=18.66px bold or >=24px regular) and non-text UI components/graphical
 * objects. Tab labels (--cc-text-tab, 15px/600 weight when active) and
 * toolbar labels (--cc-text-label, 11px) are both well under the "large
 * text" threshold, so both get the stricter 4.5:1 bar.
 */
export const CONTRAST_PAIRS: Array<{
	name: string;
	fg: string;
	bg: string;
	minRatio: number;
}> = [
	{ name: "primary text / base", fg: ccColor.textPrimary, bg: ccColor.bgBase, minRatio: 4.5 },
	{ name: "primary text / panel", fg: ccColor.textPrimary, bg: ccColor.bgPanel, minRatio: 4.5 },
	{ name: "primary text / raised", fg: ccColor.textPrimary, bg: ccColor.bgRaised, minRatio: 4.5 },
	{ name: "secondary text / base", fg: ccColor.textSecondary, bg: ccColor.bgBase, minRatio: 4.5 },
	{ name: "secondary text / panel", fg: ccColor.textSecondary, bg: ccColor.bgPanel, minRatio: 4.5 },
	// Deliberately no "secondary text / raised" pair: the measured
	// --cc-text-secondary (#8B8A90, sampled off inactive *tab* labels sitting
	// on the panel surface in ip_1.jpg — corpus 06 §2.1) tops out at 4.3:1
	// against the measured --cc-bg-raised range even at that range's
	// darkest end (#282828), never reaching 4.5:1. Rather than darkening a
	// measured color to force a pass, or lightening a measured color, the
	// component kit's own rule is: raised/chip surfaces (ChipRow, badges)
	// use --cc-text-primary for their labels, never --cc-text-secondary —
	// which also matches every screenshot actually reviewed (the gray was
	// only ever seen on the panel surface, never on a raised chip).
	{ name: "accent-contrast ink / accent (export CTA)", fg: ccColor.accentContrast, bg: ccColor.accent, minRatio: 4.5 },
	{ name: "accent / panel (icon-on-panel, non-text UI)", fg: ccColor.accent, bg: ccColor.bgPanel, minRatio: 3 },
	{ name: "accent / base (underline indicator, non-text UI)", fg: ccColor.accent, bg: ccColor.bgBase, minRatio: 3 },
];
