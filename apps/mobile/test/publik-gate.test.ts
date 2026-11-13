/**
 * The publik gate (src/publik/publik.ts) against a fake phone and a fake
 * publik: the same cases as the publik repo's tests/publik-module-gate.test.ts
 * for the reference modules, plus the phone's own: the in-app browser, the
 * check when the app comes back to the front, the offline pass after a
 * sign-in, the PUBLIK_API_BASE_URL test hook, and the self-test line.
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
	const requests: Array<{ method: string; url: string; auth: string | null; body: Record<string, unknown> | null }> = [];
	const opened: string[] = [];
	const selfTest: string[] = [];
	let foreground: (() => void) | null = null;
	const server = { offline: false, installsStatus: 201, walletStatus: 200, wallets: [anonymous] as WalletBody[] };
	const host: PublikHost = {
		async launch() {
			return { platform: "ios", appVersion: "1.0.1", deviceName: "iPhone", arch: "arm64", settings };
		},
		async request(req: PublikRequest) {
			await new Promise((r) => setTimeout(r, 0)); // a real request never answers in the same tick
			requests.push({ method: req.method, url: req.url, auth: req.headers.Authorization ?? null, body: req.body ? JSON.parse(req.body) : null });
			if (server.offline) throw new Error("The Internet connection appears to be offline.");
			const path = new URL(req.url).pathname;
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
			files.set(name, text);
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
	};
	return { host, files, requests, opened, selfTest, server, comeToFront: () => foreground?.() };
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
		expect((await run((p) => (p.server.walletStatus = 500))).selfTest).toEqual(["publik self-test: failed: This key is not valid."]);
		expect((await run((p) => (p.server.offline = true))).selfTest).toEqual(["publik self-test: failed: publik is not reachable. Check your connection."]);
		expect((await run((p) => (p.server.installsStatus = 401))).selfTest).toEqual(["publik self-test: failed: This app token is not valid."]);
	});
});
