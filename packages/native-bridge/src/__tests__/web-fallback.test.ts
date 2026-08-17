// Test fixtures deliberately narrow-cast (`{} as never`, `{...} as MediaHandle`)
// to build minimal stand-ins for types this file doesn't need in full — same
// pattern as packages/editor-core/src/edl/__tests__/edl.test.ts.
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { describe, expect, test } from "bun:test";
import { createWebFallbackBridge, inferMediaKind } from "../web-fallback";
import { NativeBridgeError } from "../types";
import type { MediaHandle } from "../types";
import {
	DEV_FIXTURE_MEDIA_HANDLE,
	DEV_SAMPLE_TRANSCRIPT_SEGMENTS,
} from "../dev-fixtures/sample-transcript";

describe("inferMediaKind", () => {
	test("classifies by MIME prefix", () => {
		expect(inferMediaKind("video/mp4")).toBe("video");
		expect(inferMediaKind("audio/mpeg")).toBe("audio");
		expect(inferMediaKind("image/png")).toBe("image");
	});

	test("defaults unrecognized MIME types to image (conservative, never assumes video)", () => {
		expect(inferMediaKind("application/octet-stream")).toBe("image");
	});
});

describe("createWebFallbackBridge", () => {
	const bridge = createWebFallbackBridge();

	test("platform is 'web'", () => {
		expect(bridge.platform).toBe("web");
	});

	test("generateProxy is an honest passthrough: proxyUri === the source handle's uri", async () => {
		const handle: MediaHandle = {
			id: "asset-1",
			uri: "blob:web-fallback-fixture",
			kind: "video",
			fileName: "clip.mp4",
			sizeBytes: 1024,
			durationMicros: 2_000_000,
			width: 1920,
			height: 1080,
			rotationDegrees: 0,
			hasAudio: true,
			codec: "video/mp4",
			frameRate: { numerator: 30, denominator: 1 },
		};
		const events = [];
		for await (const p of bridge.generateProxy({
			handle,
			spec: { targetHeight: 540, shortGop: true },
		})) {
			events.push(p);
		}
		expect(events).toEqual([
			{ assetId: "asset-1", stage: "done", fraction: 1, proxyUri: handle.uri },
		]);
	});

	test("exportProject throws a typed NativeBridgeError naming the real (native) implementation", async () => {
		const iterator = bridge.exportProject({ edl: {} as never });
		let caught: unknown;
		try {
			await iterator.next();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NativeBridgeError);
		expect((caught as InstanceType<typeof NativeBridgeError>).code).toBe(
			"UNSUPPORTED",
		);
	});

	test("transcribe throws a typed NativeBridgeError naming the real (native) implementation", async () => {
		const handle = { id: "x" } as MediaHandle;
		const iterator = bridge.transcribe({ handle, opts: { modelSize: "tiny" } });
		let caught: unknown;
		try {
			await iterator.next();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NativeBridgeError);
		expect((caught as InstanceType<typeof NativeBridgeError>).code).toBe(
			"UNSUPPORTED",
		);
	});

	test("generateThumbnails throws UNSUPPORTED (plan M4 item 5: never decode filmstrip frames in JS, even as a fallback)", async () => {
		const handle = { id: "x" } as MediaHandle;
		let caught: unknown;
		try {
			await bridge.generateThumbnails({
				handle,
				spec: { count: 5, maxEdgePx: 200 },
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NativeBridgeError);
		expect((caught as InstanceType<typeof NativeBridgeError>).code).toBe(
			"UNSUPPORTED",
		);
	});

	test("transcribe() yields the dev-harness fixture for its recognized sentinel handle, never touching whisper.cpp/native", async () => {
		const yielded = [];
		for await (const segment of bridge.transcribe({
			handle: DEV_FIXTURE_MEDIA_HANDLE,
			opts: { modelSize: "tiny" },
		})) {
			yielded.push(segment);
		}
		expect(yielded).toEqual(DEV_SAMPLE_TRANSCRIPT_SEGMENTS);
	});

	test("transcribe() still throws UNSUPPORTED for a real (non-fixture) handle picked via the file input — the fixture path is not a general in-webview STT backdoor", async () => {
		const realHandle: MediaHandle = {
			...DEV_FIXTURE_MEDIA_HANDLE,
			id: "web-123",
			uri: "blob:a-real-user-picked-file",
		};
		const iterator = bridge.transcribe({ handle: realHandle, opts: { modelSize: "tiny" } });
		let caught: unknown;
		try {
			await iterator.next();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NativeBridgeError);
		expect((caught as InstanceType<typeof NativeBridgeError>).code).toBe(
			"UNSUPPORTED",
		);
	});

	test("capabilities() resolves in a DOM-less environment (bun test) with conservative defaults", async () => {
		const caps = await bridge.capabilities();
		expect(caps.platform).toBe("web");
		expect(caps.supportsNativeExport).toBe(false);
		expect(caps.supportsOnDeviceStt).toBe(false);
		expect(caps.gpuBackend).toBe("unknown");
	});
});
