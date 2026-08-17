import { describe, expect, test } from "bun:test";
import { resolveCaptionStyle } from "../resolve-style";
import type { CaptionElement } from "@/timeline/types";
import type { ParamValue } from "@/params";
import { buildDefaultParamValues, getBuiltInElementParams } from "@/params/registry";
import { ZERO_MEDIA_TIME } from "@/wasm";

function buildElement(paramOverrides: Record<string, ParamValue> = {}): CaptionElement {
	return {
		id: "el-1",
		type: "caption",
		name: "Caption",
		startTime: ZERO_MEDIA_TIME,
		duration: ZERO_MEDIA_TIME,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		words: [],
		params: {
			...buildDefaultParamValues(getBuiltInElementParams({ type: "caption" })),
			...paramOverrides,
		},
	};
}

describe("resolveCaptionStyle", () => {
	test("reads registry defaults for a freshly-generated caption", () => {
		const style = resolveCaptionStyle({ element: buildElement() });
		expect(style.position).toBe("bottom");
		expect(style.fontWeight).toBe("bold");
		expect(style.animationStyle).toBe("karaoke");
	});

	test("falls back safely when a param is missing or malformed (e.g. a stale/hand-edited document)", () => {
		const style = resolveCaptionStyle({
			element: buildElement({ position: "diagonal", fontWeight: 42 }),
		});
		expect(style.position).toBe("bottom");
		expect(style.fontWeight).toBe("normal");
	});

	test("reflects an applied style preset's overrides", () => {
		const style = resolveCaptionStyle({
			element: buildElement({
				highlightColor: "#00CAE0",
				"activeWordBackground.enabled": true,
			}),
		});
		expect(style.highlightColor).toBe("#00CAE0");
		expect(style.activeWordBackgroundEnabled).toBe(true);
	});
});
