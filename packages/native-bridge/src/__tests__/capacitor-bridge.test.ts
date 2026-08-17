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
import type { MediaHandle, PickMediaOptions } from "../types";

describe("createCapacitorBridge", () => {
	const bridge = createCapacitorBridge();

	test("platform resolves via Capacitor.getPlatform() ('web' under bun test)", () => {
		expect(bridge.platform).toBe("web");
	});

	test("toPlaybackUri converts a native path via Capacitor.convertFileSrc", () => {
		// Under `bun test`'s web platform, Capacitor.convertFileSrc is a
		// pass-through (the real path-rewrite only exists in the native iOS/
		// Android runtime) — so this just proves the method is wired at all,
		// not the iOS `_capacitor_file_` rewrite itself (unverifiable outside
		// a real WKWebView; see the M4 handoff).
		expect(bridge.toPlaybackUri("/some/native/path.mp4")).toBe(
			"/some/native/path.mp4",
		);
	});

	// kneecap M4: pickMedia/generateProxy now call through to the real
	// native `NativeBridge` plugin (iOS: NativeBridgePlugin+Media.swift).
	// Under `bun test` there's no native runtime to answer them, so — same
	// as the `capabilities()` test below — these exercise Capacitor's OWN
	// "plugin not implemented on web" rejection, not this module's stub
	// behavior (that behavior moved to `exportProject`/`transcribe`, still
	// genuinely stubbed pending M9/M10). A real pickMedia/generateProxy
	// round trip requires the app running in a simulator/emulator or on
	// device — see the M4 handoff for what WAS exercised that way
	// (`apps/mobile/ios/verify-media-pipeline` against the native Swift
	// logic directly, plus a real Xcode build+launch).
	test("pickMedia calls through to the native plugin (rejects under bun test — no native runtime)", async () => {
		const opts: PickMediaOptions = { kinds: ["video"], allowMultiple: false };
		await expect(bridge.pickMedia(opts)).rejects.toBeTruthy();
	});

	test("generateProxy calls through to the native plugin (rejects under bun test — no native runtime)", async () => {
		const handle = { id: "x", uri: "/tmp/x.mp4" } as MediaHandle;
		const it = bridge.generateProxy({
			handle,
			spec: { targetHeight: 540, shortGop: true },
		});
		await expect(it.next()).rejects.toBeTruthy();
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
