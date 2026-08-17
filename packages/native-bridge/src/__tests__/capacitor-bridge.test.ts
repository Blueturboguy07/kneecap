/**
 * `createCapacitorBridge()` with no arguments (the production path) resolves
 * `registerPlugin("NativeBridge")` against the REAL `@capacitor/core` under
 * `bun test` — no WKWebView/Android WebView, no native plugin registered —
 * so those calls exercise this module's error-mapping around "no native
 * runtime present," not a real device round trip. Everything else in this
 * file injects a fake plugin (`createCapacitorBridge({ plugin })`) to
 * exercise the real orchestration logic — wire-format coercion, the
 * event-to-async-generator adapter, error-code preservation — without any
 * native runtime at all. A genuine JS<->native call requires the app running
 * in a simulator/emulator or on device; that is out of reach of `bun test`
 * and is called out as such in the M4 handoff.
 */
// Test fixtures deliberately narrow-cast, same as web-fallback.test.ts.
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { describe, expect, mock, test } from "bun:test";
import { createCapacitorBridge } from "../capacitor-bridge";
import { NativeBridgeError } from "../types";
import type { MediaHandle, PickMediaOptions, ProxyProgress } from "../types";

const FIXTURE_HANDLE: MediaHandle = {
	id: "asset-1",
	uri: "file:///data/user/0/dev.kneecap.app/no_backup/media/x.mp4",
	kind: "video",
	fileName: "clip.mp4",
	sizeBytes: 12_345,
	durationMicros: 4_000_000,
	width: 1920,
	height: 1080,
	rotationDegrees: 0,
	hasAudio: true,
	codec: "video/avc",
	frameRate: { numerator: 30, denominator: 1 },
};

/** A minimal stand-in for the native plugin proxy, typed loosely (the real
 * `NativeBridgePluginSpec` is not exported — these tests only need the
 * methods `createCapacitorBridge` actually calls). */
function fakePlugin(overrides: Record<string, unknown> = {}) {
	return {
		getDeviceInfo: mock(async () => ({
			osVersion: "14",
			deviceModel: "Pixel 8",
			ramTierMb: 8192,
		})),
		pickMedia: mock(async () => ({ handles: [] })),
		generateProxy: mock(async () => ({ assetId: FIXTURE_HANDLE.id })),
		generateThumbnails: mock(async () => ({
			assetId: FIXTURE_HANDLE.id,
			uris: [],
			timestampsMicros: [],
		})),
		addListener: mock(async () => ({ remove: mock(async () => undefined) })),
		...overrides,
	};
}

describe("createCapacitorBridge (production path, real @capacitor/core, no native runtime)", () => {
	const bridge = createCapacitorBridge();

	test("platform resolves via Capacitor.getPlatform() ('web' under bun test)", () => {
		expect(bridge.platform).toBe("web");
	});

	test("pickMedia surfaces a mapped NativeBridgeError when no native runtime is present", async () => {
		const opts: PickMediaOptions = { kinds: ["video"], allowMultiple: false };
		let caught: unknown;
		try {
			await bridge.pickMedia(opts);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NativeBridgeError);
		// Not NOT_IMPLEMENTED: the method IS implemented now (M4). The failure
		// here is "no native plugin registered under bun test," which this
		// bridge normalizes to IO_ERROR rather than crashing with a raw
		// Capacitor internal error.
		expect((caught as NativeBridgeError).code).toBe("IO_ERROR");
	});

	test("generateProxy's kickoff call surfaces the same mapped error before yielding anything", async () => {
		const it = bridge.generateProxy({
			handle: FIXTURE_HANDLE,
			spec: { targetHeight: 540, shortGop: true },
		});
		await expect(it.next()).rejects.toBeInstanceOf(NativeBridgeError);
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

	test("generateThumbnails surfaces a mapped NativeBridgeError when no native runtime is present", async () => {
		let caught: unknown;
		try {
			await bridge.generateThumbnails({
				handle: FIXTURE_HANDLE,
				spec: { count: 5, maxEdgePx: 200 },
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NativeBridgeError);
	});

	test("capabilities() rejects when the native NativeBridge plugin isn't registered (expected under bun test — no native runtime)", async () => {
		await expect(bridge.capabilities()).rejects.toBeTruthy();
	});
});

describe("createCapacitorBridge (injected fake plugin — DI seam for full orchestration coverage)", () => {
	test("pickMedia maps native wire handles to MediaHandle[] field-for-field", async () => {
		const plugin = fakePlugin({
			pickMedia: mock(async () => ({
				handles: [{ ...FIXTURE_HANDLE, rotationDegrees: 90 }],
			})),
		});
		const bridge = createCapacitorBridge({ plugin: plugin as never });
		const handles = await bridge.pickMedia({
			kinds: ["video"],
			allowMultiple: false,
		});
		expect(handles).toHaveLength(1);
		expect(handles[0]).toMatchObject({ ...FIXTURE_HANDLE, rotationDegrees: 90 });
		expect(plugin.pickMedia).toHaveBeenCalledTimes(1);
	});

	test("pickMedia defensively clamps an out-of-union rotationDegrees to 0 rather than passing it through", async () => {
		const plugin = fakePlugin({
			pickMedia: mock(async () => ({
				handles: [{ ...FIXTURE_HANDLE, rotationDegrees: 45 }],
			})),
		});
		const bridge = createCapacitorBridge({ plugin: plugin as never });
		const [handle] = await bridge.pickMedia({
			kinds: ["video"],
			allowMultiple: false,
		});
		expect(handle.rotationDegrees).toBe(0);
	});

	test("pickMedia rounds a non-integer durationMicros rather than passing a float across the boundary", async () => {
		const plugin = fakePlugin({
			pickMedia: mock(async () => ({
				handles: [{ ...FIXTURE_HANDLE, durationMicros: 1_999_999.6 }],
			})),
		});
		const bridge = createCapacitorBridge({ plugin: plugin as never });
		const [handle] = await bridge.pickMedia({
			kinds: ["video"],
			allowMultiple: false,
		});
		expect(handle.durationMicros).toBe(2_000_000);
		expect(Number.isInteger(handle.durationMicros)).toBe(true);
	});

	test("pickMedia preserves a native error's code (e.g. USER_CANCELLED) rather than flattening to IO_ERROR", async () => {
		const plugin = fakePlugin({
			pickMedia: mock(async () => {
				throw { code: "USER_CANCELLED", message: "User cancelled media selection" };
			}),
		});
		const bridge = createCapacitorBridge({ plugin: plugin as never });
		let caught: unknown;
		try {
			await bridge.pickMedia({ kinds: ["video"], allowMultiple: false });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NativeBridgeError);
		expect((caught as NativeBridgeError).code).toBe("USER_CANCELLED");
		expect((caught as NativeBridgeError).message).toBe(
			"User cancelled media selection",
		);
	});

	test("generateProxy streams proxyProgress events in order and terminates on 'done'", async () => {
		let capturedCallback: ((data: ProxyProgress) => void) | null = null;
		const removeMock = mock(async () => undefined);
		const plugin = fakePlugin({
			addListener: mock(
				async (_event: string, cb: (data: ProxyProgress) => void) => {
					capturedCallback = cb;
					return { remove: removeMock };
				},
			),
		});
		const bridge = createCapacitorBridge({ plugin: plugin as never });
		const it = bridge.generateProxy({
			handle: FIXTURE_HANDLE,
			spec: { targetHeight: 540, shortGop: true },
		});

		// Drive the generator concurrently with emitting events, the same way a
		// real caller (the M3 harness / future timeline import UI) would: it
		// awaits `.next()` while native events arrive asynchronously.
		const collected: ProxyProgress[] = [];
		const drive = (async () => {
			for await (const progress of it) collected.push(progress);
		})();

		// Let the generator install its listener before events arrive.
		await Promise.resolve();
		await Promise.resolve();
		expect(capturedCallback).not.toBeNull();

		const emit = capturedCallback as unknown as (data: ProxyProgress) => void;
		// An event for a DIFFERENT assetId must be ignored.
		emit({ assetId: "some-other-asset", stage: "transcoding", fraction: 0.9 });
		emit({ assetId: FIXTURE_HANDLE.id, stage: "transcoding", fraction: 0.25 });
		emit({ assetId: FIXTURE_HANDLE.id, stage: "transcoding", fraction: 0.75 });
		emit({
			assetId: FIXTURE_HANDLE.id,
			stage: "done",
			fraction: 1,
			proxyUri: "file:///proxy.mp4",
		});

		await drive;

		expect(collected).toEqual([
			{ assetId: FIXTURE_HANDLE.id, stage: "transcoding", fraction: 0.25 },
			{ assetId: FIXTURE_HANDLE.id, stage: "transcoding", fraction: 0.75 },
			{
				assetId: FIXTURE_HANDLE.id,
				stage: "done",
				fraction: 1,
				proxyUri: "file:///proxy.mp4",
			},
		]);
		// The listener is torn down once the stream reaches a terminal stage —
		// a generator a caller does not keep re-invoking must not leak a
		// permanent native listener.
		expect(removeMock).toHaveBeenCalledTimes(1);
	});

	test("generateProxy's stream terminates on 'error' the same way it terminates on 'done'", async () => {
		let capturedCallback: ((data: ProxyProgress) => void) | null = null;
		const plugin = fakePlugin({
			addListener: mock(
				async (_event: string, cb: (data: ProxyProgress) => void) => {
					capturedCallback = cb;
					return { remove: mock(async () => undefined) };
				},
			),
		});
		const bridge = createCapacitorBridge({ plugin: plugin as never });
		const it = bridge.generateProxy({
			handle: FIXTURE_HANDLE,
			spec: { targetHeight: 540, shortGop: true },
		});

		const collected: ProxyProgress[] = [];
		const drive = (async () => {
			for await (const progress of it) collected.push(progress);
		})();

		await Promise.resolve();
		await Promise.resolve();
		const emit = capturedCallback as unknown as (data: ProxyProgress) => void;
		emit({
			assetId: FIXTURE_HANDLE.id,
			stage: "error",
			fraction: 1,
			error: "hardware encoder unavailable",
		});

		await drive;

		// An "error" stage is a modeled VALUE in the progress stream (matching
		// ProxyProgress's own `error?: string` field), not a thrown JS
		// exception — the caller decides how to react, same as
		// web-fallback.ts's generateProxy never throwing mid-stream.
		expect(collected).toEqual([
			{
				assetId: FIXTURE_HANDLE.id,
				stage: "error",
				fraction: 1,
				error: "hardware encoder unavailable",
			},
		]);
	});

	test("generateProxy propagates a kickoff-call failure before any progress event", async () => {
		const plugin = fakePlugin({
			generateProxy: mock(async () => {
				throw { code: "UNSUPPORTED", message: "codec not hardware-accelerated" };
			}),
		});
		const bridge = createCapacitorBridge({ plugin: plugin as never });
		const it = bridge.generateProxy({
			handle: FIXTURE_HANDLE,
			spec: { targetHeight: 540, shortGop: true },
		});
		let caught: unknown;
		try {
			await it.next();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NativeBridgeError);
		expect((caught as NativeBridgeError).code).toBe("UNSUPPORTED");
	});

	test("generateThumbnails passes the result through and preserves native error codes on failure", async () => {
		const okPlugin = fakePlugin({
			generateThumbnails: mock(async () => ({
				assetId: FIXTURE_HANDLE.id,
				uris: ["file:///t0.jpg", "file:///t1.jpg"],
				timestampsMicros: [500_000, 1_500_000],
			})),
		});
		const bridge = createCapacitorBridge({ plugin: okPlugin as never });
		const strip = await bridge.generateThumbnails({
			handle: FIXTURE_HANDLE,
			spec: { count: 2, maxEdgePx: 200 },
		});
		expect(strip.uris).toHaveLength(2);
		expect(strip.timestampsMicros).toEqual([500_000, 1_500_000]);

		const failingPlugin = fakePlugin({
			generateThumbnails: mock(async () => {
				throw { code: "IO_ERROR", message: "source file missing" };
			}),
		});
		const failingBridge = createCapacitorBridge({ plugin: failingPlugin as never });
		let caught: unknown;
		try {
			await failingBridge.generateThumbnails({
				handle: FIXTURE_HANDLE,
				spec: { count: 2, maxEdgePx: 200 },
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NativeBridgeError);
		expect((caught as NativeBridgeError).code).toBe("IO_ERROR");
	});
});
