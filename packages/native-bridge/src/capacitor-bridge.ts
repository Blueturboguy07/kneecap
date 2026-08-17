/**
 * Capacitor implementation of NativeBridge — plan §2.4 / M3, extended M4.
 *
 * This is the ONE file (with its sibling `web-fallback.ts` and this
 * package's `types.ts`/`event-generator.ts`) allowed to import
 * `@capacitor/core`. Nothing else in the tree may — see
 * `scripts/invariants.sh`'s bridge-import gate and the `no-restricted-imports`
 * ESLint rule that mirrors it.
 *
 * WHAT IS REAL AS OF M4: `capabilities()` (M3), `pickMedia()` and
 * `generateProxy()` (M4) — all three call the genuinely-registered native
 * `NativeBridge` plugin (`ios/App/App/NativeBridgePlugin.swift` +
 * `NativeBridgePlugin+Media.swift`; iOS only as of M4 — Android's
 * equivalent `NativeBridgePlugin.kt` implementation is a separate
 * milestone/track, see the M4 handoff for exactly what that means for the
 * Android path through this SAME file today).
 *
 * WHAT IS STUBBED: `exportProject` (M9), `transcribe` (M10).
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
	addListener(
		eventName: "proxyProgress",
		listenerFunc: (data: RawProxyProgress) => void,
	): Promise<PluginListenerHandle>;
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

		async *exportProject(_params: { edl: Edl }): AsyncGenerator<ExportProgress> {
			return notImplemented({ method: "exportProject", milestone: "M9" });
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
				supportsNativeExport: false, // flips true when M9 lands.
				supportsOnDeviceStt: false, // flips true when M10 lands.
			};
		},
	};
}
