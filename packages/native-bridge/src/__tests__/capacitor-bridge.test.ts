/**
 * These tests run against the REAL @capacitor/core under bun test (no
 * WKWebView/Android WebView, no native NativeBridge plugin registered) — so
 * they exercise `registerPlugin`'s own "not implemented on this platform"
 * behavior and this module's stub methods, NOT a real device round trip. A
 * genuine JS<->native call requires the app running in a simulator/emulator
 * or on device; that is out of reach of `bun test` and is called out as such
 * in the M3 handoff.
 */
// Test fixtures deliberately narrow-cast, same as web-fallback.test.ts.
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { describe, expect, test } from "bun:test";
import { createCapacitorBridge, mapNativeTranscribeResult } from "../capacitor-bridge";
import { NativeBridgeError } from "../types";
import type { MediaHandle, PickMediaOptions } from "../types";

describe("createCapacitorBridge", () => {
	const bridge = createCapacitorBridge();

	test("platform resolves via Capacitor.getPlatform() ('web' under bun test)", () => {
		expect(bridge.platform).toBe("web");
	});

	test("pickMedia is stubbed pending M4", async () => {
		const opts: PickMediaOptions = { kinds: ["video"], allowMultiple: false };
		await expect(bridge.pickMedia(opts)).rejects.toThrow(NativeBridgeError);
		await expect(bridge.pickMedia(opts)).rejects.toMatchObject({
			code: "NOT_IMPLEMENTED",
		});
	});

	test("generateProxy is stubbed pending M4", async () => {
		const handle = { id: "x" } as MediaHandle;
		const it = bridge.generateProxy({
			handle,
			spec: { targetHeight: 540, shortGop: true },
		});
		await expect(it.next()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
	});

	test("exportProject is stubbed pending M9", async () => {
		const it = bridge.exportProject({ edl: {} as never });
		await expect(it.next()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
	});

	test("transcribe rejects under bun test — no native NativeBridge.transcribe() registered (M10's native half; see capacitor-bridge.ts header)", async () => {
		const handle = { id: "x", uri: "file:///tmp/clip.m4a" } as MediaHandle;
		const it = bridge.transcribe({ handle, opts: { modelSize: "tiny" } });
		await expect(it.next()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
	});

	describe("mapNativeTranscribeResult — the real, testable-without-native part of M10's transcribe()", () => {
		test("runs each segment's raw tokens through the mandatory smoothing pass and produces word-level TranscriptSegments", () => {
			const segments = mapNativeTranscribeResult({
				segments: [
					{
						startMicros: 0,
						endMicros: 1_000_000,
						text: "hi there",
						confidence: 0.9,
						tokens: [
							{
								text: " hi",
								coarseStartMicros: 0,
								coarseEndMicros: 300_000,
								dtwStartMicros: 0,
								confidence: 0.95,
							},
							{
								text: " there",
								coarseStartMicros: 300_000,
								coarseEndMicros: 700_000,
								dtwStartMicros: 300_000,
								confidence: 0.9,
							},
						],
					},
				],
			});
			expect(segments).toHaveLength(1);
			expect(segments[0].words).toHaveLength(2);
			expect(segments[0].words[0].text.trim()).toBe("hi");
			expect(segments[0].words[1].text.trim()).toBe("there");
			// Non-decreasing across the whole segment — the smoothing pass's
			// own invariant, now proven to survive the wire-shape mapping too.
			expect(segments[0].words[1].startMicros).toBeGreaterThanOrEqual(
				segments[0].words[0].endMicros,
			);
		});

		test("merges a raw punctuation token into its preceding word instead of yielding it standalone", () => {
			const segments = mapNativeTranscribeResult({
				segments: [
					{
						startMicros: 0,
						endMicros: 1_000_000,
						text: "hi,",
						confidence: 0.9,
						tokens: [
							{
								text: " hi",
								coarseStartMicros: 0,
								coarseEndMicros: 300_000,
								dtwStartMicros: 0,
								confidence: 0.95,
							},
							{
								text: ",",
								coarseStartMicros: 300_000,
								coarseEndMicros: 400_000,
								dtwStartMicros: 300_000,
								confidence: 0.5,
							},
						],
					},
				],
			});
			expect(segments[0].words).toHaveLength(1);
			expect(segments[0].words[0].text).toBe(" hi,");
		});
	});

	test("capabilities() rejects when the native NativeBridge plugin isn't registered (expected under bun test — no native runtime)", async () => {
		await expect(bridge.capabilities()).rejects.toBeTruthy();
	});
});
