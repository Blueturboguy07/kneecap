import type { EffectDefinition } from "@/effects/types";

/**
 * M8 "Adjust" panel — plan §8.4: "basic sliders in v1; HSL and curves
 * deferred." Task scope narrows this further to exactly the seven sliders
 * corpus `04` §3.8 names as the core CapCut Adjust set: brightness,
 * contrast, saturation, temperature, tint, sharpen, vignette.
 *
 * HONEST SCOPE NOTE: this is a real `EffectDefinition` — registered in the
 * same `effectsRegistry` as `blur`, round-trips through `element.effects`,
 * undoable, keyframable, EDL-serializable — but unlike `blur` (which has a
 * real WGSL pass at `rust/crates/effects/src/shaders/gaussian_blur.wgsl`
 * consumed by the wgpu compositor), no corresponding shader exists for
 * "adjust" in the Rust engine yet. `renderer.passes` is empty and
 * `buildPasses` returns `[]` — a code path already exercised by blur itself
 * at zero intensity (see `blur.ts`), so this is a normal, safe, no-op
 * render contribution, not a hack. Building the seven GPU passes (or a
 * single combined color-grade pass) is compositor/rendering work, out of
 * scope for M8 (panels/toolbars/export sheet). The UI slider <-> engine
 * state wiring here is fully real and independently verified; the VISIBLE
 * preview effect is not implemented this session.
 */
export const ADJUST_EFFECT_TYPE = "adjust";

const NEUTRAL_RANGE = { min: -100, max: 100, step: 1, default: 0 } as const;
const ZERO_TO_HUNDRED = { min: 0, max: 100, step: 1, default: 0 } as const;

export const adjustEffectDefinition: EffectDefinition = {
	type: ADJUST_EFFECT_TYPE,
	name: "Adjust",
	keywords: ["adjust", "color", "brightness", "contrast", "saturation"],
	params: [
		{
			key: "brightness",
			label: "Brightness",
			type: "number",
			...NEUTRAL_RANGE,
		},
		{
			key: "contrast",
			label: "Contrast",
			type: "number",
			...NEUTRAL_RANGE,
		},
		{
			key: "saturation",
			label: "Saturation",
			type: "number",
			...NEUTRAL_RANGE,
		},
		{
			key: "temperature",
			label: "Temperature",
			type: "number",
			...NEUTRAL_RANGE,
		},
		{
			key: "tint",
			label: "Tint",
			type: "number",
			...NEUTRAL_RANGE,
		},
		{
			key: "sharpen",
			label: "Sharpen",
			type: "number",
			...ZERO_TO_HUNDRED,
		},
		{
			key: "vignette",
			label: "Vignette",
			type: "number",
			...ZERO_TO_HUNDRED,
		},
	],
	renderer: {
		passes: [],
		buildPasses: () => [],
	},
};
