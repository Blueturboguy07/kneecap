/**
 * Caption style presets — plan M10 item 6 ("Caption styling panel + an
 * 'Apply to all' primitive"), corpus `05` §9 Styling: "tap the Style tab and
 * choose your font, size, text colour, background, and any animation
 * effects... look for the Apply to All... button."
 *
 * A preset is a NAMED BUNDLE of the same `params` keys a caption element
 * already carries (`captionElementParams`, `params/registry.ts`) — applying a
 * preset is a plain snapshot-copy of values into `element.params`, not a live
 * binding. This is deliberate and matches the corpus's own observation that
 * "per-segment overrides still work afterward": once applied, a caption's
 * params are just params, editable one at a time like any other element,
 * exactly like every other "Apply to all" pattern in this engine (there is no
 * separate "preset ref" the renderer or EDL builder has to resolve — see
 * `edl/build.ts`'s `params: { ...element.params }` passthrough, which is
 * v1's single source of truth for how generated-content styling reaches a
 * native mapper).
 *
 * `kneecap-cyan` is the one preset that is NOT a CapCut lookalike on purpose —
 * plan §8.0 item 3 (UI target) calls out `#00CAE0` as an in-scope kneecap
 * brand token even under full pixel fidelity to CapCut's own chrome; a
 * cyan-highlight karaoke preset is a legitimate place to use it since preset
 * *choices* (as opposed to the app's chrome) were never part of the pixel-op
 * fidelity target to begin with.
 */

import type { ParamValues } from "@/params";

export type CaptionPosition = "top" | "center" | "bottom";
export type CaptionAnimationStyle = "karaoke" | "pop" | "none";

export interface CaptionStylePreset {
	id: string;
	name: string;
	/** Snapshot-applied onto a caption element's `params`. Keys mirror
	 * `captionElementParams` in `params/registry.ts` exactly. */
	params: ParamValues;
}

const KNEECAP_CYAN = "#00CAE0";

export const CAPTION_STYLE_PRESETS: readonly CaptionStylePreset[] = [
	{
		id: "classic",
		name: "Classic",
		params: {
			fontFamily: "Arial",
			fontSize: 22,
			fontWeight: "bold",
			color: "#ffffff",
			highlightColor: "#FFDE59",
			strokeColor: "#000000",
			strokeWidth: 6,
			"background.enabled": false,
			"background.color": "#000000",
			"activeWordBackground.enabled": false,
			"activeWordBackground.color": "#FFDE59",
			position: "bottom" satisfies CaptionPosition,
			uppercase: false,
			animationStyle: "karaoke" satisfies CaptionAnimationStyle,
		},
	},
	{
		id: "bold-highlight",
		name: "Bold Highlight",
		params: {
			fontFamily: "Arial",
			fontSize: 24,
			fontWeight: "bold",
			color: "#ffffff",
			highlightColor: "#ffffff",
			strokeColor: "#000000",
			strokeWidth: 0,
			"background.enabled": false,
			"background.color": "#000000",
			"activeWordBackground.enabled": true,
			"activeWordBackground.color": "#39E35C",
			position: "bottom" satisfies CaptionPosition,
			uppercase: true,
			animationStyle: "pop" satisfies CaptionAnimationStyle,
		},
	},
	{
		id: "kneecap-cyan",
		name: "Cyan Karaoke",
		params: {
			fontFamily: "Arial",
			fontSize: 23,
			fontWeight: "bold",
			color: "#ffffff",
			highlightColor: KNEECAP_CYAN,
			strokeColor: "#000000",
			strokeWidth: 5,
			"background.enabled": false,
			"background.color": "#000000",
			"activeWordBackground.enabled": false,
			"activeWordBackground.color": KNEECAP_CYAN,
			position: "bottom" satisfies CaptionPosition,
			uppercase: false,
			animationStyle: "karaoke" satisfies CaptionAnimationStyle,
		},
	},
	{
		id: "minimal",
		name: "Minimal",
		params: {
			fontFamily: "Arial",
			fontSize: 18,
			fontWeight: "normal",
			color: "#d4d4d4",
			highlightColor: "#ffffff",
			strokeColor: "#000000",
			strokeWidth: 0,
			"background.enabled": true,
			"background.color": "#00000099",
			"activeWordBackground.enabled": false,
			"activeWordBackground.color": "#ffffff",
			position: "top" satisfies CaptionPosition,
			uppercase: false,
			animationStyle: "none" satisfies CaptionAnimationStyle,
		},
	},
] as const;

export const DEFAULT_CAPTION_STYLE_PRESET_ID = "classic";

export function getCaptionStylePreset({
	id,
}: {
	id: string;
}): CaptionStylePreset | null {
	return CAPTION_STYLE_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function getDefaultCaptionStylePreset(): CaptionStylePreset {
	const preset = getCaptionStylePreset({ id: DEFAULT_CAPTION_STYLE_PRESET_ID });
	if (!preset) {
		throw new Error(
			`captions/styles.ts: DEFAULT_CAPTION_STYLE_PRESET_ID "${DEFAULT_CAPTION_STYLE_PRESET_ID}" has no matching preset`,
		);
	}
	return preset;
}

/** Builds the params patch for "Apply [preset] to this caption" — the preset
 * bundle plus `stylePresetId` bookkeeping so the UI can show which preset (if
 * any) a caption's current params still match. */
export function buildCaptionStyleParamsPatch({
	presetId,
}: {
	presetId: string;
}): ParamValues {
	const preset = getCaptionStylePreset({ id: presetId });
	if (!preset) {
		throw new Error(`captions/styles.ts: unknown caption style preset "${presetId}"`);
	}
	return { ...preset.params, stylePresetId: preset.id };
}
