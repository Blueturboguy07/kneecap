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
}

window.addEventListener("hashchange", () => {
	const inDiagnostics = window.location.hash.startsWith(DIAGNOSTICS_HASH);
	const bootedDiagnostics = document.body.dataset.kneecapMode === "diagnostics";
	if (inDiagnostics !== bootedDiagnostics) window.location.reload();
});

document.body.dataset.kneecapMode = window.location.hash.startsWith(DIAGNOSTICS_HASH)
	? "diagnostics"
	: "app";

void boot();
