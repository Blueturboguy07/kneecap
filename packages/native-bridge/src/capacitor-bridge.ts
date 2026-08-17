/**
 * Capacitor implementation of NativeBridge — plan §2.4 / M3, extended M4.
 *
 * This is the ONE file (with its sibling `web-fallback.ts` and this
 * package's `types.ts`/`event-generator.ts`) allowed to import
 * `@capacitor/core`. Nothing else in the tree may — see
 * `scripts/invariants.sh`'s bridge-import gate and the `no-restricted-imports`
 * ESLint rule that mirrors it.
 *
 * WHAT IS REAL AS OF M9: `capabilities()` (M3), `pickMedia()` and
 * `generateProxy()` (M4), `exportProject()` (M9) — all four call the
 * genuinely-registered native `NativeBridge` plugin
 * (`ios/App/App/NativeBridgePlugin.swift` + `NativeBridgePlugin+Media.swift`
 * + `NativeBridgePlugin+Export.swift`; iOS only — Android's equivalent
 * `NativeBridgePlugin.kt` implementation is a separate milestone/track, see
 * the M4/M9 handoffs for exactly what that means for the Android path
 * through this SAME file today).
 *
 * WHAT IS STUBBED: `transcribe` (M10).
 */

import { registerPlugin, Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { detectGpuBackend } from "./gpu-detect";
import { probeCodecs } from "./codec-detect";
import { subscribeToEvents } from "./event-generator";
import type {
	DeviceCapabilities,
	ExportProgress,
	MediaHandle,
	MediaKind,
	NativeBridge,
	PickMediaOptions,
	Platform,
	ProxyProgress,
	ProxySpec,
	TranscribeOptions,
	TranscriptSegment,
} from "./types";
import { NativeBridgeError } from "./types";
import type { Edl } from "@kneecap/editor-core/edl";

/** The native half of `capabilities()`. Implemented on both platforms —
 * `apps/mobile/ios/App/App/NativeBridgePlugin.swift`,
 * `apps/mobile/android/app/src/main/java/.../NativeBridgePlugin.kt`. */
interface NativeDeviceInfo {
	osVersion: string;
	deviceModel: string;
	ramTierMb: number;
}

/** What `pickMedia`'s native side actually resolves with — the SAME shape
 * as `MediaHandle` except `uri` is a raw native path (an app-sandbox
 * filesystem path), not yet converted to something the webview can load.
 * `toPlaybackUri()` below is the one place that conversion happens — see
 * its doc comment for why it's kept separate from the handle itself. */
type RawMediaHandle = MediaHandle;

interface RawProxyProgress {
	assetId: string;
	stage: "queued" | "transcoding" | "done" | "error";
	fraction: number;
	proxyUri?: string;
	proxyWidth?: number;
	proxyHeight?: number;
	thumbnailUris?: string[];
	error?: string;
}

/** What `exportProject`'s native side actually emits — additionally keyed
 * by `exportId` (see `generateExportId`'s doc comment for why an export
 * needs one and a proxy doesn't) but otherwise the same shape as the
 * public `ExportProgress`. */
interface RawExportProgress {
	exportId: string;
	stage: "preparing" | "encoding" | "muxing" | "done" | "error";
	fraction: number;
	outputUri?: string;
	error?: string;
}

interface NativeBridgePluginSpec {
	getDeviceInfo(): Promise<NativeDeviceInfo>;
	pickMedia(opts: {
		kinds: MediaKind[];
		allowMultiple: boolean;
	}): Promise<{ handles: RawMediaHandle[] }>;
	generateProxy(params: {
		handle: { id: string; uri: string };
		spec: { targetHeight: number; shortGop: boolean };
	}): Promise<{ accepted: boolean }>;
	exportProject(params: { exportId: string; edl: Edl }): Promise<{ accepted: boolean }>;
	exportCancel(params: { exportId: string }): Promise<{ accepted: boolean }>;
	addListener(
		eventName: "proxyProgress",
		listenerFunc: (data: RawProxyProgress) => void,
	): Promise<PluginListenerHandle>;
	addListener(
		eventName: "exportProgress",
		listenerFunc: (data: RawExportProgress) => void,
	): Promise<PluginListenerHandle>;
}

/** `generateProxy` filters its event stream on `handle.id` — a domain
 * identifier the caller already has. `exportProject` has no equivalent
 * (an `Edl` carries a project/scene id, but nothing that uniquely
 * identifies THIS export call — a user could plausibly kick off two
 * concurrent exports of the same scene at different quality settings), so
 * this generates one purely for event-routing, exactly the way M4's
 * `pickMedia` mints a fresh `assetId` per imported item. `crypto.randomUUID`
 * is available unconditionally at this project's iOS 17 / modern-WebView
 * floor (plan §2.5) — no fallback needed. */
function generateExportId(): string {
	return crypto.randomUUID();
}

const NativeBridgePlugin = registerPlugin<NativeBridgePluginSpec>(
	"NativeBridge",
);

function notImplemented({
	method,
	milestone,
}: {
	method: string;
	milestone: string;
}): never {
	throw new NativeBridgeError({
		code: "NOT_IMPLEMENTED",
		message: `NativeBridge.${method}() is stubbed on the Capacitor shell pending plan ${milestone}. See packages/native-bridge/src/capacitor-bridge.ts.`,
	});
}

/**
 * Converts a raw native filesystem path (what `pickMedia`/`generateProxy`'s
 * Swift/Kotlin side actually returns, and what those SAME native methods
 * expect back as *input* — `generateProxy` is called with the handle
 * `pickMedia` just produced) into a URL the WKWebView/Android WebView can
 * actually load as `<video src>`/`fetch()`.
 *
 * Deliberately NOT baked into `MediaHandle.uri` itself: `EdlAssetResolution
 * .sourceUri` (packages/editor-core/src/edl/build.ts) wants the same kind
 * of native handle a native exporter can open directly, and
 * `validateEdl({strict:true})` explicitly rejects `blob:`-style webview-only
 * URLs there (packages/editor-core/src/edl/validate.ts) — keeping the raw
 * path as the canonical `uri` and converting only at the point a `<video
 * src>`/`MediaAsset.url` is actually needed avoids two incompatible
 * "the uri" values floating around for the same asset.
 */
function toPlaybackUri(nativeUri: string): string {
	return Capacitor.convertFileSrc(nativeUri);
}

export function createCapacitorBridge(): NativeBridge {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Capacitor types this as bare `string`; the actual runtime contract (capacitor.js: androidBridge/webkit.messageHandlers detection) only ever returns "ios" | "android" | "web".
	const platform = Capacitor.getPlatform() as Platform;

	return {
		platform,
		toPlaybackUri,

		async pickMedia(opts: PickMediaOptions): Promise<MediaHandle[]> {
			const { handles } = await NativeBridgePlugin.pickMedia({
				kinds: opts.kinds,
				allowMultiple: opts.allowMultiple,
			});
			return handles;
		},

		async *generateProxy({
			handle,
			spec,
		}: {
			handle: MediaHandle;
			spec: ProxySpec;
		}): AsyncGenerator<ProxyProgress> {
			// Subscribe BEFORE triggering the native call (see
			// `subscribeToEvents`'s doc comment) — otherwise a proxy that
			// finishes very quickly could fire "done" before this file is
			// listening for it.
			const events = await subscribeToEvents<RawProxyProgress>({
				source: NativeBridgePlugin,
				eventName: "proxyProgress",
				filter: (e) => e.assetId === handle.id,
				isTerminal: (e) => e.stage === "done" || e.stage === "error",
			});

			await NativeBridgePlugin.generateProxy({
				handle: { id: handle.id, uri: handle.uri },
				spec: { targetHeight: spec.targetHeight, shortGop: spec.shortGop },
			});

			for await (const event of events) {
				yield {
					assetId: event.assetId,
					stage: event.stage,
					fraction: event.fraction,
					proxyUri:
						event.proxyUri !== undefined
							? toPlaybackUri(event.proxyUri)
							: undefined,
					proxyWidth: event.proxyWidth,
					proxyHeight: event.proxyHeight,
					thumbnailUris: event.thumbnailUris?.map(toPlaybackUri),
					error: event.error,
				};
			}
		},

		async *exportProject({ edl }: { edl: Edl }): AsyncGenerator<ExportProgress> {
			const exportId = generateExportId();
			// Subscribe BEFORE triggering the native call — same race
			// avoided as `generateProxy` above (see `subscribeToEvents`'s
			// doc comment): a very short/trivial export could otherwise
			// emit "done" before this file started listening for it.
			const events = await subscribeToEvents<RawExportProgress>({
				source: NativeBridgePlugin,
				eventName: "exportProgress",
				filter: (e) => e.exportId === exportId,
				isTerminal: (e) => e.stage === "done" || e.stage === "error",
			});

			await NativeBridgePlugin.exportProject({ exportId, edl });

			// A `try/finally` here, not just in `events`'s own generator
			// (`subscribeToEvents`'s `drain()`, which only tears down the
			// event LISTENER): `AsyncGenerator.return()` propagates through
			// a `for await` exactly like a `break` would, running this
			// `finally` before the inner one — a caller that walks away
			// mid-export (e.g. the user backs out of the export sheet)
			// calls `.return()` on the generator THIS function returns,
			// which reaches here and tells native to actually stop
			// encoding (plan M9 exit criterion: "Cancel mid-export leaves
			// no partial file and no leaked encoder" —
			// `EdlExporter.export`'s `EdlExportHandle` is what makes that
			// true on the native side; this is what wires a JS-level
			// cancel to it without adding a second public bridge method
			// beyond the one the `NativeBridge` interface already
			// declares).
			let reachedTerminalStage = false;
			try {
				for await (const event of events) {
					reachedTerminalStage =
						event.stage === "done" || event.stage === "error";
					yield {
						stage: event.stage,
						fraction: event.fraction,
						outputUri:
							event.outputUri !== undefined
								? toPlaybackUri(event.outputUri)
								: undefined,
						error: event.error,
					};
				}
			} finally {
				if (!reachedTerminalStage) {
					await NativeBridgePlugin.exportCancel({ exportId });
				}
			}
		},

		async *transcribe(_params: {
			handle: MediaHandle;
			opts: TranscribeOptions;
		}): AsyncGenerator<TranscriptSegment> {
			return notImplemented({ method: "transcribe", milestone: "M10" });
		},

		async capabilities(): Promise<DeviceCapabilities> {
			const [gpuBackend, codecs, deviceInfo] = await Promise.all([
				detectGpuBackend(),
				probeCodecs(),
				NativeBridgePlugin.getDeviceInfo(),
			]);
			return {
				platform,
				osVersion: deviceInfo.osVersion,
				deviceModel: deviceInfo.deviceModel,
				gpuBackend,
				ramTierMb: deviceInfo.ramTierMb,
				codecs,
				// M9 landed the real `exportProject()` implementation
				// (`NativeBridgePlugin+Export.swift`) — but iOS only,
				// exactly like `pickMedia`/`generateProxy` before it
				// (Android's `NativeBridgePlugin.kt` equivalent is a
				// separate, not-yet-landed track through this same file —
				// see the file header). A per-platform value here, not a
				// blanket `true`, so a caller on Android gets an honest
				// answer instead of discovering the gap only when
				// `exportProject()` itself throws.
				supportsNativeExport: platform === "ios",
				supportsOnDeviceStt: false, // flips true when M10 lands.
			};
		},
	};
}
