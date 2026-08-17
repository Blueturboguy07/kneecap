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
import { createCapacitorBridge } from "../capacitor-bridge";
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

	test("transcribe is stubbed pending M10", async () => {
		const handle = { id: "x" } as MediaHandle;
		const it = bridge.transcribe({ handle, opts: { modelSize: "tiny" } });
		await expect(it.next()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
	});

	test("capabilities() rejects when the native NativeBridge plugin isn't registered (expected under bun test — no native runtime)", async () => {
		await expect(bridge.capabilities()).rejects.toBeTruthy();
	});
});
