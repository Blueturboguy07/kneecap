/**
 * Native preview-audio router registry (2026-08-20).
 *
 * The iOS device bisect proved this class of WKWebView renders WebAudio
 * SILENTLY while reporting a running context (web test tone inaudible,
 * native test tone audible) — so on platforms that provide it, preview
 * audio bypasses the webview entirely: `AudioManager` hands its
 * audible-clip schedule to the host-registered router and native code
 * mixes it (apps/mobile/ios NativeAudioPreview.swift).
 *
 * Same host-supplies-the-implementation pattern as
 * `registerNativeMediaPathResolver` — editor-core stays headless and never
 * imports the bridge. Unregistered (web) ⇒ AudioManager keeps its WebAudio
 * graph.
 */

export interface NativeAudioRouterClip {
	/** RAW native filesystem path (host converts back from playback URLs). */
	path: string;
	startSec: number;
	durationSec: number;
	sourceOffsetSec: number;
	volume: number;
	rate: number;
}

export interface NativeAudioRouter {
	/** Rebuilds and starts the whole schedule (also the seek primitive).
	 *  Resolves false when the platform declined — caller falls back to
	 *  WebAudio for the session. */
	start(params: {
		clips: NativeAudioRouterClip[];
		atSec: number;
	}): Promise<boolean>;
	stop(): Promise<void>;
	/** Measured RMS of the native mix output. */
	level(): Promise<number>;
	/** Converts a webview playback URL back to the raw native path, or null
	 *  when the URL is not native-backed (blob: etc.). */
	toNativePath(url: string): string | null;
}

let router: NativeAudioRouter | null = null;

export function registerNativeAudioRouter(instance: NativeAudioRouter): void {
	router = instance;
}

export function getNativeAudioRouter(): NativeAudioRouter | null {
	return router;
}

export function __resetNativeAudioRouterForTests(): void {
	router = null;
}
