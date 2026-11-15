/**
 * PublikHost: what the publik module (apps/mobile/src/publik/publik.ts)
 * needs from the phone. The module holds the sign-in gate and usage
 * counting; this file is only the platform seam, so it lives in the one
 * package that may import `@capacitor/*` (plan §2.4, the bridge-import
 * gate in scripts/invariants.sh).
 *
 * - request(): CapacitorHttp on a phone. The request goes out from native
 *   code (URLSession / HttpURLConnection), so the webview's CORS and its
 *   Origin header do not apply. publik answers /installs and /wallet with no
 *   CORS headers, and drops a telemetry event that a web page sends.
 * - readFile()/writeFile()/removeFile(): the publik folder of this app
 *   (iOS: Application Support/publik, not backed up; Android:
 *   noBackupFilesDir/publik). Only the three names below. Mode 0600.
 * - openUrl(): SFSafariViewController on iOS, a Custom Tab on Android.
 * - launch(): the app version, the device, and the launch settings
 *   (iOS: environment or `-NAME value` launch arguments; Android: intent
 *   extras). Only the names in PUBLIK_LAUNCH_SETTINGS are read.
 * - finishSelfTest(): prints the self-test line to stdout (iOS) or logcat
 *   (Android, tag "publik"), then ends the app.
 * - onForeground(): the app came back to the front, or the in-app browser
 *   closed. onBackground(): the app went to the background (Capacitor's
 *   document `pause` event, or the page became hidden). Usage counting stops
 *   its 30-minute timer there. onBrowserTick(): every 3 s while the in-app
 *   browser is open (a native timer), so the wallet poll does not stall when
 *   the browser covers the web view.
 * - showFirstRun(): kneecap's native first-run screen, once per install.
 *   It is here, not in NativeBridge, because the gate decides when it shows:
 *   after "Sign in with publik" (with PUBLIK_GATE_MODE=required the gate is
 *   the first screen of a new install).
 *
 * Native halves: apps/mobile/ios/App/App/PublikGatePlugin.swift and
 * apps/mobile/android/app/src/main/java/dev/kneecap/app/PublikGatePlugin.kt.
 * In a plain browser (the Vite preview) a web fallback stands in.
 */
import {
	Capacitor,
	CapacitorHttp,
	registerPlugin,
	type PluginListenerHandle,
} from "@capacitor/core";

export type PublikPlatform = "ios" | "android" | "web";

/** The files the module keeps: its credential, the shared install ID, and the usage opt-out. */
export type PublikFileName = `apps/${string}.json` | "telemetry.json" | "consent.json";

/** The launch settings a phone build reads. Nothing else is read. */
export const PUBLIK_LAUNCH_SETTINGS = [
	"PUBLIK_SELF_TEST",
	"PUBLIK_API_BASE_URL",
	"DO_NOT_TRACK",
	"PUBLIK_TELEMETRY",
	"PUBLIK_TELEMETRY_DEBUG",
] as const;
export type PublikLaunchSetting = (typeof PUBLIK_LAUNCH_SETTINGS)[number];

export interface PublikLaunch {
	platform: PublikPlatform;
	/** CFBundleShortVersionString / versionName; null in a browser. */
	appVersion: string | null;
	deviceName: string;
	arch: "arm64" | "x64" | null;
	settings: Partial<Record<PublikLaunchSetting, string>>;
}

export interface PublikRequest {
	method: "GET" | "POST";
	url: string;
	headers: Record<string, string>;
	/** A JSON string. */
	body?: string;
	timeoutMs: number;
}

export interface PublikHost {
	launch(): Promise<PublikLaunch>;
	/** Resolves with any HTTP status. Rejects only when the request did not complete (no network, timeout). */
	request(req: PublikRequest): Promise<{ status: number; data: unknown }>;
	readFile(args: { name: PublikFileName }): Promise<string | null>;
	/** `exclusive`: create the file only when it does not exist. Resolves false when nothing was written. */
	writeFile(args: { name: PublikFileName; text: string; exclusive?: boolean }): Promise<boolean>;
	/** Deletes the file. Resolves true when it is gone (also when it was never there). */
	removeFile(args: { name: PublikFileName }): Promise<boolean>;
	openUrl(args: { url: string }): Promise<void>;
	closeBrowser(): Promise<void>;
	finishSelfTest(args: { line: string }): Promise<void>;
	/** Returns the function that stops the listener. */
	onForeground(listener: () => void): () => void;
	/** The app went to the background. Returns the function that stops the listener. */
	onBackground(listener: () => void): () => void;
	/**
	 * Every 3 s while the in-app browser (openUrl) is open, from the native side: the web view's own timers
	 * can stall while the browser covers the app. Returns the function that stops the listener.
	 */
	onBrowserTick(listener: () => void): () => void;
	/** Shows the native first-run screen if this install has not seen it; resolves when it closes. */
	showFirstRun(): Promise<void>;
}

interface PublikGatePluginSpec {
	launchInfo(): Promise<{
		appVersion?: string;
		deviceName?: string;
		arch?: string;
		settings?: Record<string, string>;
	}>;
	readFile(args: { name: string }): Promise<{ text?: string }>;
	writeFile(args: { name: string; text: string; exclusive: boolean }): Promise<{ written: boolean }>;
	removeFile(args: { name: string }): Promise<{ removed: boolean }>;
	openBrowser(args: { url: string }): Promise<void>;
	closeBrowser(): Promise<void>;
	finishSelfTest(args: { line: string }): Promise<void>;
	showFirstRun(): Promise<void>;
	addListener(eventName: "foreground" | "browserTick", listenerFunc: () => void): Promise<PluginListenerHandle>;
}

const PublikGatePlugin = registerPlugin<PublikGatePluginSpec>("PublikGate");

function pickSettings(raw: Record<string, string> | undefined): PublikLaunch["settings"] {
	const out: PublikLaunch["settings"] = {};
	for (const name of PUBLIK_LAUNCH_SETTINGS) {
		const value = raw?.[name];
		if (typeof value === "string" && value !== "") out[name] = value;
	}
	return out;
}

function pickArch(raw: string | undefined): PublikLaunch["arch"] {
	return raw === "arm64" || raw === "x64" ? raw : null;
}

/** A JSON body parsed when it is a string; CapacitorHttp parses it already when the answer says application/json. */
function parsed(data: unknown): unknown {
	if (typeof data !== "string") return data;
	try {
		const value: unknown = JSON.parse(data);
		return value;
	} catch {
		return data;
	}
}

/** `visibilitychange` to visible, plus Capacitor's own document `resume` event. */
function onDocumentForeground(listener: () => void): () => void {
	const onVisible = () => {
		if (document.visibilityState === "visible") listener();
	};
	document.addEventListener("visibilitychange", onVisible);
	document.addEventListener("resume", listener);
	return () => {
		document.removeEventListener("visibilitychange", onVisible);
		document.removeEventListener("resume", listener);
	};
}

/** `visibilitychange` to hidden, plus Capacitor's own document `pause` event (the app went to the background). */
function onDocumentBackground(listener: () => void): () => void {
	const onHidden = () => {
		if (document.visibilityState === "hidden") listener();
	};
	document.addEventListener("visibilitychange", onHidden);
	document.addEventListener("pause", listener);
	return () => {
		document.removeEventListener("visibilitychange", onHidden);
		document.removeEventListener("pause", listener);
	};
}

function createNativeHost(platform: "ios" | "android"): PublikHost {
	return {
		async launch() {
			const info = await PublikGatePlugin.launchInfo();
			return {
				platform,
				appVersion: info.appVersion ?? null,
				deviceName: info.deviceName ?? (platform === "ios" ? "iPhone" : "Android"),
				arch: pickArch(info.arch),
				settings: pickSettings(info.settings),
			};
		},
		async request({ method, url, headers, body, timeoutMs }) {
			const res = await CapacitorHttp.request({
				method,
				url,
				headers,
				data: body,
				connectTimeout: timeoutMs,
				readTimeout: timeoutMs,
				responseType: "text",
			});
			return { status: res.status, data: parsed(res.data) };
		},
		async readFile({ name }) {
			const { text } = await PublikGatePlugin.readFile({ name });
			return typeof text === "string" ? text : null;
		},
		async writeFile({ name, text, exclusive }) {
			const { written } = await PublikGatePlugin.writeFile({ name, text, exclusive: exclusive === true });
			return written;
		},
		async removeFile({ name }) {
			const { removed } = await PublikGatePlugin.removeFile({ name });
			return removed;
		},
		async openUrl({ url }) {
			await PublikGatePlugin.openBrowser({ url });
		},
		async closeBrowser() {
			await PublikGatePlugin.closeBrowser();
		},
		async finishSelfTest({ line }) {
			await PublikGatePlugin.finishSelfTest({ line });
		},
		onForeground(listener) {
			let handle: PluginListenerHandle | null = null;
			let stopped = false;
			void PublikGatePlugin.addListener("foreground", listener).then((h) => {
				if (stopped) void h.remove();
				else handle = h;
			});
			const offDocument = onDocumentForeground(listener);
			return () => {
				stopped = true;
				offDocument();
				if (handle) void handle.remove();
			};
		},
		onBackground(listener) {
			return onDocumentBackground(listener);
		},
		onBrowserTick(listener) {
			let handle: PluginListenerHandle | null = null;
			let stopped = false;
			void PublikGatePlugin.addListener("browserTick", listener).then((h) => {
				if (stopped) void h.remove();
				else handle = h;
			});
			return () => {
				stopped = true;
				if (handle) void handle.remove();
			};
		},
		async showFirstRun() {
			await PublikGatePlugin.showFirstRun();
		},
	};
}

/** The Vite preview in a plain browser: fetch, localStorage, a new tab. Not a shipped surface. */
function createWebHost(): PublikHost {
	const storageKey = (name: string) => `publik:${name}`;
	return {
		async launch() {
			return { platform: "web", appVersion: null, deviceName: "Browser", arch: null, settings: {} };
		},
		async request({ method, url, headers, body, timeoutMs }) {
			const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
			return { status: res.status, data: parsed(await res.text()) };
		},
		async readFile({ name }) {
			try {
				return localStorage.getItem(storageKey(name));
			} catch {
				return null;
			}
		},
		async writeFile({ name, text, exclusive }) {
			try {
				if (exclusive && localStorage.getItem(storageKey(name)) !== null) return false;
				localStorage.setItem(storageKey(name), text);
				return true;
			} catch {
				return false;
			}
		},
		async removeFile({ name }) {
			try {
				localStorage.removeItem(storageKey(name));
				return true;
			} catch {
				return false;
			}
		},
		async openUrl({ url }) {
			window.open(url, "_blank", "noopener");
		},
		async closeBrowser() {},
		async finishSelfTest({ line }) {
			console.log(line);
		},
		onForeground(listener) {
			return onDocumentForeground(listener);
		},
		onBackground(listener) {
			return onDocumentBackground(listener);
		},
		onBrowserTick() {
			return () => {}; // the browser preview opens a new tab: its own timers keep running
		},
		async showFirstRun() {}, // the browser preview has no native first-run screen
	};
}

let cached: PublikHost | null = null;

export function getPublikHost(): PublikHost {
	if (cached) return cached;
	const platform = Capacitor.getPlatform();
	cached =
		Capacitor.isNativePlatform() && (platform === "ios" || platform === "android")
			? createNativeHost(platform)
			: createWebHost();
	return cached;
}
