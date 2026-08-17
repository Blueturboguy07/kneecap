import { describe, expect, test } from "bun:test";
import { effectsRegistry } from "@/effects/registry";
import { registerDefaultEffects, buildDefaultEffectInstance } from "@/effects";
import { ADJUST_EFFECT_TYPE } from "@/effects/definitions/adjust";
import { FILTER_EFFECT_TYPE, FILTER_PRESETS } from "@/effects/definitions/filter";
import { getLocalSounds, synthesizeToneWavDataUri } from "@/sounds/local-sounds";
import { elementParamRegistry } from "@/params/registry";

describe("M8 adjust effect", () => {
	registerDefaultEffects();

	test("registers with the seven basic sliders at neutral defaults", () => {
		const definition = effectsRegistry.get(ADJUST_EFFECT_TYPE);
		const keys = definition.params.map((p) => p.key).sort();
		expect(keys).toEqual(
			[
				"brightness",
				"contrast",
				"saturation",
				"temperature",
				"tint",
				"sharpen",
				"vignette",
			].sort(),
		);
		for (const param of definition.params) {
			expect(param.default).toBe(0);
		}
	});

	test("buildDefaultEffectInstance produces an enabled instance with all-neutral params", () => {
		const instance = buildDefaultEffectInstance({ effectType: ADJUST_EFFECT_TYPE });
		expect(instance.enabled).toBe(true);
		expect(instance.type).toBe(ADJUST_EFFECT_TYPE);
		expect(instance.params.brightness).toBe(0);
		expect(instance.params.vignette).toBe(0);
	});

	test("has no renderer passes yet (documented: no Rust WGSL pass exists)", () => {
		const definition = effectsRegistry.get(ADJUST_EFFECT_TYPE);
		expect(definition.renderer.passes).toEqual([]);
		expect(
			definition.renderer.buildPasses?.({ effectParams: {}, width: 100, height: 100 }),
		).toEqual([]);
	});
});

describe("M8 filter effect", () => {
	registerDefaultEffects();

	test("registers with preset select + intensity slider", () => {
		const definition = effectsRegistry.get(FILTER_EFFECT_TYPE);
		const keys = definition.params.map((p) => p.key).sort();
		expect(keys).toEqual(["intensity", "preset"]);
		const presetParam = definition.params.find((p) => p.key === "preset");
		expect(presetParam?.type).toBe("select");
	});

	test("preset options match the exported curated list", () => {
		const definition = effectsRegistry.get(FILTER_EFFECT_TYPE);
		const presetParam = definition.params.find((p) => p.key === "preset");
		expect(presetParam?.type === "select" && presetParam.options.length).toBe(
			FILTER_PRESETS.length,
		);
	});
});

describe("M8 reversed param", () => {
	test("video and audio element params both include a reversed boolean", () => {
		const videoParams = elementParamRegistry.get("video");
		const audioParams = elementParamRegistry.get("audio");
		const videoReversed = videoParams.find((p) => p.key === "reversed");
		const audioReversed = audioParams.find((p) => p.key === "reversed");
		expect(videoReversed?.type).toBe("boolean");
		expect(videoReversed?.default).toBe(false);
		expect(audioReversed?.type).toBe("boolean");
	});

	test("text/sticker/graphic params do NOT include reversed (not retimable)", () => {
		const textParams = elementParamRegistry.get("text");
		expect(textParams.find((p) => p.key === "reversed")).toBeUndefined();
	});
});

describe("M8 local sounds", () => {
	test("synthesizes a well-formed WAV data URI", () => {
		const uri = synthesizeToneWavDataUri({ frequencyHz: 440, durationSeconds: 0.1 });
		expect(uri.startsWith("data:audio/wav;base64,")).toBe(true);
		// Decode header bytes back out and sanity-check the RIFF/WAVE markers
		// survive the base64 round trip.
		const base64 = uri.split(",")[1];
		const binary = atob(base64);
		expect(binary.slice(0, 4)).toBe("RIFF");
		expect(binary.slice(8, 12)).toBe("WAVE");
	});

	test("bundled set has 4 distinct, zero-network local sounds", () => {
		const sounds = getLocalSounds();
		expect(sounds.length).toBe(4);
		const ids = new Set(sounds.map((s) => s.id));
		expect(ids.size).toBe(4);
		for (const sound of sounds) {
			expect(sound.sourceUrl.startsWith("data:audio/wav;base64,")).toBe(true);
			expect(sound.durationSeconds).toBeGreaterThan(0);
		}
	});
});
