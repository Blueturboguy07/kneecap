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
import {
	createCapacitorBridge,
	mapNativeTranscribeResult,
} from "../capacitor-bridge";
import { NativeBridgeError } from "../types";
import type {
	ExportProgress,
	MediaHandle,
	PickMediaOptions,
	ProxyProgress,
} from "../types";
import type { Edl } from "@kneecap/editor-core/edl";

/** Lets a pending kickoff promise + its listener registration settle before
 * a test emits native events into them. A macrotask, not a fixed number of
 * `await Promise.resolve()` microtask ticks: the unified `exportProject`
 * awaits `subscribeToEvents` AND the plugin kickoff (which is where the
 * generated `exportId` becomes observable to the fake plugin) before any
 * event can be routed, and counting microtasks across that chain is
 * brittle. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The `exportProgress` event as it comes off the native wire: `ExportProgress`
 * plus the `exportId` the stream is routed by (the bridge strips it before
 * yielding, which is why the public type has no such field). Mirrors
 * `RawExportProgress` in capacitor-bridge.ts, which is module-private. */
type RawExportEvent = ExportProgress & { exportId: string };

/** Opaque to every test below — `exportProject`'s JS-side orchestration
 * (kickoff, event-stream adapting, cancellation) never inspects `edl`'s
 * contents, only passes it through to the native plugin call. Real EDL shape
 * validation is `packages/editor-core/src/edl/__tests__/edl.test.ts`'s job
 * (producer side) and `EdlParserTest.kt`'s job (Android native consumer). */
const FIXTURE_EDL = {} as unknown as Edl;

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
		exportProject: mock(async () => ({ started: true })),
		exportCancel: mock(async () => ({ accepted: true })),
		addListener: mock(async () => ({ remove: mock(async () => undefined) })),
		...overrides,
	};
}

/** The unified export wire contract routes `exportProgress` events by an
 * `exportId` the BRIDGE mints (`crypto.randomUUID`) — so a test emitting
 * fake native events has to learn it exactly the way the native side does:
 * off the kickoff call. This is the `exportProject` override every export
 * test below installs, paired with `recorded.id` to read it back. */
function recordingExportProject() {
	const recorded: { id: string | null } = { id: null };
	const exportProject = mock(async ({ exportId }: { exportId: string }) => {
		recorded.id = exportId;
		return { started: true };
	});
	return { exportProject, recorded };
}

describe("createCapacitorBridge (production path, real @capacitor/core, no native runtime)", () => {
	const bridge = createCapacitorBridge();

	test("platform resolves via Capacitor.getPlatform() ('web' under bun test)", () => {
		expect(bridge.platform).toBe("web");
	});

	test("toPlaybackUri normalizes raw paths to file:// before convertFileSrc", () => {
		// Under `bun test`'s web platform, Capacitor.convertFileSrc is a
		// pass-through (the real `_capacitor_file_` rewrite only exists in
		// the native iOS/Android runtime) — so what this pins down is the
		// bridge's OWN normalization: a raw absolute path (what iOS's Swift
		// side returns) must be prefixed with file:// or convertFileSrc
		// passes it through untouched and the WebView gets an unloadable
		// bare path (found on device, 2026-08-19).
		expect(bridge.toPlaybackUri("/some/native/path.mp4")).toBe(
			"file:///some/native/path.mp4",
		);
		// Already-schemed URIs (Android's Uri.fromFile output) pass through.
		expect(bridge.toPlaybackUri("file:///data/user/0/x/proxy.mp4")).toBe(
			"file:///data/user/0/x/proxy.mp4",
		);
	});

	// kneecap M4/M9: pickMedia/generateProxy/generateThumbnails/exportProject
	// now all call through to the real native `NativeBridge` plugin (iOS:
	// NativeBridgePlugin+Media.swift / NativeBridgePlugin+Export.swift;
	// Android: NativeBridgePlugin.kt). Under `bun test` there's no native
	// runtime to answer them, so these exercise this module's mapping of
	// Capacitor's OWN "plugin not implemented on web" rejection into a typed
	// NativeBridgeError — not stub behavior (that is now `transcribe`-only,
	// still genuinely stubbed pending M10). A real round trip requires the
	// app running in a simulator/emulator or on device — see the M4/M9
	// handoffs for what WAS exercised that way
	// (`apps/mobile/ios/verify-media-pipeline` /
	// `apps/mobile/ios/verify-export-pipeline` against the native Swift
	// logic directly, plus a real Xcode build+launch; the Android
	// instrumented tests for the Kotlin half).
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

	test("exportProject's kickoff call surfaces the same mapped error before yielding anything (M9 — implemented, but no native runtime under bun test)", async () => {
		const it = bridge.exportProject({ edl: FIXTURE_EDL });
		let caught: unknown;
		try {
			await it.next();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NativeBridgeError);
		// Not NOT_IMPLEMENTED (that stub is gone as of M9) — same "no native
		// plugin registered under bun test" IO_ERROR as pickMedia/generateProxy
		// above.
		expect((caught as NativeBridgeError).code).toBe("IO_ERROR");
	});

	test("transcribe rejects under bun test — no native NativeBridge.transcribe() registered (M10's native half; see capacitor-bridge.ts header)", async () => {
		const handle = { id: "x", uri: "file:///tmp/clip.m4a" } as MediaHandle;
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

	test("exportProject streams exportProgress events in order, routed by exportId, and terminates on 'done'", async () => {
		let capturedCallback: ((data: RawExportEvent) => void) | null = null;
		const removeMock = mock(async () => undefined);
		const { exportProject, recorded } = recordingExportProject();
		const plugin = fakePlugin({
			exportProject,
			addListener: mock(
				async (_event: string, cb: (data: RawExportEvent) => void) => {
					capturedCallback = cb;
					return { remove: removeMock };
				},
			),
		});
		const bridge = createCapacitorBridge({ plugin: plugin as never });
		const it = bridge.exportProject({ edl: FIXTURE_EDL });

		const collected: ExportProgress[] = [];
		const drive = (async () => {
			for await (const progress of it) collected.push(progress);
		})();

		await flush();
		expect(capturedCallback).not.toBeNull();
		const exportId = recorded.id as string;
		expect(typeof exportId).toBe("string");

		const emit = capturedCallback as unknown as (data: RawExportEvent) => void;
		// An event belonging to a DIFFERENT export must be ignored — the
		// `exportProgress` stream is app-wide, not per-call (same discipline
		// as `proxyProgress`'s assetId filter above).
		emit({ exportId: "some-other-export", stage: "encoding", fraction: 0.5 });
		emit({ exportId, stage: "encoding", fraction: 0.3 });
		emit({ exportId, stage: "encoding", fraction: 0.9 });
		emit({
			exportId,
			stage: "done",
			fraction: 1,
			outputUri: "file:///export.mp4",
		});

		await drive;

		expect(collected).toEqual([
			{ stage: "encoding", fraction: 0.3 },
			{ stage: "encoding", fraction: 0.9 },
			{ stage: "done", fraction: 1, outputUri: "file:///export.mp4" },
		]);
		expect(removeMock).toHaveBeenCalledTimes(1);
		// Reached a terminal stage on its own — exportCancel is NOT called,
		// same "don't cancel what already finished" contract both
		// Media3Exporter.kt and EdlExportHandle document natively.
		expect(plugin.exportCancel).not.toHaveBeenCalled();
	});

	test("exportProject's stream terminates on 'error' the same way it terminates on 'done'", async () => {
		let capturedCallback: ((data: RawExportEvent) => void) | null = null;
		const { exportProject, recorded } = recordingExportProject();
		const plugin = fakePlugin({
			exportProject,
			addListener: mock(
				async (_event: string, cb: (data: RawExportEvent) => void) => {
					capturedCallback = cb;
					return { remove: mock(async () => undefined) };
				},
			),
		});
		const bridge = createCapacitorBridge({ plugin: plugin as never });
		const it = bridge.exportProject({ edl: FIXTURE_EDL });

		const collected: ExportProgress[] = [];
		const drive = (async () => {
			for await (const progress of it) collected.push(progress);
		})();

		await flush();
		const emit = capturedCallback as unknown as (data: RawExportEvent) => void;
		emit({
			exportId: recorded.id as string,
			stage: "error",
			fraction: 1,
			error: "hardware encoder unavailable",
		});

		await drive;

		expect(collected).toEqual([
			{ stage: "error", fraction: 1, error: "hardware encoder unavailable" },
		]);
		expect(plugin.exportCancel).not.toHaveBeenCalled();
	});

	test("exportProject calls the native exportCancel({exportId}) when the consumer stops iterating before a terminal stage", async () => {
		let capturedCallback: ((data: RawExportEvent) => void) | null = null;
		const removeMock = mock(async () => undefined);
		const { exportProject, recorded } = recordingExportProject();
		const plugin = fakePlugin({
			exportProject,
			addListener: mock(
				async (_event: string, cb: (data: RawExportEvent) => void) => {
					capturedCallback = cb;
					return { remove: removeMock };
				},
			),
		});
		const bridge = createCapacitorBridge({ plugin: plugin as never });
		const it = bridge.exportProject({ edl: FIXTURE_EDL });

		// Get the generator to a genuine `yield` suspension point (one
		// non-terminal progress event, received) before walking away — exactly
		// what a user backing out of the export sheet mid-encode does. `.return()`
		// while parked on the adapter's internal backpressure `await` (nothing
		// queued yet) is a separate, pre-existing limitation of
		// `subscribeToEvents` (see M9 handoff) and is not exercised here.
		const first = it.next();
		await flush();
		(capturedCallback as unknown as (data: RawExportEvent) => void)({
			exportId: recorded.id as string,
			stage: "encoding",
			fraction: 0.1,
		});
		await first;

		await it.return(undefined);

		expect(removeMock).toHaveBeenCalledTimes(1);
		expect(plugin.exportCancel).toHaveBeenCalledTimes(1);
		// Cancels THIS export by id, not "whatever is running" — the whole
		// point of unifying on the id-keyed wire contract.
		expect(plugin.exportCancel).toHaveBeenCalledWith({
			exportId: recorded.id as string,
		});
	});

	test("exportProject propagates a kickoff-call failure before any progress event, and does not call exportCancel for a run that never started", async () => {
		const plugin = fakePlugin({
			exportProject: mock(async () => {
				throw { code: "UNSUPPORTED", message: "EDL has an unsupported construct for native export" };
			}),
		});
		const bridge = createCapacitorBridge({ plugin: plugin as never });
		const it = bridge.exportProject({ edl: FIXTURE_EDL });
		let caught: unknown;
		try {
			await it.next();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NativeBridgeError);
		expect((caught as NativeBridgeError).code).toBe("UNSUPPORTED");
		expect(plugin.exportCancel).not.toHaveBeenCalled();
	});
});
