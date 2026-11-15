import { describe, expect, test } from "bun:test";
import type { SceneTracks } from "@kneecap/editor-core/timeline";
import { friendlyClipNames, isMachineFileName } from "./clip-names";

function element(id: string, type: string, name: string, startTime: number) {
	return { id, type, name, startTime };
}

function tracks({
	main,
	overlay = [],
	audio = [],
}: {
	main: ReturnType<typeof element>[];
	overlay?: ReturnType<typeof element>[][];
	audio?: ReturnType<typeof element>[][];
}): SceneTracks {
	return {
		main: { id: "main", elements: main },
		overlay: overlay.map((elements, i) => ({ id: `o${i}`, elements })),
		audio: audio.map((elements, i) => ({ id: `a${i}`, elements })),
	} as unknown as SceneTracks;
}

describe("isMachineFileName", () => {
	test("finds machine-made names", () => {
		expect(isMachineFileName("3F2504E0-4F89-11D3-9A0C-0305E82C3301.jpeg")).toBe(true);
		expect(isMachineFileName("image-3F2504E0-4F89-11D3-9A0C-0305E82C3301.png")).toBe(true);
		expect(isMachineFileName("1000012345.jpg")).toBe(true);
		expect(isMachineFileName("")).toBe(true);
	});

	test("keeps real names", () => {
		expect(isMachineFileName("IMG_0042.HEIC")).toBe(false);
		expect(isMachineFileName("beach.png")).toBe(false);
		expect(isMachineFileName("Upbeat Groove")).toBe(false);
		expect(isMachineFileName("facade.mov")).toBe(false);
	});
});

describe("friendlyClipNames", () => {
	test("numbers each kind in timeline order and keeps real names", () => {
		const uuid = "3F2504E0-4F89-11D3-9A0C-0305E82C3301.jpeg";
		const names = friendlyClipNames({
			tracks: tracks({
				// Out of order on purpose: numbering follows start time.
				main: [element("v2", "video", "11111111.mov", 50), element("v1", "video", "22222222.mov", 0)],
				overlay: [[element("p1", "image", uuid, 0), element("p2", "image", "beach.png", 10), element("t1", "text", "", 0)]],
				audio: [[element("a1", "audio", "33333333.m4a", 0)]],
			}),
		});
		expect(names.get("v1")).toBe("Video 1");
		expect(names.get("v2")).toBe("Video 2");
		expect(names.get("p1")).toBe("Photo 1");
		expect(names.has("p2")).toBe(false);
		expect(names.has("t1")).toBe(false);
		expect(names.get("a1")).toBe("Audio 1");
	});
});
