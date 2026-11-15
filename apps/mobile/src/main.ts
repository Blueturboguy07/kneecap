/**
 * kneecap mobile entry: Sign in with publik (./publik/), the native first-run
 * screen, then a deliberately thin hash router:
 *
 *   (default)        -> ./app/app-root.tsx  — the real product: project
 *                       list + the editor (`EditorShell`).
 *   #/diagnostics    -> ./legacy-harness.ts — the M3/M4 NativeBridge shell
 *                       harness, kept reachable for QA (see its header).
 *   #/autotest       -> ./autotest.tsx — end-to-end playback QA.
 *
 * The two hidden routes are developer tools: they exist only in a build with
 * KNEECAP_DEBUG_TOOLS=1 (vite.config.ts). In any other build
 * `__KNEECAP_DEBUG_TOOLS__` is the constant `false`, so the bundler drops the
 * routes and their modules (App Store guideline 2.5.19: no hidden features).
 *
 * Both are dynamic imports so the diagnostics path stays out of the
 * editor's startup graph and vice versa. A hash flip between modes does a
 * full reload rather than trying to unmount one world and boot the other —
 * this is a hidden debug switch, not user-facing navigation.
 */
declare const __KNEECAP_DEBUG_TOOLS__: boolean;
/** "publik-gate-mode:required" or "publik-gate-mode:optional" (vite.config.ts). CI reads it in the built bundle
 *  (scripts/check-web-bundle.sh) to prove which gate mode a build has. */
declare const __PUBLIK_GATE_MARKER__: string;
/** "publik-build:store", "publik-build:test-hooks" or "publik-build:plain" (vite.config.ts, APP_STORE_BUILD and
 *  PUBLIK_TEST_HOOKS). The iOS build phase and the Android release check refuse a store build without "store". */
declare const __PUBLIK_BUILD_MARKER__: string;
/** The editor waits at most this long for the native first-run screen; the screen covers the app anyway. */
const FIRST_RUN_WAIT_MS = 1_500;

const DIAGNOSTICS_HASH = "#/diagnostics";
const AUTOTEST_HASH = "#/autotest";

/**
 * Headless trigger for the `#/autotest` route: a Capacitor app launch has
 * no way to carry a URL hash (`simctl launch` starts the app; the WebView
 * always loads bare index.html), so an automated runner instead plants
 * `<mediaRoot>/autotest.flag` in the app container and relaunches. The
 * check is a single local scheme-handler fetch (missing file -> the task
 * fails -> fetch throws -> false), a few ms on device and skipped
 * entirely on the web dev server.
 */
async function autotestFlagPresent(): Promise<boolean> {
	try {
		const { Capacitor } = await import("@capacitor/core");
		if (!Capacitor.isNativePlatform()) return false;
		const { getNativeBridge } = await import("@kneecap/native-bridge");
		const bridge = await getNativeBridge();
		const root = await bridge.getMediaRoot();
		if (!root) return false;
		const res = await fetch(bridge.toPlaybackUri(`file://${root}/autotest.flag`));
		return res.ok || res.status === 0;
	} catch {
		return false;
	}
}

async function boot() {
	// Sign in with publik (src/publik/): with PUBLIK_GATE_MODE=required the
	// gate is the first screen of the app, before the first-run screen and
	// before the hidden routes below. A phone that is signed in passes at
	// once; PUBLIK_SELF_TEST=1 prints the self-test line and ends the app.
	// With PUBLIK_GATE_MODE=optional there is no screen here: sign-in is a
	// row in Settings.
	const { runPublik, showFirstRun } = await import("./publik/gate-ui");
	await runPublik();
	// The native first-run screen (FirstRunView.swift / FirstRunActivity.java),
	// once per install, AFTER the gate. It covers the app, so the editor may
	// mount under it: the wait has a limit.
	await Promise.race([showFirstRun(), new Promise<void>((resolve) => setTimeout(resolve, FIRST_RUN_WAIT_MS))]);

	if (__KNEECAP_DEBUG_TOOLS__ && window.location.hash.startsWith(DIAGNOSTICS_HASH)) {
		const { mountLegacyHarness } = await import("./legacy-harness");
		await mountLegacyHarness();
	} else if (
		__KNEECAP_DEBUG_TOOLS__ &&
		(window.location.hash.startsWith(AUTOTEST_HASH) || (await autotestFlagPresent()))
	) {
		// End-to-end playback QA (import → persist → reopen → frames) — see
		// autotest.tsx. Hidden debug route, same policy as #/diagnostics.
		const { mountAutotest } = await import("./autotest");
		await mountAutotest();
	} else {
		const { mountApp } = await import("./app/app-root");
		mountApp();
	}
	appMounted = true;
}

let appMounted = false;

/** A boot failure must never strand the user on index.html's static
 *  "Loading…" placeholder (exactly what a silent dynamic-import rejection
 *  did on the first real-device run). The screen has the words of the crash
 *  screen (app/crash-screen.tsx): a plain message, "Try again" (loads the app
 *  again) and "Report" (opens the support page in the in-app sheet). It never
 *  shows the error, a stack trace or a file path in a store build: the error
 *  goes to the console, and only a debug build (KNEECAP_DEBUG_TOOLS=1) adds
 *  the details. Plain DOM with inline styles: React and the app styles may be
 *  the part that failed to load. */
function showBootError(err: unknown) {
	console.error("publik kneecap could not start:", err);
	const container = document.getElementById("app") ?? document.body;
	const screen = document.createElement("div");
	screen.className = "kc-crash";
	screen.dataset.kneecapCrash = "1";
	screen.setAttribute("role", "alert");
	screen.style.cssText =
		"box-sizing:border-box;height:100dvh;overflow-y:auto;background:#000;color:#f5f5f5;display:flex;flex-direction:column;align-items:flex-start;gap:16px;padding:calc(env(safe-area-inset-top, 0px) + 24px) 16px 24px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;";
	const title = document.createElement("p");
	title.style.cssText = "margin:0;font-size:17px;font-weight:700;color:#ff9c9c;";
	title.textContent = "publik kneecap stopped working";
	const message = document.createElement("p");
	message.style.cssText = "margin:0;font-size:15px;line-height:1.4;";
	message.textContent =
		"The app could not start. Your projects are safe on this phone. Tap Try again. If it happens again, tap Report and tell us what you did.";
	const actions = document.createElement("div");
	actions.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;";
	const button = (label: string, primary: boolean, onClick: () => void) => {
		const b = document.createElement("button");
		b.type = "button";
		b.textContent = label;
		b.style.cssText = `min-height:44px;min-width:44px;box-sizing:border-box;border:none;border-radius:8px;padding:10px 16px;font:600 14px -apple-system,BlinkMacSystemFont,sans-serif;${
			primary ? "background:#00cae0;color:#000;" : "background:#262626;color:#f5f5f5;"
		}`;
		b.addEventListener("click", onClick);
		return b;
	};
	actions.append(
		button("Try again", true, () => window.location.reload()),
		button("Report", false, () => {
			void (async () => {
				const [{ getPublikHost }, { SUPPORT_URL }] = await Promise.all([
					import("@kneecap/native-bridge/publik-host"),
					import("./publik/publik"),
				]);
				await getPublikHost().openUrl({ url: SUPPORT_URL });
			})().catch(() => {});
		}),
	);
	screen.append(title, message, actions);
	if (__KNEECAP_DEBUG_TOOLS__) {
		// Debug builds only: the details, for a screenshot without a Web Inspector attach.
		const pre = document.createElement("pre");
		pre.style.cssText = "margin:0;white-space:pre-wrap;word-break:break-word;color:#ff9c9c;font:11px/1.5 ui-monospace,monospace;";
		pre.textContent = err instanceof Error ? `${err.name}: ${err.message}\n\n${err.stack ?? ""}` : String(err);
		screen.append(pre);
	}
	container.replaceChildren(screen);
}

window.addEventListener("unhandledrejection", (event) => {
	// Pre-mount, a rejection means boot itself died — take over the screen.
	// POST-mount it's a runtime error inside a running app; replacing the
	// entire UI with a death screen for those was a real bug (a failed
	// pickMedia call on the founder's iPhone nuked the whole editor,
	// 2026-08-18). Running-app errors log instead; user-facing feedback is
	// each feature's own responsibility.
	if (appMounted) {
		console.error("kneecap unhandled rejection:", event.reason);
		return;
	}
	showBootError(event.reason);
});

if (__KNEECAP_DEBUG_TOOLS__) {
	window.addEventListener("hashchange", () => {
		const inDiagnostics = window.location.hash.startsWith(DIAGNOSTICS_HASH);
		const bootedDiagnostics = document.body.dataset.kneecapMode === "diagnostics";
		if (inDiagnostics !== bootedDiagnostics) window.location.reload();
	});
}

document.documentElement.dataset.publikGateMode = __PUBLIK_GATE_MARKER__;
document.documentElement.dataset.publikBuild = __PUBLIK_BUILD_MARKER__;

document.body.dataset.kneecapMode =
	__KNEECAP_DEBUG_TOOLS__ && window.location.hash.startsWith(DIAGNOSTICS_HASH) ? "diagnostics" : "app";

boot().catch(showBootError);
