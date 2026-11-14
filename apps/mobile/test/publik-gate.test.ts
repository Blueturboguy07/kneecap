/**
 * The publik gate (src/publik/publik.ts) against a fake phone and a fake
 * publik: the same cases as the publik repo's tests/publik-module-gate.test.ts
 * for the reference modules, plus the phone's own: the in-app browser, the
 * check when the app comes back to the front, the offline pass after a
 * sign-in, the PUBLIK_API_BASE_URL test hook, and the self-test line.
 * Then the two gate modes (PUBLIK_GATE_MODE) and the Settings actions:
 * sign-in from Settings, Sign out, Delete account and the usage switch.
 * Then the store-review fixes: a key file that cannot be saved, answers that
 * are not publik's (a captive portal, 408, 429), the limit on new keys after
 * a 401, and the usage timer in the background.
 *
 * Run: bun test apps/mobile/test (outside src/: apps/mobile's tsconfig has
 * no bun types).
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { PublikHost, PublikLaunch, PublikRequest } from "@kneecap/native-bridge/publik-host";

type Gate = typeof import("../src/publik/publik");
type GateScreen = import("../src/publik/publik").GateScreen;
let gate: Gate;

beforeAll(async () => {
	(globalThis as Record<string, unknown>).__PUBLIK_APP_TOKEN__ = "pat_gatetest";
	gate = await import("../src/publik/publik");
});
afterEach(() => gate._resetForTests());

const WORDS = {
	title: "Sign in with publik",
	signInBody: "This app uses your publik account. Click Sign in with publik, then sign in in your browser. This window continues when you are signed in.",
	signInButton: "Sign in with publik",
	waiting: "Waiting for you to sign in in your browser.",
	unreachable: "publik is not reachable. Check your connection.",
	retry: "Retry",
};

type WalletBody = { claim_state: "anonymous" | "claimed"; account: { handle: string } | null; plan: { kind: string; label: string | null }; balance_micros: number };
const anonymous: WalletBody = { claim_state: "anonymous", account: null, plan: { kind: "none", label: null }, balance_micros: 0 };
const claimed: WalletBody = { claim_state: "claimed", account: { handle: "mann" }, plan: { kind: "none", label: null }, balance_micros: 0 };
const ORIGIN = "https://publikhq.com";

function phone(settings: PublikLaunch["settings"] = {}) {
	const files = new Map<string, string>();
	const requests: Array<{ method: string; url: string; auth: string | null; body: Record<string, unknown> | null; timeoutMs: number; keyFileThere: boolean }> = [];
	const opened: string[] = [];
	const selfTest: string[] = [];
	let foreground: (() => void) | null = null;
	let background: (() => void) | null = null;
	const server = {
		offline: false,
		installsStatus: 201,
		walletStatus: 200,
		wallets: [anonymous] as WalletBody[],
		/** Every request gets this answer (a captive portal, a proxy, a rate limit). */
		answerAll: null as { status: number; data: unknown } | null,
		/** POST /installs/revoke never answers. */
		hangRevoke: false,
		/** How many more file writes work; then writeFile answers false. */
		writesLeft: Number.POSITIVE_INFINITY,
	};
	const host: PublikHost = {
		async launch() {
			return { platform: "ios", appVersion: "1.0.1", deviceName: "iPhone", arch: "arm64", settings };
		},
		async request(req: PublikRequest) {
			await new Promise((r) => setTimeout(r, 0)); // a real request never answers in the same tick
			requests.push({ method: req.method, url: req.url, auth: req.headers.Authorization ?? null, body: req.body ? JSON.parse(req.body) : null,
				timeoutMs: req.timeoutMs, keyFileThere: files.has("apps/kneecap.json") });
			if (server.offline) throw new Error("The Internet connection appears to be offline.");
			if (server.answerAll) return server.answerAll;
			const path = new URL(req.url).pathname;
			if (path.endsWith("/installs/revoke")) return server.hangRevoke ? new Promise<never>(() => {}) : { status: 204, data: "" };
			if (path.endsWith("/installs")) {
				if (server.installsStatus !== 201) return { status: server.installsStatus, data: { error: { type: "invalid_app_token", message: "This app token is not valid." } } };
				const sent = JSON.parse(req.body ?? "{}") as { install_id: string };
				return { status: 201, data: { key: "pk_live_gatetest", install_id: sent.install_id, claim_url: `${ORIGIN}/claim/abc`, claim_state: "anonymous" } };
			}
			if (path.endsWith("/wallet")) {
				if (server.walletStatus !== 200) return { status: server.walletStatus, data: { error: { type: "invalid_key", message: "This key is not valid." } } };
				const w = server.wallets.length > 1 ? server.wallets.shift()! : server.wallets[0]!;
				return { status: 200, data: { ...w, claim_url: `${ORIGIN}/claim/abc`, top_up_url: `${ORIGIN}/wallet?top_up=1`, linked_at: null } };
			}
			if (path.endsWith("/telemetry")) return { status: 204, data: "" };
			return { status: 404, data: {} };
		},
		async readFile({ name }) {
			return files.get(name) ?? null;
		},
		async writeFile({ name, text, exclusive }) {
			if (exclusive && files.has(name)) return false;
			if (server.writesLeft <= 0) return false;
			server.writesLeft--;
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
		async finishSelfTest({ line }) {
			selfTest.push(line);
		},
		onForeground(listener) {
			foreground = listener;
			return () => {
				foreground = null;
			};
		},
		onBackground(listener) {
			background = listener;
			return () => {
				background = null;
			};
		},
		async showFirstRun() {},
	};
	return { host, files, requests, opened, selfTest, server, comeToFront: () => foreground?.(), goToBackground: () => background?.() };
}

/** Presses a button by screen title, or the first button of a screen with no note; else waits. Gives up after 7 screens of one title. */
function scriptedUI(p: ReturnType<typeof phone>, press: Record<string, string> = {}, onWait?: () => void) {
	const seen: GateScreen[] = [];
	const count: Record<string, number> = {};
	return {
		seen,
		ui: {
			show(s: GateScreen) {
				seen.push(s);
				if ((count[s.title] = (count[s.title] ?? 0) + 1) > 6) return Promise.reject(new Error("gave up"));
				const want = press[s.title];
				if (want) return Promise.resolve(s.buttons.find((b) => b.label === want)!.action);
				if (!s.note) return Promise.resolve(s.buttons[0]!.action);
				if (onWait) setTimeout(onWait, 5);
				return new Promise<never>(() => {});
			},
			openUrl(url: string) {
				void p.host.openUrl({ url });
			},
		},
	};
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("the publik gate on a phone", () => {
	it("signs in through the in-app browser, checks at once when the app is back in front, then counts the open with the install key", async () => {
		const p = phone();
		p.server.wallets = [anonymous, anonymous, claimed, claimed];
		const { ui, seen } = scriptedUI(p, {}, p.comeToFront);
		const result = await gate.ensureSignedIn(ui, p.host);
		expect(seen.map((s) => [s.title, s.note])).toEqual([
			[WORDS.title, null],
			[WORDS.title, WORDS.waiting],
		]);
		expect(seen[0]).toMatchObject({ title: WORDS.title, body: WORDS.signInBody, buttons: [{ action: "sign_in", label: WORDS.signInButton }] });
		expect(p.opened).toEqual([`${ORIGIN}/claim/abc`]);
		expect(result).toMatchObject({ key: "pk_live_gatetest", choice: null, offline: false });
		await tick();
		const events = p.requests.filter((r) => r.url === `${ORIGIN}/api/v1/telemetry`);
		expect(events.length).toBe(1);
		expect(events[0]!.auth).toBe("Bearer pk_live_gatetest");
		expect(Object.keys(events[0]!.body!).sort()).toEqual(["app", "app_version", "arch", "event", "install_id", "os", "v"]);
		expect(events[0]!.body).toMatchObject({ v: 1, app: "kneecap", event: "app_opened", app_version: "1.0.1", os: "ios", arch: "arm64" });
		expect(JSON.parse(p.files.get("apps/kneecap.json")!)).toMatchObject({ key: "pk_live_gatetest" });
		expect(JSON.parse(p.files.get("apps/kneecap.json")!).claimed_at).toBeString();
		// /installs carries no key; every /wallet call carries it.
		expect(p.requests.filter((r) => r.url.endsWith("/installs")).every((r) => r.auth === null)).toBe(true);
		expect(p.requests.filter((r) => r.url.endsWith("/wallet")).every((r) => r.auth === "Bearer pk_live_gatetest")).toBe(true);
		expect(p.requests.find((r) => r.url.endsWith("/installs"))!.body).toMatchObject({ app_token: "pat_gatetest", app_slug: "kneecap", app_version: "1.0.1", os: "ios", arch: "arm64" });
	});

	it("has no other way past the sign-in screen while publik says anonymous", async () => {
		const p = phone();
		const { ui, seen } = scriptedUI(p, { [WORDS.title]: WORDS.signInButton });
		await expect(gate.ensureSignedIn(ui, p.host)).rejects.toThrow("gave up");
		expect(seen.every((s) => s.title === WORDS.title && s.buttons.length === 1)).toBe(true);
		await tick();
		expect(p.requests.some((r) => r.url.endsWith("/telemetry"))).toBe(false);
	});

	it("shows Retry and nothing else when publik is not reachable on a phone that never signed in", async () => {
		const p = phone();
		p.server.offline = true;
		const { ui, seen } = scriptedUI(p);
		await expect(gate.ensureSignedIn(ui, p.host)).rejects.toThrow("gave up");
		expect(seen.length).toBe(7);
		for (const s of seen) expect(s).toMatchObject({ title: WORDS.title, body: WORDS.unreachable, note: null, buttons: [{ action: "retry", label: WORDS.retry }] });
	});

	it("opens without publik on a phone that signed in before (local-first), and not after a sign-out", async () => {
		const p = phone();
		p.server.wallets = [claimed];
		await gate.ensureSignedIn(scriptedUI(p).ui, p.host);
		gate._resetForTests();
		p.server.offline = true;
		const offline = scriptedUI(p);
		expect(await gate.ensureSignedIn(offline.ui, p.host)).toMatchObject({ key: "pk_live_gatetest", wallet: null, offline: true });
		expect(offline.seen).toEqual([]);
		gate._resetForTests();
		// Signed out on publik: the next start online clears the pass; offline after that shows the gate.
		p.server.offline = false;
		p.server.wallets = [anonymous];
		await expect(gate.ensureSignedIn(scriptedUI(p, { [WORDS.title]: WORDS.signInButton }).ui, p.host)).rejects.toThrow("gave up");
		gate._resetForTests();
		p.server.offline = true;
		const after = scriptedUI(p);
		await expect(gate.ensureSignedIn(after.ui, p.host)).rejects.toThrow("gave up");
		expect(after.seen[0]!.body).toBe(WORDS.unreachable);
	});

	it("passes with no screen when the phone is signed in (USES_AI is false: no plan screen)", async () => {
		const p = phone();
		p.server.wallets = [claimed];
		const { ui, seen } = scriptedUI(p);
		expect(await gate.ensureSignedIn(ui, p.host)).toMatchObject({ choice: null, offline: false });
		expect(seen).toEqual([]);
		expect(gate.USES_AI).toBe(false);
	});

	it("provisions a new key after a 401", async () => {
		const p = phone();
		p.server.walletStatus = 401;
		const stop = { show: () => Promise.reject(new Error("stop")), openUrl: () => undefined };
		const done = gate.ensureSignedIn(stop, p.host).catch(() => undefined);
		await tick(50);
		expect(p.requests.filter((r) => r.url.endsWith("/installs")).length).toBeGreaterThanOrEqual(2);
		p.server.walletStatus = 200; // the next start-up step shows the sign-in screen, and the stub UI ends the gate
		await done;
	});

	it("sends every call to PUBLIK_API_BASE_URL when that launch setting is there", async () => {
		const p = phone({ PUBLIK_API_BASE_URL: "http://127.0.0.1:8787/api/v1/" });
		p.server.wallets = [claimed];
		await gate.ensureSignedIn(scriptedUI(p).ui, p.host);
		await tick();
		expect(p.requests.map((r) => r.url)).toEqual([
			"http://127.0.0.1:8787/api/v1/installs",
			"http://127.0.0.1:8787/api/v1/wallet",
			"http://127.0.0.1:8787/api/v1/telemetry",
		]);
	});

	it("sends no usage event with DO_NOT_TRACK, and the gate still runs", async () => {
		const p = phone({ DO_NOT_TRACK: "1" });
		p.server.wallets = [claimed];
		await gate.ensureSignedIn(scriptedUI(p).ui, p.host);
		await tick();
		expect(p.requests.some((r) => r.url.endsWith("/telemetry"))).toBe(false);
		expect(p.files.has("telemetry.json")).toBe(false);
	});

	it("PUBLIK_SELF_TEST prints the ok line only after a real GET /wallet answers", async () => {
		const run = async (setup: (p: ReturnType<typeof phone>) => void) => {
			gate._resetForTests();
			const p = phone({ PUBLIK_SELF_TEST: "1" });
			setup(p);
			void gate.ensureSignedIn(scriptedUI(p).ui, p.host);
			for (let i = 0; i < 50 && p.selfTest.length === 0; i++) await tick(5);
			return p;
		};
		const ok = await run(() => {});
		expect(ok.selfTest).toEqual(["publik self-test: ok kneecap 1.0.1"]);
		expect(ok.requests.map((r) => new URL(r.url).pathname)).toEqual(["/api/v1/installs", "/api/v1/wallet"]);
		// A server error says nothing about the key: publik is not reachable.
		expect((await run((p) => (p.server.walletStatus = 500))).selfTest).toEqual(["publik self-test: failed: publik is not reachable. Check your connection."]);
		expect((await run((p) => (p.server.walletStatus = 403))).selfTest).toEqual(["publik self-test: failed: This key is not valid."]);
		expect((await run((p) => (p.server.offline = true))).selfTest).toEqual(["publik self-test: failed: publik is not reachable. Check your connection."]);
		expect((await run((p) => (p.server.installsStatus = 401))).selfTest).toEqual(["publik self-test: failed: This app token is not valid."]);
	});
});

const noScreen = {
	show: (): Promise<never> => Promise.reject(new Error("a screen was shown")),
	openUrl: () => undefined,
};
const paths = (p: ReturnType<typeof phone>) => p.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
const telemetry = (p: ReturnType<typeof phone>) => p.requests.filter((r) => r.url.endsWith("/telemetry"));

describe("PUBLIK_GATE_MODE", () => {
	it("is required by default: the gate shows, and startPublik resolves only after the sign-in", async () => {
		expect(gate.GATE_MODE).toBe("required");
		const p = phone();
		p.server.wallets = [anonymous, anonymous, claimed];
		const { ui, seen } = scriptedUI(p, {}, p.comeToFront);
		await gate.startPublik(ui, p.host);
		expect(seen.map((s) => s.title)).toEqual([WORDS.title, WORDS.title]);
		expect(gate.getStatus()).toMatchObject({ mode: "required", signedIn: true, handle: "mann" });
	});

	it("optional: the app opens with no screen, and a phone that never signed in sends nothing to publik", async () => {
		const p = phone();
		await gate.startPublik(noScreen, p.host, "optional");
		await tick();
		expect(p.requests).toEqual([]);
		expect(p.files.size).toBe(0);
		expect(gate.getStatus()).toMatchObject({ mode: "optional", signedIn: false, checking: false });
	});

	it("optional: Settings > Sign in with publik opens the in-app browser, waits for the sign-in, and only then counts the open", async () => {
		const p = phone();
		p.server.wallets = [anonymous, claimed];
		await gate.startPublik(noScreen, p.host, "optional");
		let waited = 0;
		const result = await gate.signIn({
			signal: new AbortController().signal,
			onWaiting: () => {
				waited = telemetry(p).length + 1; // 1: nothing was counted before the sign-in
				setTimeout(p.comeToFront, 5); // the person closes the browser: the app checks at once
			},
		});
		expect(result).toBe("signed_in");
		expect(waited).toBe(1);
		expect(p.opened).toEqual([`${ORIGIN}/claim/abc`]);
		expect(gate.getStatus()).toMatchObject({ mode: "optional", signedIn: true, handle: "mann" });
		await tick();
		expect(telemetry(p).map((r) => r.body!.event)).toEqual(["app_opened"]);
		expect(JSON.parse(p.files.get("apps/kneecap.json")!).claimed_at).toBeString();
	});

	it("optional: the sign-in from Settings stops when Settings closes (the signal aborts)", async () => {
		const p = phone();
		await gate.startPublik(noScreen, p.host, "optional");
		const abort = new AbortController();
		const result = await gate.signIn({ signal: abort.signal, onWaiting: () => setTimeout(() => abort.abort(), 5) });
		expect(result).toBe("cancelled");
		expect(gate.getStatus().signedIn).toBe(false);
		expect(telemetry(p)).toEqual([]);
	});

	it("optional: a phone that signed in before is checked at start with no screen, and counts the open again", async () => {
		const p = phone();
		p.server.wallets = [claimed];
		await gate.startPublik(noScreen, p.host, "optional");
		expect(await gate.signIn({ signal: new AbortController().signal })).toBe("signed_in");
		await tick(); // the first run's app_opened
		gate._resetForTests();
		p.requests.length = 0;
		await gate.startPublik(noScreen, p.host, "optional");
		await tick(50);
		expect(paths(p)).toEqual(["GET /api/v1/wallet", "POST /api/v1/telemetry"]);
		expect(gate.getStatus()).toMatchObject({ signedIn: true, checking: false, offline: false });
	});

	it("optional: signed out on publik, the start check ends the sign-in and counts nothing", async () => {
		const p = phone();
		p.server.wallets = [claimed];
		await gate.startPublik(noScreen, p.host, "optional");
		await gate.signIn({ signal: new AbortController().signal });
		await tick(); // the first run's app_opened
		gate._resetForTests();
		p.requests.length = 0;
		p.server.wallets = [anonymous];
		await gate.startPublik(noScreen, p.host, "optional");
		await tick(50);
		expect(paths(p)).toEqual(["GET /api/v1/wallet"]);
		expect(gate.getStatus().signedIn).toBe(false);
		expect(JSON.parse(p.files.get("apps/kneecap.json")!).claimed_at).toBeNull();
	});

	it("optional answers PUBLIK_SELF_TEST too", async () => {
		const p = phone({ PUBLIK_SELF_TEST: "1" });
		void gate.startPublik(noScreen, p.host, "optional");
		for (let i = 0; i < 50 && p.selfTest.length === 0; i++) await tick(5);
		expect(p.selfTest).toEqual(["publik self-test: ok kneecap 1.0.1"]);
	});
});

describe("Settings: Sign out, Delete account, usage counting", () => {
	async function signedInPhone(settings: PublikLaunch["settings"] = {}) {
		const p = phone(settings);
		p.server.wallets = [claimed];
		await gate.ensureSignedIn(scriptedUI(p).ui, p.host);
		await tick();
		return p;
	}

	it("Sign out revokes this phone's key on publik, deletes it from the phone, and ends the session", async () => {
		const p = await signedInPhone();
		await gate.signOut();
		const revoke = p.requests.find((r) => r.url.endsWith("/installs/revoke"));
		expect(revoke).toMatchObject({ method: "POST", auth: "Bearer pk_live_gatetest" });
		expect(p.files.has("apps/kneecap.json")).toBe(false);
		expect(gate.getStatus().signedIn).toBe(false);
	});

	it("Sign out still deletes the key when publik is not reachable", async () => {
		const p = await signedInPhone();
		p.server.offline = true;
		await gate.signOut();
		expect(p.files.has("apps/kneecap.json")).toBe(false);
	});

	it("Delete account deletes the key and the install ID, keeps the opt-out, and names publik's delete page", async () => {
		const p = await signedInPhone();
		await gate.setUsageCounting(false);
		expect(p.files.has("telemetry.json")).toBe(true);
		await gate.deletePublikData();
		expect(p.files.has("apps/kneecap.json")).toBe(false);
		expect(p.files.has("telemetry.json")).toBe(false);
		expect(JSON.parse(p.files.get("consent.json")!)).toEqual({ usage: false });
		expect(gate.DELETE_ACCOUNT_URL).toBe("https://publikhq.com/settings/profile#delete-account-title");
	});

	it("the usage switch saves the choice in consent.json; off sends nothing more, and the launch opt-out locks it", async () => {
		const p = await signedInPhone();
		expect(await gate.usageCounting()).toEqual({ on: true, locked: false });
		await gate.setUsageCounting(false);
		expect(JSON.parse(p.files.get("consent.json")!)).toEqual({ usage: false });
		expect(await gate.usageCounting()).toEqual({ on: false, locked: false });
		gate._resetForTests();
		const before = telemetry(p).length;
		await gate.ensureSignedIn(scriptedUI(p).ui, p.host); // the next start: signed in, counting off
		await tick();
		expect(telemetry(p).length).toBe(before);
		gate._resetForTests();
		const locked = await signedInPhone({ DO_NOT_TRACK: "1" });
		expect(await gate.usageCounting()).toEqual({ on: false, locked: true });
		expect(telemetry(locked)).toEqual([]);
	});
});

const PORTAL_PAGE = "<html><body>Sign in to the Wi-Fi to continue.</body></html>";
const installs = (p: ReturnType<typeof phone>) => p.requests.filter((r) => r.url.endsWith("/installs"));

describe("store review: Sign out and Delete account (item 3)", () => {
	async function signedInPhone() {
		const p = phone();
		p.server.wallets = [claimed];
		await gate.ensureSignedIn(scriptedUI(p).ui, p.host);
		await tick();
		return p;
	}

	it("Sign out deletes the key file before it asks publik to revoke the key, stops usage counting, and gives publik at most 3 s", async () => {
		const p = await signedInPhone();
		expect(gate._telemetryTimerRunning()).toBe(true);
		await gate.signOut();
		const revoke = p.requests.find((r) => r.url.endsWith("/installs/revoke"))!;
		expect(revoke).toMatchObject({ auth: "Bearer pk_live_gatetest", keyFileThere: false });
		expect(revoke.timeoutMs).toBeLessThanOrEqual(3_000);
		expect(gate._telemetryTimerRunning()).toBe(false);
		expect(gate.getStatus().signedIn).toBe(false);
	});

	it("Sign out finishes when publik never answers the revoke", async () => {
		const p = await signedInPhone();
		p.server.hangRevoke = true;
		const started = Date.now();
		await gate.signOut();
		expect(Date.now() - started).toBeLessThan(4_500);
		expect(p.files.has("apps/kneecap.json")).toBe(false);
		expect(gate.getStatus().signedIn).toBe(false);
	}, 10_000);

	it("Delete account deletes the files first and stops usage counting, also when publik is not reachable", async () => {
		const p = await signedInPhone();
		p.server.offline = true;
		await gate.deletePublikData();
		expect(p.files.has("apps/kneecap.json")).toBe(false);
		expect(p.files.has("telemetry.json")).toBe(false);
		expect(gate._telemetryTimerRunning()).toBe(false);
		expect(p.requests.find((r) => r.url.endsWith("/installs/revoke"))!.keyFileThere).toBe(false);
	});
});

describe("store review: a key file that cannot be saved (item 4)", () => {
	it("shows the not-reachable screen with Retry, never an error page", async () => {
		const p = phone();
		p.server.writesLeft = 0;
		const { ui, seen } = scriptedUI(p);
		await expect(gate.ensureSignedIn(ui, p.host)).rejects.toThrow("gave up");
		expect(seen.length).toBe(7);
		for (const s of seen) {
			expect(s).toMatchObject({ id: "unreachable", body: "publik could not save this phone's key.", buttons: [{ action: "retry", label: WORDS.retry }] });
		}
	});

	it("passes when the sign-in time cannot be saved (claimed_at is best effort)", async () => {
		const p = phone();
		p.server.wallets = [claimed];
		p.server.writesLeft = 1; // the key file only
		const { ui, seen } = scriptedUI(p);
		expect(await gate.ensureSignedIn(ui, p.host)).toMatchObject({ key: "pk_live_gatetest", offline: false });
		expect(seen).toEqual([]);
		expect(JSON.parse(p.files.get("apps/kneecap.json")!).claimed_at).toBeNull();
	});
});

describe("store review: answers that are not publik's (item 5)", () => {
	async function claimedThenReset() {
		const p = phone();
		p.server.wallets = [claimed];
		await gate.ensureSignedIn(scriptedUI(p).ui, p.host);
		await tick();
		gate._resetForTests();
		p.requests.length = 0;
		return p;
	}

	it("a captive portal's page (200, not JSON) is 'not reachable' on a phone that never signed in", async () => {
		const p = phone();
		p.server.answerAll = { status: 200, data: PORTAL_PAGE };
		const { ui, seen } = scriptedUI(p);
		await expect(gate.ensureSignedIn(ui, p.host)).rejects.toThrow("gave up");
		expect(seen[0]).toMatchObject({ id: "unreachable", body: WORDS.unreachable });
		expect(p.files.has("apps/kneecap.json")).toBe(false);
	});

	it("a signed-in phone behind a captive portal opens with the offline pass and keeps its key", async () => {
		const p = await claimedThenReset();
		p.server.answerAll = { status: 200, data: PORTAL_PAGE };
		const { ui, seen } = scriptedUI(p);
		expect(await gate.ensureSignedIn(ui, p.host)).toMatchObject({ key: "pk_live_gatetest", offline: true });
		expect(seen).toEqual([]);
		expect(JSON.parse(p.files.get("apps/kneecap.json")!).key).toBe("pk_live_gatetest");
	});

	it("a 401 page that is not publik's JSON does not throw the key away or get a new one", async () => {
		const p = await claimedThenReset();
		p.server.answerAll = { status: 401, data: PORTAL_PAGE };
		expect(await gate.ensureSignedIn(scriptedUI(p).ui, p.host)).toMatchObject({ offline: true });
		expect(installs(p)).toEqual([]);
		expect(p.files.has("apps/kneecap.json")).toBe(true);
	});

	it("a JSON 401 without publik's error object does not throw the key away", async () => {
		const p = await claimedThenReset();
		p.server.answerAll = { status: 401, data: { message: "proxy sign-in required" } };
		expect(await gate.ensureSignedIn(scriptedUI(p).ui, p.host)).toMatchObject({ offline: true });
		expect(installs(p)).toEqual([]);
	});

	it("a 2xx that is not a wallet is 'not reachable'", async () => {
		const p = await claimedThenReset();
		p.server.answerAll = { status: 200, data: { ok: true } };
		expect(await gate.ensureSignedIn(scriptedUI(p).ui, p.host)).toMatchObject({ offline: true });
	});

	for (const status of [408, 429]) {
		it(`${status} is 'not reachable': Retry on a new phone, the offline pass on a signed-in phone`, async () => {
			const answer = { status, data: { error: { type: "rate_limited", message: "Slow down." } } };
			const fresh = phone();
			fresh.server.answerAll = answer;
			const { ui, seen } = scriptedUI(fresh);
			await expect(gate.ensureSignedIn(ui, fresh.host)).rejects.toThrow("gave up");
			expect(seen[0]).toMatchObject({ id: "unreachable", body: WORDS.unreachable });
			gate._resetForTests();
			const p = await claimedThenReset();
			p.server.answerAll = answer;
			expect(await gate.ensureSignedIn(scriptedUI(p).ui, p.host)).toMatchObject({ offline: true });
		});
	}

	it("after publik's own 401 the gate gets at most 2 new keys, then shows publik's message with Retry", async () => {
		const p = phone();
		p.server.walletStatus = 401;
		const shown: GateScreen[] = [];
		const stopUI = {
			show: (s: GateScreen) => {
				shown.push(s);
				return Promise.reject(new Error("stop"));
			},
			openUrl: () => undefined,
		};
		await expect(gate.ensureSignedIn(stopUI, p.host)).rejects.toThrow("stop");
		expect(installs(p).length).toBe(3); // the first key and 2 new ones
		expect(shown).toHaveLength(1);
		expect(shown[0]).toMatchObject({ id: "unreachable", body: "This key is not valid.", buttons: [{ action: "retry" }] });
	});

	it("uses PUBLIK_API_BASE_URL only for this computer or the local network (this build has no PUBLIK_TEST_HOOKS)", async () => {
		expect(gate.testBaseUrl("https://publik.example.net/api/v1")).toBeNull();
		expect(gate.testBaseUrl("file:///etc/hosts")).toBeNull();
		expect(gate.testBaseUrl("http://localhost:8787/api/v1/")).toBe("http://localhost:8787/api/v1");
		expect(gate.testBaseUrl("http://10.0.2.2:8787/api/v1")).toBe("http://10.0.2.2:8787/api/v1");
		expect(gate.testBaseUrl("http://my-mac.local:8787/api/v1")).toBe("http://my-mac.local:8787/api/v1");
		expect(gate.testBaseUrl("http://[::1]:8787/api/v1")).toBe("http://[::1]:8787/api/v1");
		const p = phone({ PUBLIK_API_BASE_URL: "https://publik.example.net/api/v1" });
		p.server.wallets = [claimed];
		await gate.ensureSignedIn(scriptedUI(p).ui, p.host);
		expect(p.requests.length).toBeGreaterThan(0);
		expect(p.requests.every((r) => r.url.startsWith(`${ORIGIN}/api/v1/`))).toBe(true);
	});
});

describe("store review: the usage timer in the background (item 8)", () => {
	it("stops the 30-minute timer in the background and starts it again in front, with no new app_opened", async () => {
		const p = phone();
		p.server.wallets = [claimed];
		await gate.ensureSignedIn(scriptedUI(p).ui, p.host);
		await tick();
		expect(gate._telemetryTimerRunning()).toBe(true);
		p.goToBackground();
		expect(gate._telemetryTimerRunning()).toBe(false);
		p.comeToFront();
		expect(gate._telemetryTimerRunning()).toBe(true);
		await tick();
		expect(telemetry(p).map((r) => r.body!.event)).toEqual(["app_opened"]);
	});

	it("does not start the timer in front again after a sign-out", async () => {
		const p = phone();
		p.server.wallets = [claimed];
		await gate.ensureSignedIn(scriptedUI(p).ui, p.host);
		p.goToBackground();
		await gate.signOut();
		p.comeToFront();
		expect(gate._telemetryTimerRunning()).toBe(false);
	});
});
