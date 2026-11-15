/**
 * Blind test round 4 (1.0.7, iOS App Store simulator build): the app fixes in
 * 1.0.8 (items 5, 6, 8 and 10a). Static checks read the shipped files with the
 * comments taken out. Logic checks run the real modules: the publik gate
 * (src/publik/publik.ts and gate-ui.ts) with a fake phone, a fake publik and a
 * small fake DOM; the captions action (packages/mobile-ui) with a fake editor
 * and the web-fallback bridge; the license filter with the shipped list.
 * Each check fails on the 1.0.7 source.
 *
 * Run: bun test apps/mobile/test
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PublikHost, PublikRequest } from "@kneecap/native-bridge/publik-host";

const REPO = join(import.meta.dir, "../../..");

/** The code of a file without its comments (block comments, JSX comments and line comments). */
function codeOf(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}
function raw(path: string): string {
	return readFileSync(join(REPO, path), "utf8");
}
function code(path: string): string {
	return codeOf(raw(path));
}
/** The text from `start` up to (not including) the next `end` after it. */
function between(text: string, start: string, end: string): string {
	const from = text.indexOf(start);
	expect(from).toBeGreaterThanOrEqual(0);
	const to = text.indexOf(end, from + start.length);
	expect(to).toBeGreaterThan(from);
	return text.slice(from, to);
}
/** Every file under `dir` (repo-relative) whose name matches `pattern`, without tests and node_modules. */
function files(dir: string, pattern: RegExp): string[] {
	const out: string[] = [];
	const walk = (rel: string) => {
		for (const name of readdirSync(join(REPO, rel))) {
			if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
			const child = `${rel}/${name}`;
			if (statSync(join(REPO, child)).isDirectory()) walk(child);
			else if (pattern.test(name)) out.push(child);
		}
	};
	walk(dir);
	return out;
}
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

type Gate = typeof import("../src/publik/publik");
type GateUiModule = typeof import("../src/publik/gate-ui");
let gate: Gate;

beforeAll(async () => {
	// The same build token as publik-gate.test.ts (the module reads it once, when it loads).
	(globalThis as Record<string, unknown>).__PUBLIK_APP_TOKEN__ ??= "pat_gatetest";
	gate = await import("../src/publik/publik");
});
afterEach(() => gate._resetForTests());

// ---------- a fake phone and a fake publik (the shape of publik-gate.test.ts) ----------

const ORIGIN = "https://publikhq.com";
type WalletBody = { claim_state: "anonymous" | "claimed"; account: { handle: string } | null; plan: { kind: string; label: string | null }; balance_micros: number };
const anonymous: WalletBody = { claim_state: "anonymous", account: null, plan: { kind: "none", label: null }, balance_micros: 0 };
const claimed: WalletBody = { claim_state: "claimed", account: { handle: "mann" }, plan: { kind: "none", label: null }, balance_micros: 0 };

function phone() {
	const files = new Map<string, string>();
	const requests: Array<{ method: string; path: string }> = [];
	const opened: string[] = [];
	const front = new Set<() => void>();
	let browserTick: (() => void) | null = null;
	const server = {
		offline: false,
		wallet: anonymous as WalletBody,
		walletStatus: 200,
		/** POST /installs and GET /wallet wait for this promise before they answer (a slow network). */
		hold: null as Promise<void> | null,
	};
	const host: PublikHost = {
		async launch() {
			return { platform: "ios", appVersion: "1.0.8", deviceName: "iPhone", arch: "arm64", settings: {} };
		},
		async request(req: PublikRequest) {
			await tick(0);
			const path = new URL(req.url).pathname;
			requests.push({ method: req.method, path });
			if (server.offline) throw new Error("The Internet connection appears to be offline.");
			if (path.endsWith("/installs/revoke")) return { status: 204, data: "" };
			if (path.endsWith("/telemetry")) return { status: 204, data: "" };
			if (server.hold) await server.hold;
			if (path.endsWith("/installs")) {
				const sent = JSON.parse(req.body ?? "{}") as { install_id: string };
				return { status: 201, data: { key: "pk_live_round4", install_id: sent.install_id, claim_url: `${ORIGIN}/claim/abc`, claim_state: "anonymous" } };
			}
			if (path.endsWith("/wallet")) {
				if (server.walletStatus !== 200) return { status: server.walletStatus, data: { error: { type: "invalid_key", message: "This key is not valid." } } };
				return { status: 200, data: { ...server.wallet, claim_url: `${ORIGIN}/claim/abc`, top_up_url: `${ORIGIN}/wallet`, linked_at: null } };
			}
			return { status: 404, data: {} };
		},
		async readFile({ name }) {
			return files.get(name) ?? null;
		},
		async writeFile({ name, text, exclusive }) {
			if (exclusive && files.has(name)) return false;
			files.set(name, text);
			return true;
		},
		async removeFile({ name }) {
			files.delete(name);
			return true;
		},
		async openUrl({ url }) {
			opened.push(url);
		},
		async closeBrowser() {},
		async finishSelfTest() {},
		onForeground(listener) {
			front.add(listener);
			return () => {
				front.delete(listener);
			};
		},
		onBackground() {
			return () => {};
		},
		onBrowserTick(listener) {
			browserTick = listener;
			return () => {
				browserTick = null;
			};
		},
		async showFirstRun() {},
	};
	const wallets = () => requests.filter((r) => r.path.endsWith("/wallet")).length;
	return { host, files, requests, opened, server, wallets, comeToFront: () => [...front].forEach((l) => l()), browserTick: () => browserTick?.() };
}

/** A gate UI that never answers (the gate must not show a screen in these cases). */
const noScreen = { show: () => new Promise<never>(() => {}), openUrl: () => undefined };

/** A phone that signed in on an earlier run (its key file has claimed_at). */
async function signedInBefore() {
	const p = phone();
	p.server.wallet = claimed;
	await gate.ensureSignedIn(noScreen, p.host);
	await tick();
	gate._resetForTests();
	p.requests.length = 0;
	return p;
}

/** A phone that started without publik (the offline pass): Settings says "publik is not reachable now". */
async function offlinePass() {
	const p = await signedInBefore();
	p.server.offline = true;
	expect(await gate.ensureSignedIn(noScreen, p.host)).toMatchObject({ offline: true });
	expect(gate.getStatus()).toMatchObject({ signedIn: true, offline: true });
	p.requests.length = 0;
	return p;
}

// ---------- a small fake DOM for gate-ui.ts ----------

class FakeElement {
	children: FakeElement[] = [];
	dataset: Record<string, string> = {};
	attributes: Record<string, string> = {};
	className = "";
	id = "";
	textContent = "";
	type = "";
	disabled = false;
	private clicks: Array<() => void> = [];
	constructor(readonly tagName: string) {}
	setAttribute(name: string, value: string) {
		this.attributes[name] = value;
	}
	append(...nodes: FakeElement[]) {
		this.children.push(...nodes);
	}
	replaceChildren(...nodes: FakeElement[]) {
		this.children = nodes;
	}
	addEventListener(type: string, listener: () => void) {
		if (type === "click") this.clicks.push(listener);
	}
	click() {
		if (!this.disabled) for (const listener of this.clicks) listener();
	}
	/** The first element (depth first) that `test` accepts. */
	find(test: (el: FakeElement) => boolean): FakeElement | null {
		for (const child of this.children) {
			if (test(child)) return child;
			const hit = child.find(test);
			if (hit) return hit;
		}
		return null;
	}
}

function withFakeDocument<T>(run: () => Promise<T>): Promise<T> {
	const g = globalThis as Record<string, unknown>;
	const before = g.document;
	g.document = { createElement: (tag: string) => new FakeElement(tag) };
	return run().finally(() => {
		g.document = before;
	});
}

describe("item 5: after Sign out the gate shows at once (no blank Loading… screen)", () => {
	it("Settings shows the gate in place after Sign out: no reload of the app", () => {
		const settings = code("apps/mobile/src/app/settings-screen.tsx");
		const signOut = between(settings, "const doSignOut = async () => {", "const doDeleteAccount = async () => {");
		expect(signOut).toMatch(/await signOut\(\);\s*if \(status\.mode === "required"\) void showGateAfterSignOut\(\);/);
		expect(signOut).not.toContain("window.location.reload()");
		expect(settings).toContain('import { showGateAfterSignOut } from "../publik/gate-ui";');
	});

	it("showGateAfterSignOut draws the sign-in screen before anything waits, then runs the gate, then shows the app again", () => {
		const ui = code("apps/mobile/src/publik/gate-ui.ts");
		const fn = ui.slice(ui.indexOf("export async function showGateAfterSignOut()"));
		const draw = fn.indexOf('domGateUI(layer, (url) => open(url), gateScreen("sign_in", null))');
		expect(draw).toBeGreaterThan(0);
		// No await (and no "Loading…") before the sign-in screen is drawn.
		expect(fn.slice(0, draw)).not.toContain("await");
		expect(fn).not.toContain("Loading…");
		expect(fn.indexOf("await startPublik(ui, host);")).toBeGreaterThan(draw);
		// The gate covers the app (fixed, on top), and the app under it takes no tap until the sign-in.
		expect(fn).toContain('layer.style.cssText = "position:fixed;inset:0;z-index:2147483647;";');
		expect(fn).toContain('app?.setAttribute("inert", "");');
		expect(fn.indexOf("layer.remove();")).toBeGreaterThan(fn.indexOf("await startPublik(ui, host);"));
		expect(fn.indexOf('app?.removeAttribute("inert");')).toBeGreaterThan(fn.indexOf("await startPublik(ui, host);"));
	});

	it("the first screen shows at once; a tap on it opens publik's page as soon as the new key is there; the sign-in ends the gate", async () => {
		await withFakeDocument(async () => {
			const { domGateUI } = (await import("../src/publik/gate-ui")) as GateUiModule;
			const p = await signedInBefore();
			await gate.attachHost(p.host);
			await gate.signOut();
			expect(p.files.has("apps/kneecap.json")).toBe(false);
			p.requests.length = 0;
			// publik is slow to answer: before 1.0.8 the screen was blank all this time.
			let answer!: () => void;
			p.server.hold = new Promise<void>((resolve) => (answer = resolve));
			p.server.wallet = anonymous;
			const layer = new FakeElement("div");
			const ui = domGateUI(layer as unknown as HTMLElement, (url) => void p.host.openUrl({ url }), gate.gateScreen("sign_in", null));
			// At once: the sign-in screen with its button, before any request.
			const screen = layer.find((el) => el.dataset.screen === "sign_in");
			expect(screen).not.toBeNull();
			expect(layer.find((el) => el.tagName === "h1")?.textContent).toBe("Sign in with publik");
			const button = layer.find((el) => el.tagName === "button");
			expect(button?.textContent).toBe("Sign in with publik");
			expect(p.requests).toEqual([]);
			const done = gate.startPublik(ui, p.host, "required");
			button!.click(); // the person taps before publik answers
			await tick(30);
			expect(p.opened).toEqual([]);
			answer();
			p.server.hold = null;
			for (let i = 0; i < 50 && p.opened.length === 0; i++) await tick(5);
			expect(p.opened).toEqual([`${ORIGIN}/claim/abc?in_app=1`]);
			// The gate waits for the sign-in on the publik page.
			for (let i = 0; i < 50 && !layer.find((el) => el.className === "kc-publik-gate__note" && el.textContent !== ""); i++) await tick(5);
			expect(layer.find((el) => el.className === "kc-publik-gate__note")?.textContent).toBe("Waiting for you to sign in on the publik page.");
			p.server.wallet = claimed;
			let passed = false;
			void done.then(() => (passed = true));
			for (let i = 0; i < 50 && !passed; i++) {
				p.browserTick();
				await tick(5);
			}
			expect(passed).toBe(true);
			expect(gate.getStatus()).toMatchObject({ signedIn: true, handle: "mann", offline: false });
		});
	});

	it("a tap on the first screen is dropped when publik is not reachable (the next screen is Retry)", async () => {
		await withFakeDocument(async () => {
			const { domGateUI } = (await import("../src/publik/gate-ui")) as GateUiModule;
			const layer = new FakeElement("div");
			const ui = domGateUI(layer as unknown as HTMLElement, () => undefined, gate.gateScreen("sign_in", null));
			layer.find((el) => el.tagName === "button")!.click();
			await tick(0);
			let answered: string | null = null;
			void ui.show(gate.gateScreen("unreachable", null), new AbortController().signal).then((a) => (answered = a));
			await tick(0);
			expect(answered).toBeNull();
			expect(layer.find((el) => el.dataset.screen === "unreachable")).not.toBeNull();
		});
	});
});

describe("item 6: Settings checks the publik status again (front, network change)", () => {
	it("Settings starts the checks when it opens and stops them when it closes", () => {
		const settings = code("apps/mobile/src/app/settings-screen.tsx");
		const effect = between(settings, "useEffect(() => {", "}, []);");
		expect(effect).toContain("const stopRefresh = refreshStatusOnChange();");
		expect(effect).toMatch(/return \(\) => \{[^}]*stopRefresh\(\);/);
		// The checks use the bridge's foreground event (native "foreground" + visibilitychange) and the window's network events.
		const publik = code("apps/mobile/src/publik/publik.ts");
		const watch = between(publik, "export function refreshStatusOnChange(", "\n}\n");
		expect(watch).toContain("host.onForeground(trigger)");
		expect(watch).toContain('network?.addEventListener("online", trigger);');
		expect(watch).toContain('network?.addEventListener("offline", trigger);');
		expect(watch).toContain('typeof window === "undefined" ? null : window');
	});

	it("'publik is not reachable now' ends when publik answers again, and comes back when the network goes", async () => {
		const p = await offlinePass();
		p.server.offline = false;
		await gate.refreshStatus();
		expect(gate.getStatus()).toMatchObject({ signedIn: true, handle: "mann", offline: false });
		p.server.offline = true;
		await gate.refreshStatus();
		expect(gate.getStatus()).toMatchObject({ signedIn: true, handle: "mann", offline: true });
	});

	it("triggers close together make ONE check; one check at a time; nothing after the stop", async () => {
		const p = await offlinePass();
		p.server.offline = false;
		const network = new EventTarget();
		const stop = gate.refreshStatusOnChange({ network, waitMs: 40 });
		// Open, then the app comes to the front and the network changes several times.
		p.comeToFront();
		for (let i = 0; i < 5; i++) network.dispatchEvent(new Event(i % 2 ? "offline" : "online"));
		p.comeToFront();
		await tick(20);
		expect(p.wallets()).toBe(0); // the debounce waits
		await tick(80);
		expect(p.wallets()).toBe(1);
		expect(gate.getStatus().offline).toBe(false);
		// A slow answer: calls during the check give ONE more check, not one each.
		let answer!: () => void;
		p.server.hold = new Promise<void>((resolve) => (answer = resolve));
		const first = gate.refreshStatus();
		await tick(5);
		void gate.refreshStatus();
		void gate.refreshStatus();
		void gate.refreshStatus();
		await tick(20);
		expect(p.wallets()).toBe(2);
		answer();
		p.server.hold = null;
		await first;
		expect(p.wallets()).toBe(3);
		stop();
		network.dispatchEvent(new Event("online"));
		p.comeToFront();
		await tick(80);
		expect(p.wallets()).toBe(3);
	});

	it("signed out: the checks send nothing; publik says signed out: Settings shows signed out", async () => {
		const fresh = phone();
		await gate.attachHost(fresh.host);
		await gate.refreshStatus();
		expect(fresh.requests).toEqual([]);
		gate._resetForTests();
		const p = await offlinePass();
		p.server.offline = false;
		p.server.wallet = anonymous;
		await gate.refreshStatus();
		expect(gate.getStatus()).toMatchObject({ signedIn: false, offline: false });
		// No offline pass after it: the key stays, its sign-in time goes.
		expect(JSON.parse(p.files.get("apps/kneecap.json")!).claimed_at).toBeNull();
		expect(gate._telemetryTimerRunning()).toBe(false);
	});
});

describe("item 8: speech recognition on this phone only; the permission only at Generate on a project with sound", () => {
	const SPEECH = "publik kneecap makes captions from the speech in your clips. Speech recognition runs on this phone.";
	const NEW_MESSAGE = "Captions need speech recognition on this phone, and this phone does not have it.";

	it("the fallback engine runs on this phone only: no request without an on-device model, and every request requires it", () => {
		const swift = code("apps/mobile/ios/App/App/NativeMedia/AppleSpeechTranscriber.swift");
		const engine = between(swift, "static func recognizeWithBufferRequest(", "recognizer.recognitionTask(with: request)");
		const guardAt = engine.indexOf("guard recognizer.supportsOnDeviceRecognition else {");
		const requestAt = engine.indexOf("let request = SFSpeechAudioBufferRecognitionRequest()");
		expect(guardAt).toBeGreaterThan(0);
		expect(requestAt).toBeGreaterThan(guardAt);
		expect(between(engine, "guard recognizer.supportsOnDeviceRecognition else {", "let request =")).toContain("completion(.failure(.onDeviceUnavailable(");
		expect(engine).toMatch(/let request = SFSpeechAudioBufferRecognitionRequest\(\)\s*request\.requiresOnDeviceRecognition = true/);
		expect(engine).not.toMatch(/if recognizer\.supportsOnDeviceRecognition \{/);
		// No URL request (the old server-capable path) anywhere; the iOS 26 engine is on-device (SpeechTranscriber).
		expect(swift).not.toContain("SFSpeechURLRecognitionRequest(");
		expect(swift).toContain("SpeechAnalyzer(modules: [transcriber])");
		// The plugin maps onDeviceUnavailable to UNSUPPORTED, which the panel turns into its plain message.
		const plugin = code("apps/mobile/ios/App/App/NativeBridgePlugin+Transcribe.swift");
		expect(plugin).toMatch(/case \.localeUnsupported, \.onDeviceUnavailable:\s*call\.reject\(error\.description, "UNSUPPORTED"\)/);
	});

	it("the plugin reads the clip's sound before it asks for the permission; nothing else asks for it", () => {
		const plugin = code("apps/mobile/ios/App/App/NativeBridgePlugin+Transcribe.swift");
		const method = between(plugin, "@objc func transcribe(_ call: CAPPluginCall) {", "\n}\n");
		const extract = method.indexOf("AppleSpeechTranscriber.extractAudio(from: sourceURL)");
		const ask = method.indexOf("SFSpeechRecognizer.requestAuthorization");
		expect(extract).toBeGreaterThan(0);
		expect(ask).toBeGreaterThan(extract);
		// The prompt is only in the .success arm of the audio step: a clip with no sound fails before it.
		expect(between(method, "case .failure(let error):", "case .success(let audioOnlyURL):")).not.toContain("requestAuthorization");
		// The temporary audio file goes in every arm.
		expect([...method.matchAll(/try\? FileManager\.default\.removeItem\(at: audioOnlyURL\)/g)].length).toBe(4);
		// One prompt call in the iOS app, in this method only.
		const asks = files("apps/mobile/ios/App/App", /\.swift$/).filter((f) => code(f).includes("requestAuthorization") && /SFSpeechRecognizer\.requestAuthorization/.test(code(f)));
		expect(asks).toEqual(["apps/mobile/ios/App/App/NativeBridgePlugin+Transcribe.swift"]);
		// TS: only the captions action calls transcribe (app start, the editor and the panel opening do not).
		const callers = [...files("apps/mobile/src", /\.(ts|tsx)$/), ...files("packages/mobile-ui/src", /\.(ts|tsx)$/)].filter((f) =>
			/\.transcribe\(\{/.test(code(f)),
		);
		const debugOnly = ["apps/mobile/src/autotest.tsx", "apps/mobile/src/legacy-harness.ts", "apps/mobile/src/spike/tests/transcription.ts"];
		expect(callers.filter((f) => !debugOnly.includes(f))).toEqual(["packages/mobile-ui/src/editor/captions-actions.ts"]);
		// The panel calls the action only from the Generate button.
		const panel = code("packages/mobile-ui/src/components/panels/captions-panel.tsx");
		expect([...panel.matchAll(/generateCaptions\(/g)].length).toBe(1);
		expect(between(panel, "const handleGenerate = () => {", "return (")).toContain("generateCaptions({ editor, stylePresetId: stylePreset })");
		expect(panel).toContain("onClick={handleGenerate}");
	});

	it("Generate: no sound gives a plain message and no transcription; a phone without on-device recognition gets the new plain message", async () => {
		const actions = (await import(join(REPO, "packages/mobile-ui/src/editor/captions-actions.ts"))) as {
			CAPTION_MESSAGES: Record<string, string>;
			generateCaptionsForClip: (args: { editor: unknown; stylePresetId: string }) => Promise<unknown>;
		};
		expect(actions.CAPTION_MESSAGES.unsupported).toBe(NEW_MESSAGE);
		expect(NEW_MESSAGE.split(/\s+/).length).toBeLessThanOrEqual(20);
		expect(NEW_MESSAGE).not.toMatch(/fixture|\/|\\|native|harness|on-device|server/i);
		const paths = (await import(join(REPO, "packages/editor-core/src/media/native-paths.ts"))) as {
			registerNativeMediaPathResolver: (args: { root: string; toPlaybackUri: (uri: string) => string }) => void;
			__resetNativeMediaPathResolverForTests: () => void;
		};
		const bridgeModule = (await import(join(REPO, "packages/native-bridge/src/index.ts"))) as {
			getNativeBridge: () => Promise<{ platform: string; transcribe: (...args: unknown[]) => unknown }>;
		};
		const bridge = await bridgeModule.getNativeBridge();
		expect(bridge.platform).toBe("web"); // the web fallback: transcribe() rejects with UNSUPPORTED
		const original = bridge.transcribe;
		let calls = 0;
		bridge.transcribe = (...args: unknown[]) => {
			calls += 1;
			return original.apply(bridge, args);
		};
		paths.registerNativeMediaPathResolver({ root: "/custody", toPlaybackUri: (uri) => uri });
		try {
			const TICKS = 120_000;
			const video = (extra: Record<string, unknown> = {}) => ({
				id: "v1", type: "video", mediaId: "a1", name: "v1", startTime: 0, duration: 4 * TICKS, trimStart: 0, trimEnd: 0, params: {}, ...extra,
			});
			const editorWith = (main: unknown[], hasAudio: boolean | undefined) => ({
				scenes: { getActiveScene: () => ({ tracks: { main: { elements: main }, overlay: [], audio: [] } }) },
				media: { getAssets: () => [{ id: "a1", name: "a1.mov", type: "video", duration: 4, nativeRelativePath: "Media/a1.mov", hasAudio }] },
			});
			// No sound: a video without an audio track, or a muted one. A plain message, and no transcription.
			for (const editor of [editorWith([video()], false), editorWith([video({ params: { muted: true } })], true)]) {
				await expect(actions.generateCaptionsForClip({ editor, stylePresetId: "classic" })).rejects.toThrow(actions.CAPTION_MESSAGES.noAudio!);
			}
			expect(calls).toBe(0);
			// Sound, but this phone has no on-device recognition (UNSUPPORTED): the new plain message.
			await expect(actions.generateCaptionsForClip({ editor: editorWith([video()], true), stylePresetId: "classic" })).rejects.toThrow(NEW_MESSAGE);
			expect(calls).toBe(1);
		} finally {
			bridge.transcribe = original;
			paths.__resetNativeMediaPathResolverForTests();
		}
	});

	it("the purpose string is true and plain, and the app's texts make the same claim", () => {
		const plist = raw("apps/mobile/ios/App/App/Info.plist").replace(/<!--[\s\S]*?-->/g, "");
		const speech = /<key>NSSpeechRecognitionUsageDescription<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? "";
		expect(speech).toBe(SPEECH);
		for (const sentence of speech.split(/(?<=\.)\s+/)) expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(20);
		// The Captions panel note says the same thing.
		expect(code("packages/mobile-ui/src/components/panels/captions-panel.tsx")).toContain("Speech recognition runs on this phone.");
		// No shipped text says that audio never leaves the phone (iOS's own prompt says speech data may go to Apple).
		const shipped = [
			...files("apps/mobile/src", /\.(ts|tsx|css|html)$/),
			...files("apps/mobile/public", /\.(json|txt|html)$/),
			...files("apps/mobile/ios/App/App", /\.(swift|plist|strings|xcprivacy)$/),
			...files("apps/mobile/android/app/src/main", /\.(xml|java|kt)$/),
			...files("packages/mobile-ui/src", /\.(ts|tsx)$/),
			"apps/mobile/index.html",
		];
		expect(shipped.length).toBeGreaterThan(50);
		expect(shipped.filter((f) => /never leaves|leaves your phone|transcribes your clips/i.test(raw(f)))).toEqual([]);
	});
});

describe("item 10a: Settings > Licenses shows the parts of this app", () => {
	type Entry = { name: string; version: string; license: string; source: string; note: string; text: string };
	const list = (JSON.parse(raw("apps/mobile/public/licenses/third-party-licenses.json")) as { entries: Entry[] }).entries;
	const ANDROID_ONLY = ["@capacitor/android", "AndroidX (appcompat, core, activity, coordinatorlayout, core-splashscreen) and Media3", "Kotlin standard library"];

	it("iOS: no Android parts; Android: no iOS parts; both: the shared web parts; the web preview: all", async () => {
		const { licensesFor, licenseApp } = (await import("../src/app/licenses-platform")) as typeof import("../src/app/licenses-platform");
		const names = (platform: "ios" | "android" | "web") => licensesFor(list, platform).map((e) => e.name);
		const ios = names("ios");
		const android = names("android");
		for (const name of ANDROID_ONLY) {
			expect(ios).not.toContain(name);
			expect(android).toContain(name);
		}
		expect(ios).toContain("@capacitor/ios");
		expect(android).not.toContain("@capacitor/ios");
		const shared = list.filter((e) => licenseApp(e) === null).map((e) => e.name);
		expect(shared).toEqual(expect.arrayContaining(["react", "@capacitor/core", "mediabunny", "soundtouchjs", "Albert Sans (font)", "flag-icons (flag stickers)"]));
		for (const name of shared) {
			expect(ios).toContain(name);
			expect(android).toContain(name);
		}
		expect(ios.length).toBe(shared.length + 1);
		expect(android.length).toBe(shared.length + ANDROID_ONLY.length);
		expect(names("web")).toEqual(list.map((e) => e.name));
		// The list order stays.
		expect(ios).toEqual(list.map((e) => e.name).filter((n) => ios.includes(n)));
		// A future part marked "iOS app only." is on iOS only.
		expect(licenseApp({ name: "SomeKit", note: "iOS app only." })).toBe("ios");
	});

	it("the screen takes the platform from the native bridge and shows only that list", () => {
		const screen = code("apps/mobile/src/app/licenses-screen.tsx");
		expect(screen).toContain('import { getNativeBridge } from "@kneecap/native-bridge";');
		expect(screen).toContain('import { licensesFor, type LicensePlatform } from "./licenses-platform";');
		expect(screen).toMatch(/return \(await getNativeBridge\(\)\)\.platform;/);
		expect(screen).toMatch(/Promise\.all\(\[loadLicenses\(\), appPlatform\(\)\]\)\.then\(\s*\(\[list, platform\]\) => \{\s*if \(live\) setEntries\(licensesFor\(list, platform\)\);/);
		// No file in apps/mobile/src imports @capacitor/* (the bridge-import gate).
		const hits = files("apps/mobile/src", /\.(ts|tsx|js|jsx)$/).filter((f) => /from ['"]@capacitor\/|require\(['"]@capacitor\//.test(raw(f)));
		expect(hits).toEqual([]);
	});
});
