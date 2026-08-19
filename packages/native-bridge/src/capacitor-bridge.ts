/**
 * Capacitor implementation of NativeBridge — plan §2.4 / M3, extended by
 * M4 (media custody) and M9 (export) on BOTH platforms.
 *
 * This is the ONE file (with its sibling `web-fallback.ts` and this
 * package's `types.ts`/`event-generator.ts`) allowed to import
 * `@capacitor/core`. Nothing else in the tree may — see
 * `scripts/invariants.sh`'s bridge-import gate and the
 * `no-restricted-imports` ESLint rule that mirrors it.
 *
 * WHAT IS REAL: `capabilities()` (M3); `pickMedia()`, `generateProxy()`,
 * `generateThumbnails()` (M4); `exportProject()` (M9) — each calls a
 * genuinely registered native plugin method on BOTH
 * `apps/mobile/ios/App/App/NativeBridgePlugin{,+Media,+Export}.swift` and
 * `apps/mobile/android/app/src/main/java/dev/kneecap/app/NativeBridgePlugin.kt`.
 * "Real" here means "correctly wired, and unit-tested against an injected
 * fake plugin" (`__tests__/capacitor-bridge.test.ts`) plus, per platform,
 * whatever the M4/M9 handoffs record as device/simulator-verified. It does
 * NOT by itself mean "verified end-to-end on device".
 *
 * WHAT IS STUBBED: `transcribe` (M10).
 *
 * ---------------------------------------------------------------------
 * MERGE NOTE (track/ios + track/android unification, 2026-08-17)
 *
 * The two tracks independently grew this file and landed on two different
 * wire contracts for the same seam. This file is the unified one; the
 * native sides were brought to it, not the other way round:
 *
 *  1. EXPORT IDENTITY. iOS keyed `exportProject`/`exportCancel`/the
 *     `exportProgress` event stream by an `exportId`; Android had a single
 *     global export with a bare `cancelExport()`. Unified on the iOS shape
 *     (strictly more capable — it can route two concurrent exports, and a
 *     single-export native implementation can always just echo the id
 *     back). `NativeBridgePlugin.kt` was updated to accept `exportId`,
 *     stamp it onto every `exportProgress` payload, and expose
 *     `exportCancel({exportId})` in place of `cancelExport()`.
 *  2. THUMBNAILS. Android exposed a dedicated `generateThumbnails()`
 *     plugin method; iOS piggy-backed thumbnail paths onto
 *     `generateProxy`'s terminal `proxyProgress` event
 *     (`ProxyProgress.thumbnailUris`). BOTH survive, because they are
 *     genuinely different call shapes for different callers (M7's timeline
 *     asking for a filmstrip at a given density vs. import-time free
 *     output), and `generateThumbnails` was added to the iOS plugin so the
 *     method is real on both platforms rather than an Android-only trap.
 *  3. STRUCTURE. Android's plugin-injection parameter, typed error
 *     mapping (`toNativeBridgeError`) and defensive wire coercion
 *     (`fromWireMediaHandle`) are kept — they are strictly better than the
 *     iOS version's absence of them. iOS's shared, separately-unit-tested
 *     `subscribeToEvents` helper (`event-generator.ts`) is kept in place of
 *     Android's two hand-rolled, near-identical inline generators.
 *  4. URI CONVERSION. iOS's `toPlaybackUri` is kept and now applies to
 *     BOTH platforms' outputs (proxy, thumbnails, export) — Android's
 *     `Uri.fromFile(...)` `file://` paths are no more loadable by a
 *     WebView than iOS's raw sandbox paths are.
 * ---------------------------------------------------------------------
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

import {
	registerPlugin,
	Capacitor,
	type PluginListenerHandle,
} from "@capacitor/core";
import { detectGpuBackend } from "./gpu-detect";
import { probeCodecs } from "./codec-detect";
import { subscribeToEvents } from "./event-generator";
import { smoothWordTimings, type RawWordTiming } from "./caption-smoothing";
import type {
	DeviceCapabilities,
	ExportProgress,
	MediaHandle,
	MediaKind,
	NativeBridge,
	NativeBridgeErrorCode,
	PickMediaOptions,
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

/** The `proxyProgress` event payload as it comes off the wire — raw native
 * paths, before `toPlaybackUri`. `proxyWidth`/`proxyHeight`/`thumbnailUris`
 * are the iOS side's terminal-event extras (see this file's merge note item
 * 2); Android simply omits them, which is why they are optional here rather
 * than platform-branched. */
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
	pickMedia(opts: {
		kinds: MediaKind[];
		allowMultiple: boolean;
		source?: PickMediaOptions["source"];
	}): Promise<{ handles: WireMediaHandle[] }>;
	/** Resolves once the native transcode has STARTED, not once it is done —
	 * progress/completion arrive as `proxyProgress` events. The two
	 * platforms' acknowledgement payloads differ in shape (iOS
	 * `{accepted:true}`, Android `{assetId}`) and nothing on this side reads
	 * either, so the ack is deliberately typed `unknown` rather than
	 * over-specified into a lie. */
	generateProxy(params: {
		handle: WireMediaHandle;
		spec: ProxySpec;
	}): Promise<unknown>;
	generateThumbnails(params: {
		handle: WireMediaHandle;
		spec: ThumbnailStripSpec;
	}): Promise<ThumbnailStrip>;
	/** `edl` is passed through as plain JSON — no wire-format coercion the
	 * way `MediaHandle` needs (see this file's top doc comment). Same
	 * "resolve on kickoff, stream the rest as `exportProgress` events"
	 * shape as `generateProxy`; ack payload typed `unknown` for the same
	 * reason. */
	exportProject(params: { exportId: string; edl: Edl }): Promise<unknown>;
	/** Plugin-private — NOT part of the public `NativeBridge` TS interface,
	 * which expresses cancellation as the caller simply stopping iteration
	 * of the `AsyncGenerator<ExportProgress>` `exportProject` returns. This
	 * is what that generator's `finally` block calls so stopping iteration
	 * actually stops the native encoder, not just the JS-side listener. */
	exportCancel(params: { exportId: string }): Promise<unknown>;
	addListener(
		eventName: "proxyProgress",
		listenerFunc: (data: RawProxyProgress) => void,
	): Promise<PluginListenerHandle>;
	addListener(
		eventName: "exportProgress",
		listenerFunc: (data: RawExportProgress) => void,
	): Promise<PluginListenerHandle>;
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

/** Type-predicate form of the `NATIVE_BRIDGE_ERROR_CODES` membership check —
 * lets the call site below narrow `code: string` to `NativeBridgeErrorCode`
 * via ordinary control-flow narrowing, with no unsafe assertion needed at
 * the call site. */
function isNativeBridgeErrorCode(value: string): value is NativeBridgeErrorCode {
	// Widening cast (tuple-of-literals -> readonly string[]), not a narrowing
	// one — `Array<T>.includes` requires its argument assignable to `T`, and
	// `string` isn't assignable to the narrower literal tuple type without
	// this. Safe, and exactly the pattern `no-unsafe-type-assertion` exists to
	// distinguish from a genuine narrowing cast.
	return (NATIVE_BRIDGE_ERROR_CODES as readonly string[]).includes(value);
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
 *
 * The `file://` normalization is load-bearing, found on the founder's
 * iPhone (2026-08-19): `Capacitor.convertFileSrc` ONLY rewrites strings
 * that start with `file://` (or `content://` on Android) and passes raw
 * paths through UNCHANGED. iOS's Swift side returns raw `URL.path` values
 * (by design, see above), so without this prefix every playback/thumbnail
 * URL on iOS was a bare `/var/mobile/...` path — the WebView resolved it
 * against the app origin, the scheme handler failed it, and mediabunny's
 * UrlSource retried the dead fetch forever. Android already returns
 * `file:///...` (`Uri.fromFile(...).toString()`), so the prefix is a
 * no-op there.
 */
function toPlaybackUri(nativeUri: string): string {
	const normalized = nativeUri.startsWith("/")
		? `file://${nativeUri}`
		: nativeUri;
	return Capacitor.convertFileSrc(normalized);
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

/**
 * @param plugin Injected only by tests (`__tests__/capacitor-bridge.test.ts`)
 *   to exercise `pickMedia`/`generateProxy`/`generateThumbnails`/
 *   `exportProject`'s orchestration logic — error mapping, the
 *   event-to-generator adapter, wire-format coercion, cancel-on-abandon —
 *   without a real native runtime. Production callers never pass this; it
 *   defaults to the real `registerPlugin` proxy.
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
		toPlaybackUri,

		async pickMedia(opts: PickMediaOptions): Promise<MediaHandle[]> {
			try {
				const { handles } = await plugin.pickMedia({
					kinds: opts.kinds,
					allowMultiple: opts.allowMultiple,
					source: opts.source,
				});
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
			// Subscribe BEFORE triggering the native call (see
			// `subscribeToEvents`'s doc comment) — otherwise a proxy that
			// finishes very quickly could fire "done" before this file is
			// listening for it. Mapped through `toNativeBridgeError` like
			// every other native call: with no plugin registered (a plain
			// browser, or `bun test`), it is `addListener` — not the kickoff
			// below — that throws first, and a raw `CapacitorException`
			// escaping here would defeat the typed-error contract callers
			// rely on.
			let events: AsyncGenerator<RawProxyProgress>;
			try {
				events = await subscribeToEvents<RawProxyProgress>({
					source: plugin,
					eventName: "proxyProgress",
					filter: (e) => e.assetId === handle.id,
					isTerminal: (e) => e.stage === "done" || e.stage === "error",
				});
			} catch (err) {
				throw toNativeBridgeError({ err, method: "generateProxy" });
			}

			try {
				// Kicks off the native transcode; resolves once it has STARTED
				// (see NativeBridgePlugin.kt / +Media.swift doc comments), not
				// once it's done. `handle` (a `MediaHandle`) is structurally
				// assignable to `WireMediaHandle` — its `rotationDegrees`
				// literal union is a narrower `number`, the only field the two
				// types differ on.
				await plugin.generateProxy({ handle, spec });
			} catch (err) {
				// Tear the just-registered listener down rather than leaking it
				// for the lifetime of the app when the kickoff itself failed.
				await events.return(undefined);
				throw toNativeBridgeError({ err, method: "generateProxy" });
			}

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

		async generateThumbnails({
			handle,
			spec,
		}: {
			handle: MediaHandle;
			spec: ThumbnailStripSpec;
		}): Promise<ThumbnailStrip> {
			try {
				const strip = await plugin.generateThumbnails({ handle, spec });
				// Same conversion discipline as `generateProxy`'s `proxyUri`
				// above: native hands back raw sandbox paths / `file://` URLs,
				// and a filmstrip's only consumer is an `<img src>` in the
				// webview (M7's timeline), so convert at exactly this boundary.
				return { ...strip, uris: strip.uris.map(toPlaybackUri) };
			} catch (err) {
				throw toNativeBridgeError({ err, method: "generateThumbnails" });
			}
		},

		async *exportProject({ edl }: { edl: Edl }): AsyncGenerator<ExportProgress> {
			const exportId = generateExportId();
			// Subscribe BEFORE triggering the native call — same race
			// avoided, and same error mapping applied, as `generateProxy`
			// above.
			let events: AsyncGenerator<RawExportProgress>;
			try {
				events = await subscribeToEvents<RawExportProgress>({
					source: plugin,
					eventName: "exportProgress",
					filter: (e) => e.exportId === exportId,
					isTerminal: (e) => e.stage === "done" || e.stage === "error",
				});
			} catch (err) {
				throw toNativeBridgeError({ err, method: "exportProject" });
			}

			try {
				await plugin.exportProject({ exportId, edl });
			} catch (err) {
				await events.return(undefined);
				throw toNativeBridgeError({ err, method: "exportProject" });
			}

			// A `try/finally` here, not just in `events`'s own generator
			// (`subscribeToEvents`'s `drain()`, which only tears down the
			// event LISTENER): `AsyncGenerator.return()` propagates through
			// a `for await` exactly like a `break` would, running this
			// `finally` before the inner one — a caller that walks away
			// mid-export (e.g. the user backs out of the export sheet)
			// calls `.return()` on the generator THIS function returns,
			// which reaches here and tells native to actually stop
			// encoding (plan M9 exit criterion: "Cancel mid-export leaves
			// no partial file and no leaked encoder" — iOS's
			// `EdlExportHandle` and Android's `Media3Exporter.cancel()` are
			// what make that true natively; this is what wires a JS-level
			// cancel to them without adding a second public bridge method
			// beyond the one the `NativeBridge` interface already declares).
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
					// Best-effort — the export may already have finished between
					// the last event and this cleanup running, and both natives
					// document a post-terminal cancel as a no-op.
					await plugin.exportCancel({ exportId }).catch(() => {});
				}
			}
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
				// `plugin`, not the module-level `NativeBridgePlugin`: this
				// method has to honour the same injection seam every other
				// method here does, or a test that injects a fake plugin would
				// silently punch through to the real (absent) native runtime.
				raw = await plugin.transcribe({
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
				plugin.getDeviceInfo(),
			]);
			return {
				platform,
				osVersion: deviceInfo.osVersion,
				deviceModel: deviceInfo.deviceModel,
				gpuBackend,
				ramTierMb: deviceInfo.ramTierMb,
				codecs,
				// M9 landed a real native exporter on BOTH platforms —
				// `NativeBridgePlugin+Export.swift` (AVFoundation) and
				// `Media3Exporter.kt` (Media3 Transformer). Still expressed
				// per-platform rather than a blanket `true` because this same
				// factory is what a `Capacitor.getPlatform() === "web"` context
				// would get if one ever constructed it there (the web path
				// normally uses `createWebFallbackBridge()` instead, which
				// answers `false` for its own reasons).
				supportsNativeExport: platform === "ios" || platform === "android",
				supportsOnDeviceStt: false, // flips true when M10 lands.
			};
		},
	};
}
