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
 * export). Each throws a typed `NativeBridgeError` naming the owning
 * milestone rather than silently no-op'ing or faking success — plan M3's
 * task list scopes this package to "define + STUB packages/native-bridge,"
 * not implement the other three.
 *
 * `transcribe` (M10) is a DIFFERENT kind of "not done" than the three above,
 * worth calling out explicitly rather than lumping it in: the JS<->native
 * call plumbing below, and the mandatory word-timestamp smoothing pass it
 * runs every result through (`./caption-smoothing.ts`), are REAL — verified
 * against a real whisper.cpp 1.9.2 DTW capture, see
 * `__tests__/caption-smoothing.test.ts` and `__tests__/fixtures/jfk-dtw-raw.ts`.
 * What is NOT yet real is the native half this calls INTO: iOS has no
 * `transcribe` method registered on `NativeBridgePlugin` (deliberately —
 * adding one that references whisper.cpp before `whisper.xcframework` is
 * actually embedded in the Xcode project would break the M3 CI build for
 * everyone); Android's `NativeBridgePlugin.transcribe()` exists and calls a
 * real JNI wrapper class shape (`WhisperJNI`, mirroring
 * `examples/whisper.android`), but has no bundled `.so` yet, so it throws
 * `UnsatisfiedLinkError` the moment it's actually invoked. Either way, a
 * call from here today still ends up in the same `NOT_IMPLEMENTED` catch
 * block below — but the moment either native half is wired for real, this
 * TS code starts working with NO further changes needed here.
 */

import { registerPlugin, Capacitor } from "@capacitor/core";
import { detectGpuBackend } from "./gpu-detect";
import { probeCodecs } from "./codec-detect";
import { smoothWordTimings, type RawWordTiming } from "./caption-smoothing";
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

/**
 * One decoded token as the native plugin reports it, straight off
 * `whisper_full_get_token_data()` (after filtering non-text tokens — see
 * `caption-smoothing.ts`'s module header for the exact whisper.cpp fields
 * this maps to: `t0`/`t1` -> `coarseStart/EndMicros`, `t_dtw` ->
 * `dtwStartMicros`, or `null` for whisper.cpp's `-1` "not computed"
 * sentinel). Deliberately the SAME shape as `RawWordTiming` from
 * `./caption-smoothing` — this file re-imports that type rather than
 * redeclaring it so the wire contract and the smoothing pass's input can
 * never silently drift apart.
 */
type NativeRawToken = RawWordTiming;

interface NativeRawSegment {
	startMicros: number;
	endMicros: number;
	/** Full segment text as whisper.cpp joined it, BEFORE this bridge's own
	 * punctuation-merge smoothing runs on `tokens` — kept only as a
	 * human-readable fallback/debug field, never used to derive timing. */
	text: string;
	confidence: number | null;
	tokens: NativeRawToken[];
}

interface NativeTranscribeResult {
	segments: NativeRawSegment[];
}

interface NativeBridgePluginSpec {
	getDeviceInfo(): Promise<NativeDeviceInfo>;
	/** `audioUri` is a native-custody handle (see `MediaHandle.uri`'s own
	 * doc comment) — never a `blob:` URL. Runs whisper.cpp fully
	 * synchronously on the native side and resolves once with everything;
	 * see this file's header comment for why per-segment native progress
	 * events are a deliberate follow-up, not part of this call. */
	transcribe(params: {
		audioUri: string;
		modelSize: "tiny" | "base";
		languageHint?: string;
	}): Promise<NativeTranscribeResult>;
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
 * The one genuinely new piece of logic M10 adds: run every native segment's
 * raw tokens through the mandatory smoothing pass and produce the public
 * `TranscriptSegment[]` shape. Exported (not just used inline in
 * `transcribe()` below) specifically so it can be unit-tested without a
 * native plugin call in the loop at all — see
 * `__tests__/capacitor-bridge.test.ts`.
 */
export function mapNativeTranscribeResult(
	raw: NativeTranscribeResult,
): TranscriptSegment[] {
	return raw.segments.map((segment) => {
		const { words } = smoothWordTimings({
			tokens: segment.tokens,
			segmentStartMicros: segment.startMicros,
			segmentEndMicros: segment.endMicros,
		});
		return {
			startMicros: segment.startMicros,
			endMicros: segment.endMicros,
			text: segment.text,
			confidence: segment.confidence,
			words,
		};
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

		async *transcribe({
			opts,
			handle,
		}: {
			handle: MediaHandle;
			opts: TranscribeOptions;
		}): AsyncGenerator<TranscriptSegment> {
			let raw: NativeTranscribeResult;
			try {
				raw = await NativeBridgePlugin.transcribe({
					audioUri: handle.uri,
					modelSize: opts.modelSize,
					languageHint: opts.languageHint,
				});
			} catch {
				// See this file's header comment: neither native half is wired
				// end-to-end yet. Falls through to the same NOT_IMPLEMENTED
				// contract every other stub in this file uses.
				return notImplemented({
					method: "transcribe",
					milestone:
						"M10 (native half — apps/mobile/{ios,android} whisper.cpp integration not yet wired into the build; see this file's header comment)",
				});
			}
			for (const segment of mapNativeTranscribeResult(raw)) {
				yield segment;
			}
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
				// Still false: the JS<->native smoothing/glue is real (see
				// `transcribe()` and this file's header comment) but the
				// on-device whisper.cpp call itself is not wired on either
				// platform yet. Flips true once that native half lands.
				supportsOnDeviceStt: false,
			};
		},
	};
}
