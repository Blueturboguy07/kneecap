/**
 * kneecap mobile entry — a deliberately thin hash router:
 *
 *   (default)        -> ./app/app-root.tsx  — the real product: project
 *                       list + the CapCut-parity editor (`EditorShell`).
 *   #/diagnostics    -> ./legacy-harness.ts — the M3/M4 NativeBridge shell
 *                       harness, kept reachable for QA (see its header).
 *
 * Both are dynamic imports so the diagnostics path stays out of the
 * editor's startup graph and vice versa. A hash flip between modes does a
 * full reload rather than trying to unmount one world and boot the other —
 * this is a hidden debug switch, not user-facing navigation.
 */
const DIAGNOSTICS_HASH = "#/diagnostics";

async function boot() {
	if (window.location.hash.startsWith(DIAGNOSTICS_HASH)) {
		const { mountLegacyHarness } = await import("./legacy-harness");
		await mountLegacyHarness();
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

window.addEventListener("hashchange", () => {
	const inDiagnostics = window.location.hash.startsWith(DIAGNOSTICS_HASH);
	const bootedDiagnostics = document.body.dataset.kneecapMode === "diagnostics";
	if (inDiagnostics !== bootedDiagnostics) window.location.reload();
});

document.body.dataset.kneecapMode = window.location.hash.startsWith(DIAGNOSTICS_HASH)
	? "diagnostics"
	: "app";

boot().catch(showBootError);
