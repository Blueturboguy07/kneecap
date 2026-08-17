/**
 * kneecap M1 spike harness — the pre-committed go/no-go numbers.
 *
 * Copied verbatim from plan §M1's exit-criteria table
 * (`~/.claude/plans/opencut-mobile-port.md`, "Exit criteria — these are the
 * go/no-go numbers"). This is the SINGLE SOURCE the on-screen verdict badges
 * and `docs/SPIKE-GUIDE.md`'s printed table both read from — if the plan's
 * numbers ever change, update here first and the guide is generated to match
 * (see `scripts/print-spike-thresholds.ts`, invoked by the guide's own
 * "these numbers come from the repo, not hand-copied" footer).
 */

export interface ThresholdBand {
	metric: string;
	unit: string;
	pass: string;
	investigate: string;
	killSignal: string;
}

export const M1_THRESHOLDS: Record<string, ThresholdBand> = {
	backendFrameTime: {
		metric: "1080p 3-layer composite, p95 frame time, mid-tier device",
		unit: "ms",
		pass: "≤ 33ms",
		investigate: "33–50ms",
		killSignal: "> 50ms with WebGL2 on both platforms",
	},
	scrubLatency: {
		metric: "Scrub latency with native proxy",
		unit: "ms",
		pass: "≤ 150ms",
		investigate: "150–400ms",
		killSignal: "> 400ms with proxies in place",
	},
	nativeExport: {
		metric: "60s 1080p30 native export wall clock",
		unit: "s",
		pass: "≤ 45s",
		investigate: "45–120s",
		killSignal: "fails or > 120s on mid-tier",
	},
	whisperTiny: {
		metric: "whisper.cpp tiny, 60s audio",
		unit: "s",
		pass: "≤ 30s",
		investigate: "30–90s",
		killSignal: "> 90s on mid-tier Android",
	},
	opfsWrite: {
		metric: "200MB OPFS write in WKWebView",
		unit: "pass/fail",
		pass: "succeeds",
		investigate: "—",
		killSignal: "fails (→ media stays 100% native, no OPFS derived artifacts either)",
	},
	peakRss: {
		metric: "Peak webview process RSS during backend-frametime test",
		unit: "MB",
		pass: "≤ 250MB",
		investigate: "250–400MB",
		killSignal: "repeated webViewWebContentProcessDidTerminate",
	},
};

/** Plan M1: "If two or more kill-signals fire: stop. Fall back to §7's Plan
 * B (native UI over the shared Rust core)." This harness surfaces the count;
 * it never auto-decides — that call is the founder's per plan §7. */
export const KILL_SIGNAL_STOP_THRESHOLD = 2;

export function classifyMs({
	valueMs,
	passMaxMs,
	investigateMaxMs,
}: {
	valueMs: number;
	passMaxMs: number;
	investigateMaxMs: number;
}): "pass" | "investigate" | "kill" {
	if (valueMs <= passMaxMs) return "pass";
	if (valueMs <= investigateMaxMs) return "investigate";
	return "kill";
}
