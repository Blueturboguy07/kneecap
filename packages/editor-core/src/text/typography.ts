export const MIN_FONT_SIZE = 5;
export const MAX_FONT_SIZE = 300;
export const DEFAULT_TEXT_COLOR = "#000000";

/**
 * higher value: smaller font size
 * lower value: larger font size
 */
export const FONT_SIZE_SCALE_REFERENCE = 90;

/**
 * The "thin black border" weight, as a PERCENT OF FONT SIZE (round 33) —
 * the same unit CoreText's `kCTStrokeWidth` takes, so the preview's
 * canvas `lineWidth = strokeWidth/100 × scaledFontSize` and the export's
 * stroke attribute are the same number by construction, at any canvas
 * size. (Round 31 shipped these as "font-size units" scaled by
 * scaledFontSize/fontSize, which silently turned a preset's `6` into 33%
 * of the font size and buried exported captions in black.)
 *
 * MEASURED, not guessed: the reference web editor's text stroke defaults to Size 40
 * (of 100), which pixel-analysis of their canvas put at ~13px of visible
 * outline on a ~135px cap height — a heavy poster outline, ~10% of the
 * font size per side (~20% total). That is their DEFAULT-when-enabled;
 * the founder asked for a THIN border, so this ships at 2% total (~1%
 * per side, since a stroke straddles the glyph outline): a crisp
 * legibility edge, not a sticker outline. The Border slider reaches
 * the reference editor's weight.
 */
export const DEFAULT_TEXT_BORDER_WIDTH = 2;
