/**
 * Capacitor implementation of NativeBridge — plan §2.4 / M3.
 *
 * This is the ONE file (with its sibling `web-fallback.ts` and this
 * package's `types.ts`) allowed to import `@capacitor/core`. Nothing else in
 * the tree may — see `scripts/invariants.sh`'s bridge-import gate and the
 * `no-restricted-imports` ESLint rule that mirrors it.
 *
 * WHAT IS REAL IN M3: `capabilities()`. It calls a genuinely-registered
 * native plugin (`ios/App/App/NativeBridgePlugin.swift`,
 * `android/.../NativeBridgePlugin.kt`) for platform/OS/device/RAM-tier data,
 * blended with the same in-WebView GPU/codec feature detection the web
 * fallback uses. This is the proof the JS<->native round trip actually
 * works — the whole point of M3's "NativeBridge seam."
 *
 * WHAT IS STUBBED: `pickMedia` (M4 — media custody + picker),
 * `generateProxy` (M4 — proxy transcode), `exportProject` (M9 — hardware
 * export), `transcribe` (M10 — on-device STT). Each throws a typed
 * `NativeBridgeError` naming the owning milestone rather than silently
 * no-op'ing or faking success — plan M3's task list scopes this package to
 * "define + STUB packages/native-bridge," not implement the other three.
 */

import { registerPlugin, Capacitor } from "@capacitor/core";
import { detectGpuBackend } from "./gpu-detect";
import { probeCodecs } from "./codec-detect";
import type {
	DeviceCapabilities,
	ExportProgress,
	MediaHandle,
	NativeBridge,
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

interface NativeBridgePluginSpec {
	getDeviceInfo(): Promise<NativeDeviceInfo>;
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

export function createCapacitorBridge(): NativeBridge {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Capacitor types this as bare `string`; the actual runtime contract (capacitor.js: androidBridge/webkit.messageHandlers detection) only ever returns "ios" | "android" | "web".
	const platform = Capacitor.getPlatform() as Platform;

	return {
		platform,

		async pickMedia(): Promise<MediaHandle[]> {
			return notImplemented({ method: "pickMedia", milestone: "M4" });
		},

		async *generateProxy(_params: {
			handle: MediaHandle;
			spec: ProxySpec;
		}): AsyncGenerator<ProxyProgress> {
			return notImplemented({ method: "generateProxy", milestone: "M4" });
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
