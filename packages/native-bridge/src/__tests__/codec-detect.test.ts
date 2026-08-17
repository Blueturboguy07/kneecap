// `globalThis as Globals` mirrors codec-detect.ts's own cast — this file
// mocks the same untyped WebCodecs globals it exercises.
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { afterEach, describe, expect, test } from "bun:test";
import { probeCodecs, safeIsConfigSupported } from "../codec-detect";

// Deliberately NOT `typeof globalThis & {...}`: intersecting with the real
// ambient `VideoDecoder`/`VideoEncoder` (lib.dom's actual, much stricter
// class types, complete with `prototype`) would force every mock below to
// satisfy that full shape too. This mirrors codec-detect.ts's own
// `MinimalCodecStatic`, not the real WebCodecs types — matching production.
interface Globals {
	VideoDecoder?: {
		isConfigSupported: (config: { codec: string }) => Promise<{ supported?: boolean }>;
	};
	VideoEncoder?: {
		isConfigSupported: (config: { codec: string }) => Promise<{ supported?: boolean }>;
	};
}

const g = globalThis as unknown as Globals;

afterEach(() => {
	delete g.VideoDecoder;
	delete g.VideoEncoder;
});

describe("safeIsConfigSupported", () => {
	test("returns false when the API is absent (e.g. bun test, no WebCodecs)", async () => {
		const result = await safeIsConfigSupported({
			direction: "decode",
			config: { codec: "avc1.42001f" },
		});
		expect(result).toBe(false);
	});

	test("returns true when isConfigSupported resolves {supported:true}", async () => {
		g.VideoDecoder = {
			isConfigSupported: async () => ({ supported: true }),
		};
		const result = await safeIsConfigSupported({
			direction: "decode",
			config: { codec: "avc1.42001f" },
		});
		expect(result).toBe(true);
	});

	test("returns false when isConfigSupported resolves {supported:false}", async () => {
		g.VideoEncoder = {
			isConfigSupported: async () => ({ supported: false }),
		};
		const result = await safeIsConfigSupported({
			direction: "encode",
			config: { codec: "hvc1.1.6.L93.B0" },
		});
		expect(result).toBe(false);
	});

	test("swallows a throw (mediabunny#456: iOS Safari throws instead of resolving false)", async () => {
		g.VideoEncoder = {
			isConfigSupported: async () => {
				throw new TypeError("iOS Safari's actual documented misbehavior");
			},
		};
		const result = await safeIsConfigSupported({
			direction: "encode",
			config: { codec: "av01.0.04M.08" },
		});
		expect(result).toBe(false);
	});
});

describe("probeCodecs", () => {
	test("returns empty decode/encode lists with no WebCodecs global present", async () => {
		const codecs = await probeCodecs();
		expect(codecs).toEqual({ decode: [], encode: [] });
	});

	test("reports only the codecs the mocked API says are supported", async () => {
		g.VideoDecoder = {
			isConfigSupported: async ({ codec }: { codec: string }) => ({
				supported: codec.startsWith("avc1"),
			}),
		};
		g.VideoEncoder = {
			isConfigSupported: async () => ({ supported: false }),
		};
		const codecs = await probeCodecs();
		expect(codecs.decode).toEqual(["h264"]);
		expect(codecs.encode).toEqual([]);
	});
});
