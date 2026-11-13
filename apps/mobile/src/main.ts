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
	// once per install, AFTER the gate.
	await showFirstRun();

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
 *  did on the first real-device run) — surface the error on screen, where
 *  it is also screenshot-debuggable without a Web Inspector attach. */
function showBootError(err: unknown) {
	const detail =
		err instanceof Error ? `${err.name}: ${err.message}\n\n${err.stack ?? ""}` : String(err);
	const container = document.getElementById("app") ?? document.body;
	const pre = document.createElement("pre");
	pre.style.cssText =
		"padding:16px;white-space:pre-wrap;word-break:break-word;color:#ff5c5c;font:12px/1.5 ui-monospace,monospace;";
	pre.textContent = `kneecap failed to start\n\n${detail}`;
	container.replaceChildren(pre);
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

document.body.dataset.kneecapMode =
	__KNEECAP_DEBUG_TOOLS__ && window.location.hash.startsWith(DIAGNOSTICS_HASH) ? "diagnostics" : "app";

boot().catch(showBootError);
