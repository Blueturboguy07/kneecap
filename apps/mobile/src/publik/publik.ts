// publik.ts — Sign in with publik and usage counting for kneecap (TypeScript, Capacitor webview).
// A port of publikhq.com/sdk/publik.ts.md for a phone. The gate words, the endpoints and the
// order of the steps are the same; the platform seam is a PublikHost (@kneecap/native-bridge/publik-host):
// native HTTP, the app's publik folder, the in-app browser and the launch settings.
// At app start, before any screen of the app: `await startPublik(ui, host)`. The build setting
// PUBLIK_GATE_MODE (vite.config.ts) picks one of two modes:
//
// "required" (the default): startPublik() runs ensureSignedIn(ui, host). It
//   1. loads or provisions this phone's publik key (POST /api/v1/installs);
//   2. shows Sign in with publik until GET /api/v1/wallet says "claimed" (no other way past it). The
//      button opens claim_url in the in-app browser; the app checks every 3 s for up to 10 minutes,
//      also while the browser covers the app (the native side sends a tick every 3 s then, because
//      the web view's own timers can stall under the browser), and at once when the app comes back
//      to the front. When the check sees the sign-in, the app closes the browser;
//   3. when USES_AI: asks once how the app pays for AI and stores the answer (setChoice() changes it);
//   4. starts usage counting: app_opened now, active_session every 30 minutes (POST /api/v1/telemetry).
// "optional": startPublik() shows no screen and the editor opens. Settings has "Sign in with publik"
//   (signIn(): steps 1 and 2 without the wall). A phone that never signed in sends nothing to publik;
//   usage counting starts only after a sign-in.
// Both modes: Settings has Sign out (signOut()), Delete account (deletePublikData() and then
// DELETE_ACCOUNT_URL in the in-app browser) and a usage-counting switch (setUsageCounting()).
// Self-test: the launch setting PUBLIK_SELF_TEST=1 makes it print `publik self-test: ok kneecap <version>`
// after a real GET /wallet answers, and end the app.
// Test hook: the launch setting PUBLIK_API_BASE_URL (for example http://127.0.0.1:8787/api/v1) replaces
// https://publikhq.com/api/v1 for every call below, but only for a server on this computer or local network
// (localhost, 127.x, ::1, the Android emulator's 10.0.2.2, *.local), unless the build has PUBLIK_TEST_HOOKS=1
// (vite.config.ts). The phone reads launch settings only in a debug build (Android: debuggable; iOS: Debug
// for PUBLIK_API_BASE_URL).
// publik is "not reachable" when the request does not complete, and also when the answer is not publik's
// (not JSON: a captive portal or a proxy page; 408, 429 or 5xx). Only publik's own JSON 401 or 403 from
// GET /wallet ends a key. POST /installs answering 403 install_revoked gets ONE new install with a new UUID.
// Sign out and Delete account can run while a wallet check waits for publik: after each wait the check
// reads the key again and writes nothing when it is gone (keyStillSaved).
// kneecap shows no purchase link: USES_AI is false, so the plan screen ("Get a plan") never shows, and
// the sign-in button opens only publik's claim page (never the wallet page).
// The in-app browser opens only publik's bare in-app pages (no site menu, footer, prices or plan links):
// the claim page with in_app=1 added (inAppClaimUrl()), DELETE_ACCOUNT_URL, PRIVACY_URL and SUPPORT_URL.
import type { PublikFileName, PublikHost, PublikLaunch } from "@kneecap/native-bridge/publik-host";

export const APP_SLUG = "kneecap";
/** The version in a browser preview. On a phone the module uses the native app version (Info.plist / build.gradle), which is the same. */
export const APP_VERSION = "1.0.5";
/** false: kneecap calls no model (captions and retouch run on the phone). It still signs in and counts users; it skips the plan screen. */
export const USES_AI = false;
/** true: a phone that signed in before opens the app when publik does not answer (kneecap is local-first). The first sign-in needs the network. */
export const OFFLINE_AFTER_SIGN_IN = true;
const ORIGIN = "https://publikhq.com";
export const DEFAULT_BASE_URL = `${ORIGIN}/api/v1`;
/** Settings > Delete account opens this bare publik page in the in-app browser. publik deletes the account there. */
export const DELETE_ACCOUNT_URL = `${ORIGIN}/in-app/delete-account`;
/** Settings > Privacy policy opens this bare publik page in the in-app browser (App Store guideline 5.1.1(i)). */
export const PRIVACY_URL = `${ORIGIN}/in-app/privacy`;
/** Settings > Help and support opens this bare publik page in the in-app browser. */
export const SUPPORT_URL = `${ORIGIN}/in-app/support`;

/**
 * The sign-in page for the in-app browser: the server's claim_url with in_app=1 added. The other query items
 * stay as they are. publik then sends the browser to its bare page /in-app/claim/<code>. null when the
 * claim_url is not a web address.
 */
export function inAppClaimUrl(claimUrl: string | null | undefined): string | null {
  if (!claimUrl) return null;
  let url: URL | null = null;
  try { url = new URL(claimUrl); } catch { /* not a web address */ }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const query = new URLSearchParams(url.search);
  if (query.has("in_app")) { query.set("in_app", "1"); url.search = query.toString(); }
  else url.search = url.search ? `${url.search}&in_app=1` : "?in_app=1";
  return url.toString();
}

export type GateMode = "required" | "optional";
/** The gate mode, put in at build time from PUBLIK_GATE_MODE (vite.config.ts). Anything but "optional" is "required". */
declare const __PUBLIK_GATE_MODE__: string | undefined;
export const GATE_MODE: GateMode = typeof __PUBLIK_GATE_MODE__ === "string" && __PUBLIK_GATE_MODE__ === "optional" ? "optional" : "required";
const POLL_MS = 3_000, POLL_LIMIT_MS = 10 * 60_000;
const LONGEST_TIMEOUT_MS = 2_147_483_647; // the largest delay setTimeout takes (about 24 days)
const NOT_REACHABLE = "publik is not reachable. Check your connection.";
/** An anonymous wallet always has a claim page; without one the app shows this (it never opens another publik page). */
const NO_SIGN_IN_LINK = "publik sent no sign-in link. Try again.";

/** The publik app token (pat_), put in at build time from PUBLIK_APP_TOKEN (vite.config.ts). Public by design. */
declare const __PUBLIK_APP_TOKEN__: string | undefined;
const BUILD_APP_TOKEN = typeof __PUBLIK_APP_TOKEN__ === "string" ? __PUBLIK_APP_TOKEN__.trim() : "";
/** PUBLIK_TEST_HOOKS=1 at build time (vite.config.ts): PUBLIK_API_BASE_URL may name any server (CI live tests). */
declare const __PUBLIK_TEST_HOOKS__: boolean | undefined;
const TEST_HOOKS = typeof __PUBLIK_TEST_HOOKS__ === "boolean" && __PUBLIK_TEST_HOOKS__;
/** A new key after publik's 401, at most this many times in a row; then the gate shows the error with Retry. */
const MAX_NEW_KEYS = 2;
/** Sign out and Delete account wait at most this long for publik to revoke the key. */
const REVOKE_TIMEOUT_MS = 3_000;
const ACTIVE_SESSION_MS = 1_800 * 1000;

export type Choice = "publik" | "own_key";
export interface PublikCredential { key: string; base_url: string; install_id: string; claim_url: string | null; choice?: Choice | null; claimed_at?: string | null }
export interface Wallet {
  claim_state: "anonymous" | "claimed"; claim_url: string | null; account: { handle: string | null } | null;
  plan: { kind: "none" | "plan" | "pack"; label: string | null }; balance_micros: number; top_up_url: string; linked_at: string | null;
}
export type GateAction = "sign_in" | "retry" | "get_plan" | "connect" | "own_key";
export interface GateScreen { id: "sign_in" | "unreachable" | "choose"; title: string; body: string; note: string | null; buttons: { action: GateAction; label: string }[] }
/** show(): draw the screen and resolve with the button pressed. When `signal` aborts, the gate is done with the screen (the promise may stay pending). */
export interface GateUI { show(screen: GateScreen, signal: AbortSignal): Promise<GateAction>; openUrl(url: string): unknown }
/** `offline`: publik did not answer and the phone signed in before (OFFLINE_AFTER_SIGN_IN); `wallet` is null then. */
export interface GateResult { key: string; wallet: Wallet | null; choice: Choice | null; offline: boolean }
/** What Settings shows. `checking`: optional mode is checking a saved sign-in with publik at start. */
export interface PublikStatus { mode: GateMode; checking: boolean; signedIn: boolean; handle: string | null; offline: boolean }
export type SignInResult = "signed_in" | "timeout" | "cancelled";

/** The request did not complete, or publik answered with a server error. */
class Unreachable extends Error {}
/** Sign out or Delete account ran while this step waited for publik: the step stops and writes nothing. */
class SignedOut extends Error {}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Resolves true when `p` resolves, false when it rejects. For writes that may fail without stopping the app. */
const quietly = (p: Promise<unknown>) => p.then(() => true, () => false);
/** `p`, or undefined after `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => { t = setTimeout(resolve, ms, undefined); });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}

/**
 * PUBLIK_API_BASE_URL when this build may use it: a server on this computer or local network (localhost, 127.x,
 * ::1, the Android emulator's 10.0.2.2, *.local), or any http(s) server in a PUBLIK_TEST_HOOKS build. Else null:
 * the module uses https://publikhq.com/api/v1.
 */
export function testBaseUrl(raw: string | undefined): string | null {
  const value = raw?.trim().replace(/\/+$/, "");
  if (!value) return null;
  let hostname: string;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch { return null; }
  const local = hostname === "localhost" || /^127\./.test(hostname) || hostname === "::1" || hostname === "10.0.2.2" || hostname.endsWith(".local");
  return local || TEST_HOOKS ? value : null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const parseJson = (text: string | null): Json | null => { try { return obj(JSON.parse(text ?? "null")); } catch { return null; } };

let host: PublikHost;
let launch: PublikLaunch;
let apiBase: string | null = null;
const wakers = new Set<() => void>();
/** The naps of a wallet poll: the in-app browser's tick (every 3 s while it is open) also ends them. */
const tickWakers = new Set<() => void>();
let foregroundOff: (() => void) | null = null;
let backgroundOff: (() => void) | null = null;
let browserTickOff: (() => void) | null = null;
let inBackground = false;
let mode: GateMode = GATE_MODE;
let session: { handle: string | null; offline: boolean } | null = null;
let checking = false;
/** forget() (Sign out, Delete account) adds 1 before it does anything else. A step that started earlier writes nothing after it. */
let forgets = 0;
const statusListeners = new Set<(s: PublikStatus) => void>();

/** The sign-in state, for Settings. */
export function getStatus(): PublikStatus {
  return { mode, checking, signedIn: session !== null, handle: session?.handle ?? null, offline: session?.offline ?? false };
}
/** Calls `listener` when the state changes. Returns the function that stops it. */
export function onStatus(listener: (s: PublikStatus) => void): () => void {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}
function notify(): void { const s = getStatus(); for (const l of [...statusListeners]) l(s); }

/** Binds the module to the phone. ensureSignedIn() calls it; tests call it with a fake host. */
export async function attachHost(h: PublikHost): Promise<PublikLaunch> {
  foregroundOff?.();
  backgroundOff?.();
  browserTickOff?.();
  host = h;
  launch = await h.launch();
  apiBase = testBaseUrl(launch.settings.PUBLIK_API_BASE_URL);
  inBackground = false;
  foregroundOff = h.onForeground(() => {
    inBackground = false;
    resumeTimer(); // usage counting goes on: the 30-minute timer again, no new app_opened
    for (const wake of [...wakers]) wake();
  });
  backgroundOff = h.onBackground(() => {
    inBackground = true;
    pauseTimer(); // no active_session while the app is in the background
  });
  // While the in-app browser covers the app, the web view's timers can stall: the native tick keeps the
  // wallet poll at one check every 3 s, so the browser closes within seconds of the sign-in.
  browserTickOff = h.onBrowserTick(() => {
    for (const wake of [...tickWakers]) wake();
  });
  return launch;
}

const appVersion = () => (launch.appVersion || APP_VERSION).replace(/^v/i, "");
/** The URL of a publik endpoint: https://publikhq.com/api/v1/..., or PUBLIK_API_BASE_URL/... when that launch setting is there. */
function endpoint(path: "/api/v1/installs" | "/api/v1/installs/revoke" | "/api/v1/wallet" | "/api/v1/telemetry"): string {
  return apiBase ? `${apiBase}${path.slice("/api/v1".length)}` : `${ORIGIN}${path}`;
}

const CREDENTIAL_FILE: PublikFileName = `apps/${APP_SLUG}.json`;
export async function readCredential(): Promise<PublikCredential | null> {
  try {
    const c = parseJson(await host.readFile({ name: CREDENTIAL_FILE }));
    const key = str(c?.key);
    if (!c || !key?.startsWith("pk_")) return null;
    const choice = c.choice === "publik" || c.choice === "own_key" ? c.choice : null;
    return { key, base_url: str(c.base_url) ?? DEFAULT_BASE_URL, install_id: str(c.install_id) ?? "", claim_url: str(c.claim_url), choice, claimed_at: str(c.claimed_at) };
  } catch { return null; }
}
async function writeCredential(c: PublikCredential | null): Promise<void> {
  // The native side writes it with mode 0600, in a folder that is not backed up.
  if (!(await host.writeFile({ name: CREDENTIAL_FILE, text: JSON.stringify(c ?? {}, null, 2) }))) throw new Error("publik could not save this phone's key.");
}
async function removeCredential(): Promise<void> {
  if (!(await host.removeFile({ name: CREDENTIAL_FILE }))) throw new Error("publik could not delete this phone's key.");
}
/**
 * After a wait for publik: is `key` still this phone's saved key, with no Sign out or Delete account since
 * `since` (the value of `forgets` when the step started)? When not, the step writes nothing: no key file,
 * no sign-in time, no session.
 */
async function keyStillSaved(key: string, since: number): Promise<boolean> {
  if (forgets !== since) return false;
  const now = await readCredential();
  return forgets === since && now?.key === key;
}
/** writeCredential(c), only when keyStillSaved(c.key, since). Best effort: resolves false when nothing was written. */
async function writeIfStillSaved(c: PublikCredential, since: number): Promise<boolean> {
  if (!(await keyStillSaved(c.key, since)) || forgets !== since) return false;
  return quietly(writeCredential(c));
}
/** The person's answer to the plan screen. Settings call it to change the answer; null asks again at the next start. */
export async function setChoice(choice: Choice | null): Promise<void> {
  const c = await readCredential();
  if (c) await writeCredential({ ...c, choice });
}

type Answer = { status: number; body: Json; json: boolean };
async function call(method: "GET" | "POST", url: string, opts: { key?: string; body?: Json; timeoutMs: number }): Promise<Answer> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  let res: { status: number; data: unknown };
  try {
    res = await host.request({ method, url, headers, body: opts.body ? JSON.stringify(opts.body) : undefined, timeoutMs: opts.timeoutMs });
  } catch { throw new Unreachable(NOT_REACHABLE); }
  const body = obj(res.data);
  return { status: res.status, body: body ?? {}, json: body !== null };
}
const errorOf = (body: Json) => obj(body.error);
/** An answer that is not publik's: not JSON (a captive portal or a proxy page), 408, 429 or a server error. */
const notPublik = (a: Answer) => !a.json || a.status === 408 || a.status === 429 || a.status >= 500;

/**
 * POST /api/v1/installs: this phone's publik key. Throws a readable message.
 * The install ID is the saved one only when a key is saved with it (readCredential() is null without a key):
 * a phone with no key always asks with a new random UUID. publik's 403 install_revoked (the owner disconnected
 * this install) or a 200 with no key (a replay): ONE more try with a new UUID, then an error.
 * Throws SignedOut when Sign out or Delete account ran while publik answered: nothing is written then.
 */
export async function provision(): Promise<PublikCredential> {
  const token = BUILD_APP_TOKEN;
  if (!token.startsWith("pat_")) throw new Error("This build has no publik app token. Ask the developer for a new build.");
  const since = forgets;
  const prior = await readCredential();
  let installId = prior?.install_id || crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await call("POST", endpoint("/api/v1/installs"), { timeoutMs: 20_000, body: {
      app_token: token, app_slug: APP_SLUG, app_version: appVersion(), os: launch.platform, ...(launch.arch ? { arch: launch.arch } : {}),
      device_name: launch.deviceName.slice(0, 120), install_id: installId, disclosure_version: 1, dialects: ["chat_completions"] } });
    if (notPublik(answer)) throw new Unreachable(NOT_REACHABLE);
    if (forgets !== since) throw new SignedOut("Signed out.");
    const { status, body } = answer;
    const key = str(body.key) ?? (status === 200 ? prior?.key ?? null : null);
    if ((status === 201 || status === 200) && key) {
      const c: PublikCredential = { key, base_url: str(body.base_url) ?? DEFAULT_BASE_URL, install_id: str(body.install_id) ?? installId, claim_url: str(body.claim_url),
        choice: prior?.choice ?? null, claimed_at: prior?.key === key ? prior.claimed_at ?? null : null };
      await writeCredential(c); // the key reaches the file before anything else sees it
      return c;
    }
    if (status === 200 || errorOf(body)?.type === "install_revoked") { installId = crypto.randomUUID(); continue; }
    throw new Error(str(errorOf(body)?.message) ?? `publik could not set up this phone (${status}).`);
  }
  throw new Error("publik could not set up this phone.");
}

/**
 * GET /api/v1/wallet. publik's own JSON 401 or 403 (with publik's error object): the key is gone (`gone`, null
 * wallet); the gate gets a new key. Throws Unreachable when the request does not complete or the answer is not
 * publik's (notPublik(): not JSON, such as a captive portal's 200 page; a 2xx that is not a wallet; a 401 or 403
 * without publik's JSON error).
 */
export async function readWallet(key: string): Promise<{ status: number; gone: boolean; wallet: Wallet | null; message: string | null }> {
  const answer = await call("GET", endpoint("/api/v1/wallet"), { key, timeoutMs: 15_000 });
  const { status, body: b } = answer;
  if (notPublik(answer)) throw new Unreachable(NOT_REACHABLE);
  const ok = status >= 200 && status < 300;
  if (ok && typeof b.claim_state !== "string") throw new Unreachable(NOT_REACHABLE);
  const denied = status === 401 || status === 403;
  if (denied && !errorOf(b)) throw new Unreachable(NOT_REACHABLE);
  if (!ok) return { status, gone: denied, wallet: null, message: str(errorOf(b)?.message) };
  const plan = obj(b.plan), account = obj(b.account), kind = plan?.kind;
  return { status, gone: false, message: null, wallet: {
    claim_state: b.claim_state === "claimed" ? "claimed" : "anonymous", claim_url: str(b.claim_url), account: account ? { handle: str(account.handle) } : null,
    plan: { kind: kind === "plan" || kind === "pack" ? kind : "none", label: str(plan?.label) },
    balance_micros: typeof b.balance_micros === "number" ? b.balance_micros : 0, top_up_url: str(b.top_up_url) ?? `${ORIGIN}/wallet`, linked_at: str(b.linked_at) } };
}

const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
/** The words of the gate. The same in every publik module. */
export function gateScreen(id: GateScreen["id"], w: Wallet | null, note: string | null = null, message?: string): GateScreen {
  if (id === "unreachable") return { id, title: "Sign in with publik", body: message ?? "publik is not reachable. Check your connection.", note, buttons: [{ action: "retry", label: "Retry" }] };
  if (id === "sign_in") return { id, title: "Sign in with publik", note, buttons: [{ action: "sign_in", label: "Sign in with publik" }],
    body: "This app uses your publik account. Tap Sign in with publik, then sign in on the publik page. This screen continues when you are signed in." };
  const who = w?.account?.handle ? `You are signed in as @${w.account.handle}.` : "You are signed in to publik.";
  if (!w || (w.plan.kind === "none" && w.balance_micros === 0)) return { id, title: "Choose how to pay for AI", note,
    body: `${who} This app uses AI. Get a publik plan, or use your own key.`, buttons: [{ action: "get_plan", label: "Get a plan" }, { action: "own_key", label: "Use my own key" }] };
  const what = w.plan.kind === "plan" ? `Your plan: ${w.plan.label ?? "publik"}.` : `Your balance: ${dollars(w.balance_micros)}.`;
  return { id, title: "Connect your plan", note, body: `${who} ${what} Connect it to use AI in this app, or use your own key.`,
    buttons: [{ action: "connect", label: "Connect your plan" }, { action: "own_key", label: "Use my own key" }] };
}

/**
 * Resolves after `ms`, or earlier: when the app comes back to the front, or when `signal` aborts. A poll nap
 * (`poll`) also ends at the in-app browser's tick, so the poll does not stall while the browser covers the app.
 */
function nap(ms: number, signal: AbortSignal, poll = false): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timeout); wakers.delete(done); tickWakers.delete(done); signal.removeEventListener("abort", done); resolve(); };
    const timeout = setTimeout(done, ms);
    wakers.add(done);
    if (poll) tickWakers.add(done);
    signal.addEventListener("abort", done);
  });
}

/**
 * Show a screen. With `until`, also poll GET /wallet every 3 s for at most 10 minutes (wall time: time in the
 * background counts; no back-off), at each in-app browser tick, and at once when the app comes back to the front. "done": the poll saw it; "timeout": it
 * did not. Without `until`, coming back to the front answers "retry", so the gate looks again.
 */
async function ask(ui: GateUI, screen: GateScreen, key?: string, until?: (w: Wallet) => boolean): Promise<GateAction | "done" | "timeout"> {
  const stop = new AbortController();
  const poll = async (): Promise<"done" | "timeout"> => {
    for (const end = Date.now() + POLL_LIMIT_MS; !stop.signal.aborted; ) {
      await nap(POLL_MS, stop.signal, true);
      if (stop.signal.aborted) break;
      const w = await readWallet(key!).then((r) => r.wallet, () => null);
      if (stop.signal.aborted) break;
      if (w && until!(w)) return "done";
      if (Date.now() >= end) return "timeout";
    }
    return "timeout";
  };
  const backInFront = async (): Promise<"retry"> => { await nap(LONGEST_TIMEOUT_MS, stop.signal); return "retry"; };
  try { return await Promise.race([ui.show(screen, stop.signal), until ? poll() : backInFront()]); } finally { stop.abort(); }
}

/** The gate (see the top of the file). Resolves once the person is signed in; `choice` is null when USES_AI is false. */
export async function ensureSignedIn(ui: GateUI, h: PublikHost): Promise<GateResult> {
  await attachHost(h);
  if (launch.settings.PUBLIK_SELF_TEST) {
    await host.finishSelfTest({ line: await selfTest() }); // prints the line and ends the app
    return new Promise<GateResult>(() => {});
  }
  let signNote: string | null = null, signPoll = true, planNote: string | null = null, planPoll = false, newKeys = 0;
  for (;;) {
    // Every read and write of this step is in the try: a failure shows "not reachable" with Retry, never an error page.
    let c: PublikCredential | null = null;
    let r: Awaited<ReturnType<typeof readWallet>> | null = null;
    let failure: unknown;
    let failed = false;
    const since = forgets;
    try {
      c = (await readCredential()) ?? (await provision());
      r = await readWallet(c.key);
      // Sign out or Delete account while publik answered: start again and write nothing. (Only the in-memory
      // count here: a key file that cannot be read back must not start a loop of new keys.)
      if (forgets !== since) continue;
      if (r.gone) await removeCredential(); // publik says this key is gone (revoked): a new one next
    } catch (e) {
      if (e instanceof SignedOut) continue;
      failed = true;
      failure = e;
    }
    if (failed || !c || !r) {
      // kneecap is local-first: a phone that signed in before opens without publik (OFFLINE_AFTER_SIGN_IN).
      if (OFFLINE_AFTER_SIGN_IN && failure instanceof Unreachable && c?.claimed_at && forgets === since) return pass(c, null, true);
      await ask(ui, gateScreen("unreachable", null, null, failure instanceof Unreachable ? undefined : messageOf(failure)));
      continue;
    }
    if (r.gone) {
      if (++newKeys <= MAX_NEW_KEYS) continue;
      newKeys = 0; // publik refuses the new keys too: stop here, the person can retry
      await ask(ui, gateScreen("unreachable", null, null, r.message ?? "publik did not accept this phone's key."));
      continue;
    }
    newKeys = 0;
    const w = r.wallet;
    if (!w) { await ask(ui, gateScreen("unreachable", null, null, r.message ?? undefined)); continue; }
    if (w.claim_state !== "claimed") {
      // Signed out on publik: the offline pass ends too (best effort: a failed write does not stop the gate).
      if (c.claimed_at) { c = { ...c, claimed_at: null }; await writeIfStillSaved(c, since); }
      const a = await ask(ui, gateScreen("sign_in", w, signNote), c.key, signPoll ? (x) => x.claim_state === "claimed" : undefined);
      if (a === "sign_in") {
        // Only publik's bare in-app claim page opens here: never the wallet page, which sells plans.
        const claimUrl = inAppClaimUrl(w.claim_url) ?? inAppClaimUrl(c.claim_url);
        if (!claimUrl) { await ask(ui, gateScreen("unreachable", null, null, NO_SIGN_IN_LINK)); continue; }
        ui.openUrl(claimUrl); signNote = "Waiting for you to sign in on the publik page."; signPoll = true;
      }
      if (a === "timeout") { signNote = "No sign-in after 10 minutes. Tap Sign in with publik to try again."; signPoll = false; }
      continue;
    }
    if (!c.claimed_at) { c = { ...c, claimed_at: new Date().toISOString() }; await writeIfStillSaved(c, since); }
    if (forgets !== since) continue; // signed out during the write: the gate starts again
    let choice: Choice | null = USES_AI ? c.choice ?? null : null;
    if (USES_AI && !choice) {
      if (w.plan.kind !== "none" || w.balance_micros > 0) { planNote = null; planPoll = false; } // the plan is there: Connect your plan
      const a = await ask(ui, gateScreen("choose", w, planNote), c.key, planPoll ? (x) => x.plan.kind !== "none" || x.balance_micros > 0 : undefined);
      planNote = null; planPoll = false;
      if (a === "get_plan") { ui.openUrl(w.top_up_url); planNote = "Waiting for your plan. Finish on the publik page."; planPoll = true; }
      if (a === "timeout") planNote = "No plan after 10 minutes. Tap Get a plan to try again.";
      if (a !== "connect" && a !== "own_key") continue; // "done": the plan is there; the next screen is Connect your plan
      choice = a === "connect" ? "publik" : "own_key";
      await quietly(setChoice(choice));
    }
    return pass({ ...c, choice }, w, false);
  }
}

function pass(c: PublikCredential, wallet: Wallet | null, offline: boolean): GateResult {
  void host.closeBrowser().catch(() => undefined); // the sign-in page, if it is still open over the app
  session = { handle: wallet?.account?.handle ?? null, offline };
  notify();
  startTelemetry();
  return { key: c.key, wallet, choice: USES_AI ? c.choice ?? null : null, offline };
}

/**
 * App start, in the mode of this build (`gateMode` is for tests). Both modes answer PUBLIK_SELF_TEST first.
 * "required": the gate, ensureSignedIn(); resolves once the person is signed in.
 * "optional": resolves at once, with no screen. A phone with a saved key is checked with publik in the
 * background (resumeSession); a phone that never signed in sends nothing.
 */
export async function startPublik(ui: GateUI, h: PublikHost, gateMode: GateMode = GATE_MODE): Promise<void> {
  mode = gateMode;
  if (gateMode === "required") {
    await ensureSignedIn(ui, h);
    return;
  }
  await attachHost(h);
  if (launch.settings.PUBLIK_SELF_TEST) {
    await host.finishSelfTest({ line: await selfTest() }); // prints the line and ends the app
    return new Promise<void>(() => {});
  }
  notify();
  void resumeSession();
}

/**
 * Optional mode, at start: is the saved key still signed in? Shows no screen; never throws.
 * Settings stays usable meanwhile: when Sign out or Delete account runs while publik answers, the key is
 * gone after the wait (keyStillSaved), and this check writes nothing and starts no session.
 */
async function resumeSession(): Promise<void> {
  const since = forgets;
  const c = await readCredential().catch(() => null);
  if (!c) return; // this phone never started a sign-in: nothing is sent
  checking = true;
  notify();
  try {
    let r: Awaited<ReturnType<typeof readWallet>>;
    try {
      r = await readWallet(c.key);
    } catch (e) {
      // kneecap is local-first: a phone that signed in before keeps its sign-in when publik does not answer.
      if (OFFLINE_AFTER_SIGN_IN && e instanceof Unreachable && c.claimed_at && (await keyStillSaved(c.key, since))) pass(c, null, true);
      return;
    }
    if (!(await keyStillSaved(c.key, since))) return; // signed out while publik answered: write nothing
    if (r.gone) return await removeCredential(); // the key was revoked: signed out
    if (r.wallet?.claim_state === "claimed") { await signedIn(c, r.wallet, since); return; }
    if (r.wallet && c.claimed_at) await writeIfStillSaved({ ...c, claimed_at: null }, since); // signed out on publik
  } catch {
    // A file could not be read or written: the phone stays signed out.
  } finally {
    checking = false;
    notify();
  }
}

/** The wallet says "claimed": saves the sign-in time (best effort) and starts the session, unless the key is gone since `since`. */
async function signedIn(c: PublikCredential, w: Wallet, since: number): Promise<"signed_in" | "cancelled"> {
  if (!(await keyStillSaved(c.key, since))) return "cancelled"; // Sign out or Delete account ran meanwhile
  const signed = c.claimed_at ? c : { ...c, claimed_at: new Date().toISOString() };
  if (!c.claimed_at) await quietly(writeCredential(signed)); // best effort: only the offline pass needs it
  if (forgets !== since) return "cancelled";
  pass(signed, w, false);
  return "signed_in";
}

/**
 * Settings > "Sign in with publik" (optional mode). Gets this phone's key when it has none (POST /installs),
 * opens the sign-in page in the in-app browser, then checks GET /wallet every 3 s for up to 10 minutes, and at
 * once when the app comes back to the front. "signed_in": usage counting starts now. "cancelled": `signal`
 * aborted, or Sign out or Delete account ran meanwhile (then nothing is written). Throws a readable message
 * when publik cannot set up the phone or does not answer.
 */
export async function signIn(opts: { signal: AbortSignal; onWaiting?: () => void }): Promise<SignInResult> {
  const { signal } = opts;
  const since = forgets;
  try {
    for (let attempt = 0; ; attempt++) {
      const c = (await readCredential()) ?? (await provision());
      if (signal.aborted) return "cancelled";
      const r = await readWallet(c.key);
      if (!(await keyStillSaved(c.key, since))) return "cancelled"; // signed out while publik answered: write nothing
      if (r.gone && attempt === 0) { await removeCredential(); continue; } // a revoked key: get a new one
      if (!r.wallet) throw new Error(r.message ?? `publik answered ${r.status}.`);
      if (r.wallet.claim_state === "claimed") return await signedIn(c, r.wallet, since);
      if (signal.aborted) return "cancelled";
      // Only publik's bare in-app claim page opens here: never the wallet page, which sells plans.
      const claimUrl = inAppClaimUrl(r.wallet.claim_url) ?? inAppClaimUrl(c.claim_url);
      if (!claimUrl) throw new Error(NO_SIGN_IN_LINK);
      await host.openUrl({ url: claimUrl });
      opts.onWaiting?.();
      for (const end = Date.now() + POLL_LIMIT_MS; ; ) {
        await nap(POLL_MS, signal, true);
        if (signal.aborted) return "cancelled";
        const w = await readWallet(c.key).then((x) => x.wallet, () => null);
        if (signal.aborted) return "cancelled";
        if (w?.claim_state === "claimed") return await signedIn(c, w, since);
        if (Date.now() >= end) return "timeout";
      }
    }
  } catch (e) {
    if (e instanceof SignedOut) return "cancelled";
    throw e;
  }
}

/**
 * Sign out and Delete account. The key stays in memory; its file goes first (a phone that stops now is signed
 * out), usage counting stops, and then publik revokes the key (POST /api/v1/installs/revoke; best effort, at most
 * REVOKE_TIMEOUT_MS). Throws when a file could not be deleted.
 */
async function forget(names: PublikFileName[]): Promise<void> {
  forgets++; // first, before any wait: a wallet check that is waiting for publik now writes nothing
  const c = await readCredential();
  const kept: PublikFileName[] = [];
  for (const name of names) if (!(await host.removeFile({ name }).catch(() => false))) kept.push(name);
  stopTelemetry();
  session = null;
  notify();
  if (c) await within(call("POST", endpoint("/api/v1/installs/revoke"), { key: c.key, timeoutMs: REVOKE_TIMEOUT_MS }).catch(() => undefined), REVOKE_TIMEOUT_MS + 500);
  if (kept.length) throw new Error("publik kneecap could not delete its publik data on this phone. Try again.");
}

/**
 * Settings > "Sign out": forget() for this phone's key. The next sign-in gets a new key.
 * With PUBLIK_GATE_MODE=required the caller then starts the app again, so the gate shows.
 */
export async function signOut(): Promise<void> {
  await forget([CREDENTIAL_FILE]);
}

/**
 * Settings > "Delete account", the part on the phone: forget() for the key and the install ID (telemetry.json).
 * The usage opt-out (consent.json) stays: it is the person's choice, not data about them.
 * Then the caller opens DELETE_ACCOUNT_URL in the in-app browser, where publik deletes the account.
 */
export async function deletePublikData(): Promise<void> {
  installIdOnce = null;
  await forget([CREDENTIAL_FILE, "telemetry.json"]);
}

/** Builder check, run by the BUILT app: PUBLIK_SELF_TEST=1 makes ensureSignedIn() print this line and end the app. */
export async function selfTest(): Promise<string> {
  try {
    const r = await readWallet((await provision()).key);
    if (!r.wallet) throw new Error(r.message ?? `GET /wallet answered ${r.status}`);
    return `publik self-test: ok ${APP_SLUG} ${appVersion()}`;
  } catch (e) {
    return `publik self-test: failed: ${e instanceof Unreachable ? NOT_REACHABLE : e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------- usage counting: /skills/telemetry.md sections 3-5 ----------
let timer: ReturnType<typeof setInterval> | null = null, installIdOnce: string | null = null;
/** Usage counting is on for this session (startTelemetry() until stopTelemetry()); the timer runs only in front. */
let counting = false;

/** DO_NOT_TRACK or PUBLIK_TELEMETRY=0 at launch: usage counting is off, and the Settings switch cannot turn it on. */
function launchOptOut(): boolean {
  const dnt = (launch.settings.DO_NOT_TRACK ?? "").trim().toLowerCase();
  if (dnt !== "" && dnt !== "0" && dnt !== "false") return true;
  return ["0", "false", "off"].includes((launch.settings.PUBLIK_TELEMETRY ?? "").trim().toLowerCase());
}
async function usageOff(): Promise<boolean> {
  if (launchOptOut()) return true;
  return parseJson(await host.readFile({ name: "consent.json" }).catch(() => null))?.usage === false;
}
/** The Settings switch for usage counting. `locked`: a launch setting turns it off. */
export async function usageCounting(): Promise<{ on: boolean; locked: boolean }> {
  return { on: !(await usageOff()), locked: launchOptOut() };
}
/** The Settings switch: saves the choice in consent.json ("usage": true or false) and stops or starts counting at once. */
export async function setUsageCounting(on: boolean): Promise<void> {
  if (!(await host.writeFile({ name: "consent.json", text: `${JSON.stringify({ usage: on })}\n` }))) throw new Error("publik kneecap could not save this setting.");
  if (!on) stopTelemetry();
  else if (session) startTelemetry({ opened: false });
}
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** One random UUID for this app on this phone, in <publik folder>/telemetry.json (mode 0600). */
async function telemetryInstallId(): Promise<string> {
  const saved = async () => {
    const id = str(parseJson(await host.readFile({ name: "telemetry.json" }).catch(() => null))?.install_id)?.toLowerCase() ?? "";
    return UUID_V4.test(id) ? id : null;
  };
  if ((installIdOnce ??= await saved())) return installIdOnce;
  const fresh = crypto.randomUUID(); // if the file cannot be saved, this ID lasts for this run only
  const text = JSON.stringify({ install_id: fresh, created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z") }) + "\n";
  if (await host.writeFile({ name: "telemetry.json", text, exclusive: true }).catch(() => false)) return (installIdOnce = fresh);
  return (installIdOnce = (await saved()) ?? fresh); // an earlier run saved its ID first
}
async function sendEvent(event: "app_opened" | "active_session"): Promise<void> {
  const say = (result: unknown) => { if (launch.settings.PUBLIK_TELEMETRY_DEBUG === "1") console.warn(`publik-telemetry: ${event} -> ${String(result)}`); };
  try {
    if (launch.platform === "web") return; // the browser preview is not an installed app
    if (await usageOff()) return say("off (opt-out)");
    const key = (await readCredential())?.key;
    // os is "ios" or "android". publik's telemetry v1 counts macos, windows and linux, and answers 400 for a
    // phone until it counts phones too. The app ignores every answer.
    const body = { v: 1, app: APP_SLUG, install_id: await telemetryInstallId(), event, app_version: appVersion(), os: launch.platform,
      ...(launch.arch ? { arch: launch.arch } : {}) };
    const res = await host.request({ method: "POST", url: endpoint("/api/v1/telemetry"), timeoutMs: 5_000, body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...(key?.startsWith("pk_") ? { Authorization: `Bearer ${key}` } : {}) } });
    say(res.status);
  } catch (e) { say(e instanceof Error ? e.name : "error"); }
}
/** Called at a sign-in (pass()). app_opened now, active_session every 30 minutes while the app is in front;
 *  never fails the app, never blocks. `opened: false` (the Settings switch turned on again): only the timer. */
export function startTelemetry(opts: { opened?: boolean } = {}): void {
  if (counting) return;
  counting = true;
  resumeTimer();
  if (opts.opened !== false) void sendEvent("app_opened");
}
/** Sign out, Delete account, or the Settings switch turned off. */
export function stopTelemetry(): void {
  counting = false;
  pauseTimer();
}
function resumeTimer(): void {
  if (!timer && counting && !inBackground) timer = setInterval(() => void sendEvent("active_session"), ACTIVE_SESSION_MS);
}
function pauseTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
/** Tests only: is the active_session timer running? */
export function _telemetryTimerRunning(): boolean {
  return timer !== null;
}
/** Tests only: stops the timer and forgets the module's state. */
export function _resetForTests(): void {
  stopTelemetry();
  installIdOnce = null; wakers.clear(); tickWakers.clear(); foregroundOff?.(); foregroundOff = null; backgroundOff?.(); backgroundOff = null;
  browserTickOff?.(); browserTickOff = null; inBackground = false;
  mode = GATE_MODE; session = null; checking = false; statusListeners.clear();
}
