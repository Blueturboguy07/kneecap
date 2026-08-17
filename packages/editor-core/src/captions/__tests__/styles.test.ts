import { describe, expect, test } from "bun:test";
import {
	buildCaptionStyleParamsPatch,
	CAPTION_STYLE_PRESETS,
	DEFAULT_CAPTION_STYLE_PRESET_ID,
	getCaptionStylePreset,
	getDefaultCaptionStylePreset,
} from "../styles";

describe("CAPTION_STYLE_PRESETS", () => {
	test("has unique, non-empty ids", () => {
		const ids = CAPTION_STYLE_PRESETS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.every((id) => id.length > 0)).toBe(true);
	});

	test("every preset defines every key the default preset defines (no partial bundles)", () => {
		const defaultKeys = Object.keys(getDefaultCaptionStylePreset().params).sort();
		for (const preset of CAPTION_STYLE_PRESETS) {
			expect(Object.keys(preset.params).sort()).toEqual(defaultKeys);
		}
	});

	test("the default preset id resolves to a real preset", () => {
		expect(getCaptionStylePreset({ id: DEFAULT_CAPTION_STYLE_PRESET_ID })).not.toBeNull();
	});

	test("kneecap-cyan preset uses the kneecap brand cyan as its highlight color (plan §8.0 item 3)", () => {
		const preset = getCaptionStylePreset({ id: "kneecap-cyan" });
		expect(preset?.params.highlightColor).toBe("#00CAE0");
	});
});

describe("getCaptionStylePreset", () => {
	test("returns null for an unknown id", () => {
		expect(getCaptionStylePreset({ id: "does-not-exist" })).toBeNull();
	});
});

describe("buildCaptionStyleParamsPatch", () => {
	test("returns the preset's params plus stylePresetId bookkeeping", () => {
		const patch = buildCaptionStyleParamsPatch({ presetId: "bold-highlight" });
		expect(patch.stylePresetId).toBe("bold-highlight");
		expect(patch["activeWordBackground.enabled"]).toBe(true);
	});

	test("throws on an unknown preset id rather than silently no-op'ing", () => {
		expect(() => buildCaptionStyleParamsPatch({ presetId: "nope" })).toThrow();
	});
});
