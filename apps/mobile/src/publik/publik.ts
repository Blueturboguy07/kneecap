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
//      button opens claim_url in the in-app browser; the app checks every 3 s for up to 10 minutes
//      while it is in front, and checks again at once when it comes back to the front;
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
// https://publikhq.com/api/v1 for every call below.
import type { PublikFileName, PublikHost, PublikLaunch } from "@kneecap/native-bridge/publik-host";

export const APP_SLUG = "kneecap";
/** The version in a browser preview. On a phone the module uses the native app version (Info.plist / build.gradle), which is the same. */
export const APP_VERSION = "1.0.1";
/** false: kneecap calls no model (captions and retouch run on the phone). It still signs in and counts users; it skips the plan screen. */
export const USES_AI = false;
/** true: a phone that signed in before opens the app when publik does not answer (kneecap is local-first). The first sign-in needs the network. */
export const OFFLINE_AFTER_SIGN_IN = true;
const ORIGIN = "https://publikhq.com";
export const DEFAULT_BASE_URL = `${ORIGIN}/api/v1`;
/** Settings > Delete account opens this publik page in the in-app browser. publik deletes the account there. */
export const DELETE_ACCOUNT_URL = `${ORIGIN}/settings/profile#delete-account-title`;

export type GateMode = "required" | "optional";
/** The gate mode, put in at build time from PUBLIK_GATE_MODE (vite.config.ts). Anything but "optional" is "required". */
declare const __PUBLIK_GATE_MODE__: string | undefined;
export const GATE_MODE: GateMode = typeof __PUBLIK_GATE_MODE__ === "string" && __PUBLIK_GATE_MODE__ === "optional" ? "optional" : "required";
const POLL_MS = 3_000, POLL_LIMIT_MS = 10 * 60_000;
const LONGEST_TIMEOUT_MS = 2_147_483_647; // the largest delay setTimeout takes (about 24 days)
const NOT_REACHABLE = "publik is not reachable. Check your connection.";

/** The publik app token (pat_), put in at build time from PUBLIK_APP_TOKEN (vite.config.ts). Public by design. */
declare const __PUBLIK_APP_TOKEN__: string | undefined;
const BUILD_APP_TOKEN = typeof __PUBLIK_APP_TOKEN__ === "string" ? __PUBLIK_APP_TOKEN__.trim() : "";

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

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const parseJson = (text: string | null): Json | null => { try { return obj(JSON.parse(text ?? "null")); } catch { return null; } };

let host: PublikHost;
let launch: PublikLaunch;
let apiBase: string | null = null;
const wakers = new Set<() => void>();
let foregroundOff: (() => void) | null = null;
let mode: GateMode = GATE_MODE;
let session: { handle: string | null; offline: boolean } | null = null;
let checking = false;
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
  host = h;
  launch = await h.launch();
  apiBase = launch.settings.PUBLIK_API_BASE_URL?.trim().replace(/\/+$/, "") || null;
  foregroundOff = h.onForeground(() => { for (const wake of [...wakers]) wake(); });
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
/** The person's answer to the plan screen. Settings call it to change the answer; null asks again at the next start. */
export async function setChoice(choice: Choice | null): Promise<void> {
  const c = await readCredential();
  if (c) await writeCredential({ ...c, choice });
}

async function call(method: "GET" | "POST", url: string, opts: { key?: string; body?: Json; timeoutMs: number }): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  try {
    const res = await host.request({ method, url, headers, body: opts.body ? JSON.stringify(opts.body) : undefined, timeoutMs: opts.timeoutMs });
    return { status: res.status, body: obj(res.data) ?? {} };
  } catch { throw new Unreachable(NOT_REACHABLE); }
}
const errorOf = (body: Json) => obj(body.error);

/** POST /api/v1/installs: this phone's publik key. Throws a readable message. */
export async function provision(): Promise<PublikCredential> {
  const token = BUILD_APP_TOKEN;
  if (!token.startsWith("pat_")) throw new Error("This build has no publik app token. Ask the developer for a new build.");
  const prior = await readCredential();
  let installId = prior?.install_id || crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const { status, body } = await call("POST", endpoint("/api/v1/installs"), { timeoutMs: 20_000, body: {
      app_token: token, app_slug: APP_SLUG, app_version: appVersion(), os: launch.platform, ...(launch.arch ? { arch: launch.arch } : {}),
      device_name: launch.deviceName.slice(0, 120), install_id: installId, disclosure_version: 1, dialects: ["chat_completions"] } });
    const key = str(body.key) ?? (status === 200 ? prior?.key ?? null : null);
    if ((status === 201 || status === 200) && key) {
      const c: PublikCredential = { key, base_url: str(body.base_url) ?? DEFAULT_BASE_URL, install_id: str(body.install_id) ?? installId, claim_url: str(body.claim_url),
        choice: prior?.choice ?? null, claimed_at: prior?.key === key ? prior.claimed_at ?? null : null };
      await writeCredential(c); // the key reaches the file before anything else sees it
      return c;
    }
    if (status >= 500) throw new Unreachable(NOT_REACHABLE);
    if (status === 200 || errorOf(body)?.type === "install_revoked") { installId = crypto.randomUUID(); continue; }
    throw new Error(str(errorOf(body)?.message) ?? `publik could not set up this phone (${status}).`);
  }
  throw new Error("publik could not set up this phone.");
}

/** GET /api/v1/wallet. 401: the key is gone (null wallet). Throws Unreachable when the request does not complete. */
export async function readWallet(key: string): Promise<{ status: number; wallet: Wallet | null; message: string | null }> {
  const { status, body: b } = await call("GET", endpoint("/api/v1/wallet"), { key, timeoutMs: 15_000 });
  if (status < 200 || status >= 300 || typeof b.claim_state !== "string") return { status, wallet: null, message: str(errorOf(b)?.message) };
  const plan = obj(b.plan), account = obj(b.account), kind = plan?.kind;
  return { status, message: null, wallet: {
    claim_state: b.claim_state === "claimed" ? "claimed" : "anonymous", claim_url: str(b.claim_url), account: account ? { handle: str(account.handle) } : null,
    plan: { kind: kind === "plan" || kind === "pack" ? kind : "none", label: str(plan?.label) },
    balance_micros: typeof b.balance_micros === "number" ? b.balance_micros : 0, top_up_url: str(b.top_up_url) ?? `${ORIGIN}/wallet`, linked_at: str(b.linked_at) } };
}

const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
/** The words of the gate. The same in every publik module. */
export function gateScreen(id: GateScreen["id"], w: Wallet | null, note: string | null = null, message?: string): GateScreen {
  if (id === "unreachable") return { id, title: "Sign in with publik", body: message ?? "publik is not reachable. Check your connection.", note, buttons: [{ action: "retry", label: "Retry" }] };
  if (id === "sign_in") return { id, title: "Sign in with publik", note, buttons: [{ action: "sign_in", label: "Sign in with publik" }],
    body: "This app uses your publik account. Click Sign in with publik, then sign in in your browser. This window continues when you are signed in." };
  const who = w?.account?.handle ? `You are signed in as @${w.account.handle}.` : "You are signed in to publik.";
  if (!w || (w.plan.kind === "none" && w.balance_micros === 0)) return { id, title: "Choose how to pay for AI", note,
    body: `${who} This app uses AI. Get a publik plan, or use your own key.`, buttons: [{ action: "get_plan", label: "Get a plan" }, { action: "own_key", label: "Use my own key" }] };
  const what = w.plan.kind === "plan" ? `Your plan: ${w.plan.label ?? "publik"}.` : `Your balance: ${dollars(w.balance_micros)}.`;
  return { id, title: "Connect your plan", note, body: `${who} ${what} Connect it to use AI in this app, or use your own key.`,
    buttons: [{ action: "connect", label: "Connect your plan" }, { action: "own_key", label: "Use my own key" }] };
}

/** Resolves after `ms`, or earlier: when the app comes back to the front, or when `signal` aborts. */
function nap(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timeout); wakers.delete(done); signal.removeEventListener("abort", done); resolve(); };
    const timeout = setTimeout(done, ms);
    wakers.add(done);
    signal.addEventListener("abort", done);
  });
}

/**
 * Show a screen. With `until`, also poll GET /wallet every 3 s for at most 10 minutes (wall time: time in the
 * background counts), and at once when the app comes back to the front. "done": the poll saw it; "timeout": it
 * did not. Without `until`, coming back to the front answers "retry", so the gate looks again.
 */
async function ask(ui: GateUI, screen: GateScreen, key?: string, until?: (w: Wallet) => boolean): Promise<GateAction | "done" | "timeout"> {
  const stop = new AbortController();
  const poll = async (): Promise<"done" | "timeout"> => {
    for (const end = Date.now() + POLL_LIMIT_MS; !stop.signal.aborted; ) {
      await nap(POLL_MS, stop.signal);
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
  let signNote: string | null = null, signPoll = true, planNote: string | null = null, planPoll = false;
  for (;;) {
    let c: PublikCredential | null = null;
    let r: Awaited<ReturnType<typeof readWallet>>;
    try {
      c = (await readCredential()) ?? (await provision());
      r = await readWallet(c.key);
      if (r.status >= 500) throw new Unreachable(NOT_REACHABLE);
    } catch (e) {
      // kneecap is local-first: a phone that signed in before opens without publik (OFFLINE_AFTER_SIGN_IN).
      if (OFFLINE_AFTER_SIGN_IN && e instanceof Unreachable && c?.claimed_at) return pass(c, null, true);
      await ask(ui, gateScreen("unreachable", null, null, e instanceof Unreachable ? undefined : e instanceof Error ? e.message : String(e)));
      continue;
    }
    if (r.status === 401) { await writeCredential(null); continue; } // a revoked key: provision again
    const w = r.wallet;
    if (!w) { await ask(ui, gateScreen("unreachable", null, null, r.message ?? undefined)); continue; }
    if (w.claim_state !== "claimed") {
      if (c.claimed_at) await writeCredential({ ...c, claimed_at: null }); // signed out on publik: the offline pass ends too
      const a = await ask(ui, gateScreen("sign_in", w, signNote), c.key, signPoll ? (x) => x.claim_state === "claimed" : undefined);
      if (a === "sign_in") { ui.openUrl(w.claim_url ?? c.claim_url ?? `${ORIGIN}/wallet`); signNote = "Waiting for you to sign in in your browser."; signPoll = true; }
      if (a === "timeout") { signNote = "No sign-in after 10 minutes. Click Sign in with publik to try again."; signPoll = false; }
      continue;
    }
    if (!c.claimed_at) await writeCredential((c = { ...c, claimed_at: new Date().toISOString() }));
    let choice: Choice | null = USES_AI ? c.choice ?? null : null;
    if (USES_AI && !choice) {
      if (w.plan.kind !== "none" || w.balance_micros > 0) { planNote = null; planPoll = false; } // the plan is there: Connect your plan
      const a = await ask(ui, gateScreen("choose", w, planNote), c.key, planPoll ? (x) => x.plan.kind !== "none" || x.balance_micros > 0 : undefined);
      planNote = null; planPoll = false;
      if (a === "get_plan") { ui.openUrl(w.top_up_url); planNote = "Waiting for your plan. Finish in your browser."; planPoll = true; }
      if (a === "timeout") planNote = "No plan after 10 minutes. Click Get a plan to try again.";
      if (a !== "connect" && a !== "own_key") continue; // "done": the plan is there; the next screen is Connect your plan
      choice = a === "connect" ? "publik" : "own_key";
      await setChoice(choice);
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

/** Optional mode, at start: is the saved key still signed in? Shows no screen; never throws. */
async function resumeSession(): Promise<void> {
  const c = await readCredential().catch(() => null);
  if (!c) return; // this phone never started a sign-in: nothing is sent
  checking = true;
  notify();
  try {
    let r: Awaited<ReturnType<typeof readWallet>>;
    try {
      r = await readWallet(c.key);
      if (r.status >= 500) throw new Unreachable(NOT_REACHABLE);
    } catch (e) {
      // kneecap is local-first: a phone that signed in before keeps its sign-in when publik does not answer.
      if (OFFLINE_AFTER_SIGN_IN && e instanceof Unreachable && c.claimed_at) pass(c, null, true);
      return;
    }
    if (r.status === 401) return await removeCredential(); // the key was revoked: signed out
    if (r.wallet?.claim_state === "claimed") { await signedIn(c, r.wallet); return; }
    if (r.wallet && c.claimed_at) await writeCredential({ ...c, claimed_at: null }); // signed out on publik
  } catch {
    // A file could not be read or written: the phone stays signed out.
  } finally {
    checking = false;
    notify();
  }
}

async function signedIn(c: PublikCredential, w: Wallet): Promise<"signed_in"> {
  const signed = c.claimed_at ? c : { ...c, claimed_at: new Date().toISOString() };
  if (!c.claimed_at) await writeCredential(signed);
  pass(signed, w, false);
  return "signed_in";
}

/**
 * Settings > "Sign in with publik" (optional mode). Gets this phone's key when it has none (POST /installs),
 * opens the sign-in page in the in-app browser, then checks GET /wallet every 3 s for up to 10 minutes, and at
 * once when the app comes back to the front. "signed_in": usage counting starts now. "cancelled": `signal`
 * aborted. Throws a readable message when publik cannot set up the phone or does not answer.
 */
export async function signIn(opts: { signal: AbortSignal; onWaiting?: () => void }): Promise<SignInResult> {
  const { signal } = opts;
  for (let attempt = 0; ; attempt++) {
    const c = (await readCredential()) ?? (await provision());
    if (signal.aborted) return "cancelled";
    const r = await readWallet(c.key);
    if (r.status === 401 && attempt === 0) { await removeCredential(); continue; } // a revoked key: get a new one
    if (r.status >= 500) throw new Unreachable(NOT_REACHABLE);
    if (!r.wallet) throw new Error(r.message ?? `publik answered ${r.status}.`);
    if (r.wallet.claim_state === "claimed") return signedIn(c, r.wallet);
    if (signal.aborted) return "cancelled";
    await host.openUrl({ url: r.wallet.claim_url ?? c.claim_url ?? `${ORIGIN}/wallet` });
    opts.onWaiting?.();
    for (const end = Date.now() + POLL_LIMIT_MS; ; ) {
      await nap(POLL_MS, signal);
      if (signal.aborted) return "cancelled";
      const w = await readWallet(c.key).then((x) => x.wallet, () => null);
      if (signal.aborted) return "cancelled";
      if (w?.claim_state === "claimed") return signedIn(c, w);
      if (Date.now() >= end) return "timeout";
    }
  }
}

/**
 * Settings > "Sign out": stops usage counting, revokes this phone's key on publik (POST /api/v1/installs/revoke;
 * skipped when publik does not answer) and deletes the key from the phone. The next sign-in gets a new key.
 * With PUBLIK_GATE_MODE=required the caller then starts the app again, so the gate shows.
 */
export async function signOut(): Promise<void> {
  stopTelemetry();
  const c = await readCredential();
  session = null;
  notify();
  if (c) await call("POST", endpoint("/api/v1/installs/revoke"), { key: c.key, timeoutMs: 10_000 }).catch(() => undefined);
  await removeCredential();
}

/**
 * Settings > "Delete account", the part on the phone: signOut(), then the install ID (telemetry.json) goes too.
 * The usage opt-out (consent.json) stays: it is the person's choice, not data about them.
 * Then the caller opens DELETE_ACCOUNT_URL in the in-app browser, where publik deletes the account.
 */
export async function deletePublikData(): Promise<void> {
  await signOut();
  installIdOnce = null;
  if (!(await host.removeFile({ name: "telemetry.json" }))) throw new Error("publik could not delete this phone's install ID.");
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
  if (!(await host.writeFile({ name: "consent.json", text: `${JSON.stringify({ usage: on })}\n` }))) throw new Error("kneecap could not save this setting.");
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
/** Called at a sign-in (pass()). app_opened now, active_session every 30 minutes; never fails the app, never blocks.
 *  `opened: false` (the Settings switch turned on again): only the 30-minute timer. */
export function startTelemetry(opts: { opened?: boolean } = {}): void {
  if (timer) return;
  timer = setInterval(() => void sendEvent("active_session"), 1_800 * 1000);
  if (opts.opened !== false) void sendEvent("app_opened");
}
/** Sign out, Delete account, or the Settings switch turned off. */
export function stopTelemetry(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
/** Tests only: stops the timer and forgets the module's state. */
export function _resetForTests(): void {
  stopTelemetry();
  installIdOnce = null; wakers.clear(); foregroundOff?.(); foregroundOff = null;
  mode = GATE_MODE; session = null; checking = false; statusListeners.clear();
}
