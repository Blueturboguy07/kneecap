/**
 * Capacitor implementation of NativeBridge — plan §2.4 / M3-M4.
 *
 * This is the ONE file (with its sibling `web-fallback.ts` and this
 * package's `types.ts`) allowed to import `@capacitor/core`. Nothing else in
 * the tree may — see `scripts/invariants.sh`'s bridge-import gate and the
 * `no-restricted-imports` ESLint rule that mirrors it.
 *
 * WHAT IS REAL: `capabilities()` (M3) and, as of M4, `pickMedia()`,
 * `generateProxy()`, and `generateThumbnails()` — each calls a genuinely
 * registered native plugin method
 * (`apps/mobile/android/.../NativeBridgePlugin.kt`,
 * `apps/mobile/ios/App/App/NativeBridgePlugin.swift`). "Real" here means
 * "correctly wired and unit-tested against an injected fake plugin" — see
 * `__tests__/capacitor-bridge.test.ts`. It does NOT mean "verified against a
 * running native app on device/emulator"; that verification is out of reach
 * of `bun test` and is called out as such in the M4 handoff.
 *
 * WHAT IS STILL STUBBED: `exportProject` (M9 — hardware export), `transcribe`
 * (M10 — on-device STT). Each throws a typed `NativeBridgeError` naming the
 * owning milestone.
 */

import { registerPlugin, Capacitor } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import { detectGpuBackend } from "./gpu-detect";
import { probeCodecs } from "./codec-detect";
import type {
	DeviceCapabilities,
	ExportProgress,
	MediaHandle,
	NativeBridge,
	NativeBridgeErrorCode,
	Platform,
	ProxyProgress,
	ProxySpec,
	ThumbnailStrip,
	ThumbnailStripSpec,
	TranscribeOptions,
	TranscriptSegment,
} from "./types";
import { NATIVE_BRIDGE_ERROR_CODES, NativeBridgeError } from "./types";
import type { Edl } from "@kneecap/editor-core/edl";

/** The native half of `capabilities()` (M3). Implemented on both platforms —
 * `apps/mobile/ios/App/App/NativeBridgePlugin.swift`,
 * `apps/mobile/android/app/src/main/java/.../NativeBridgePlugin.kt`. */
interface NativeDeviceInfo {
	osVersion: string;
	deviceModel: string;
	ramTierMb: number;
}

/**
 * The wire shape `pickMedia`/`generateProxy`/`generateThumbnails` actually
 * exchange with native code — plain JSON, matching `MediaHandle` field for
 * field (see `types.ts`'s doc comment on why native probes speak
 * `durationMicros`, never editor-core ticks). Kept as a distinct type from
 * `MediaHandle` rather than reused directly so `fromWireMediaHandle` below
 * has somewhere to defensively coerce an untrusted native payload — this
 * bridge crosses a language boundary (Kotlin/Swift JSON encoding into a JS
 * object), and "trust but verify" matches this codebase's existing style
 * (e.g. `services/storage/service.ts`'s `roundMediaTime` on every value that
 * survives a serialization round trip).
 */
type WireMediaHandle = Omit<MediaHandle, "rotationDegrees"> & {
	rotationDegrees: number;
};

interface NativeBridgePluginSpec {
	getDeviceInfo(): Promise<NativeDeviceInfo>;
	pickMedia(opts: {
		kinds: string[];
		allowMultiple: boolean;
		source?: string;
	}): Promise<{ handles: WireMediaHandle[] }>;
	generateProxy(params: {
		handle: WireMediaHandle;
		spec: ProxySpec;
	}): Promise<{ assetId: string }>;
	generateThumbnails(params: {
		handle: WireMediaHandle;
		spec: ThumbnailStripSpec;
	}): Promise<ThumbnailStrip>;
	addListener(
		eventName: "proxyProgress",
		listenerFunc: (data: ProxyProgress) => void,
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
 * Every error that can reach here already crossed the JS<->native boundary
 * once (or is a plain JS error from a bad call, e.g. no plugin registered
 * under bun test). Capacitor's Android/iOS bridges surface a native
 * `PluginCall.reject(message, code)` as a JS error object with a `.code`
 * string property — if that code is one of ours
 * (`NATIVE_BRIDGE_ERROR_CODES`), preserve it exactly; otherwise the failure
 * is something this bridge didn't anticipate (no native runtime present,
 * plugin not registered, a genuine native crash) and gets normalized to
 * `IO_ERROR` rather than silently losing the original message.
 */
/** Type-predicate form of the `NATIVE_BRIDGE_ERROR_CODES` membership check —
 * lets the call site below narrow `code: string` to `NativeBridgeErrorCode`
 * via ordinary control-flow narrowing, with no unsafe assertion needed at
 * the call site. */
function isNativeBridgeErrorCode(value: string): value is NativeBridgeErrorCode {
	// Widening cast (tuple-of-literals -> readonly string[]), not a narrowing
	// one — `Array<T>.includes` requires its argument assignable to `T`, and
	// `string` isn't assignable to the narrower literal tuple type without
	// this. Safe, and exactly the pattern `no-unsafe-type-assertion` exists to
	// distinguish from the two removed-below narrowing casts.
	return (NATIVE_BRIDGE_ERROR_CODES as readonly string[]).includes(value);
}

function toNativeBridgeError({
	err,
	method,
}: {
	err: unknown;
	method: string;
}): NativeBridgeError {
	if (err instanceof NativeBridgeError) return err;

	if (typeof err === "object" && err !== null) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing `unknown` (already confirmed non-null object) to probe for an optional `code`/`message` pair is exactly what Capacitor's `PluginCall.reject(message, code)` rejections look like on the JS side; there is no runtime-checkable type narrower than `object` to ask TS for here, so the two field reads immediately below re-verify both fields' types before using them.
		const record = err as Record<string, unknown>;
		const code = record.code;
		const message = record.message;
		if (typeof code === "string" && isNativeBridgeErrorCode(code)) {
			return new NativeBridgeError({
				code, // narrowed to NativeBridgeErrorCode by the guard above — no cast.
				message:
					typeof message === "string"
						? message
						: `NativeBridge.${method}() failed`,
			});
		}
	}

	const message =
		err instanceof Error
			? err.message
			: `NativeBridge.${method}() failed with a non-Error rejection`;
	return new NativeBridgeError({ code: "IO_ERROR", message });
}

/** Coerces a wire-format handle into the exact `MediaHandle` shape,
 * defensively re-clamping the one field with a narrower TS type than JSON
 * can express (`rotationDegrees`'s `0 | 90 | 180 | 270` literal union) and
 * rounding `durationMicros` in case a native side ever hands back a
 * non-integer (plan §2.2's "never float seconds" rule extends to "never a
 * non-integer micros count" by the same logic). */
function fromWireMediaHandle(wire: WireMediaHandle): MediaHandle {
	const rotation = ((Math.round(wire.rotationDegrees) % 360) + 360) % 360;
	const normalizedRotation: MediaHandle["rotationDegrees"] =
		rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0;
	return {
		...wire,
		durationMicros: Math.round(wire.durationMicros),
		rotationDegrees: normalizedRotation,
	};
}

/**
 * Bridges a Capacitor plugin's callback-style `addListener` into the pull
 * -based `AsyncGenerator<ProxyProgress>` shape `NativeBridge.generateProxy`
 * promises. Filters to the one `assetId` this generator was asked about
 * (`notifyListeners("proxyProgress", ...)` on the native side is a single
 * app-wide event stream, not scoped per-call), buffers events that arrive
 * before the consumer calls `.next()`, and terminates (removing the
 * listener) on the first `"done"`/`"error"` stage — matching `ProxyProgress`
 * .fraction's own documented invariant ("Always 1 when stage is done or
 * error").
 */
async function* proxyProgressGenerator({
	plugin,
	assetId,
}: {
	plugin: Pick<NativeBridgePluginSpec, "addListener">;
	assetId: string;
}): AsyncGenerator<ProxyProgress> {
	const queue: ProxyProgress[] = [];
	let wake: (() => void) | null = null;
	let terminal = false;

	const handle = await plugin.addListener("proxyProgress", (data) => {
		if (data.assetId !== assetId) return;
		queue.push(data);
		if (data.stage === "done" || data.stage === "error") terminal = true;
		wake?.();
		wake = null;
	});

	try {
		while (true) {
			if (queue.length === 0) {
				if (terminal) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				continue;
			}
			// biome-ignore lint: queue.length checked non-empty above.
			const next = queue.shift()!;
			yield next;
			if (next.stage === "done" || next.stage === "error") return;
		}
	} finally {
		await handle.remove();
	}
}

/**
 * @param plugin Injected only by tests (`__tests__/capacitor-bridge.test.ts`)
 *   to exercise `pickMedia`/`generateProxy`/`generateThumbnails`'s
 *   orchestration logic — error mapping, the event-to-generator adapter,
 *   wire-format coercion — without a real native runtime. Production callers
 *   never pass this; it defaults to the real `registerPlugin` proxy.
 */
export function createCapacitorBridge({
	plugin = NativeBridgePlugin,
}: {
	plugin?: NativeBridgePluginSpec;
} = {}): NativeBridge {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Capacitor types this as bare `string`; the actual runtime contract (capacitor.js: androidBridge/webkit.messageHandlers detection) only ever returns "ios" | "android" | "web".
	const platform = Capacitor.getPlatform() as Platform;

	return {
		platform,

		async pickMedia(opts): Promise<MediaHandle[]> {
			try {
				const { handles } = await plugin.pickMedia(opts);
				return handles.map(fromWireMediaHandle);
			} catch (err) {
				throw toNativeBridgeError({ err, method: "pickMedia" });
			}
		},

		async *generateProxy({
			handle,
			spec,
		}: {
			handle: MediaHandle;
			spec: ProxySpec;
		}): AsyncGenerator<ProxyProgress> {
			try {
				// Kicks off the native transcode; the call resolves once it has
				// STARTED (see NativeBridgePlugin.kt's doc comment), not once it's
				// done — progress/completion arrives as `proxyProgress` events,
				// consumed below via `proxyProgressGenerator`.
				// `handle` (a `MediaHandle`) is structurally assignable to
				// `WireMediaHandle` — its `rotationDegrees` literal union is a
				// narrower `number`, which is the only field the two types differ
				// on.
				await plugin.generateProxy({ handle, spec });
			} catch (err) {
				throw toNativeBridgeError({ err, method: "generateProxy" });
			}
			yield* proxyProgressGenerator({ plugin, assetId: handle.id });
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

		async generateThumbnails({
			handle,
			spec,
		}: {
			handle: MediaHandle;
			spec: ThumbnailStripSpec;
		}): Promise<ThumbnailStrip> {
			try {
				return await plugin.generateThumbnails({ handle, spec });
			} catch (err) {
				throw toNativeBridgeError({ err, method: "generateThumbnails" });
			}
		},

		async capabilities(): Promise<DeviceCapabilities> {
			const [gpuBackend, codecs, deviceInfo] = await Promise.all([
				detectGpuBackend(),
				probeCodecs(),
				plugin.getDeviceInfo(),
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
