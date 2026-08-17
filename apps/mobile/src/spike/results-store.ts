import type { AnyTestResult, EnvironmentInfo, SpikeRunExport, TestId } from "./types";

const results: Partial<Record<TestId, AnyTestResult>> = {};
let environment: EnvironmentInfo | null = null;

export function setEnvironment(env: EnvironmentInfo): void {
	environment = env;
}

export function recordResult(result: AnyTestResult): void {
	results[result.testId] = result;
}

export function getResult<T extends AnyTestResult>(testId: TestId): T | undefined {
	return results[testId] as T | undefined;
}

export function buildExport(): SpikeRunExport {
	return {
		schemaVersion: 1,
		environment: environment ?? {
			platform: "web",
			userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
			deviceModel: null,
			osVersion: null,
			ramTierMb: null,
			timestampIso: new Date().toISOString(),
		},
		results: { ...results },
	};
}

export function exportJson(): string {
	return JSON.stringify(buildExport(), null, 2);
}

/**
 * Hands the founder the JSON. Web Share API's file-sharing branch routes
 * through each platform's native share sheet (Capacitor's WKWebView/Android
 * WebView both support `navigator.share`/`canShare` with files as of the
 * versions this app's floors require) — that is the "shareable" half of
 * "on-screen live metrics + a shareable JSON results export." Falls back to
 * a plain-text `<textarea>` the founder can select-all/copy, which always
 * works with zero platform APIs.
 */
export async function shareResults(): Promise<{ method: "share" | "clipboard" | "manual" }> {
	const json = exportJson();
	const filename = `kneecap-spike-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

	if (typeof navigator !== "undefined" && "share" in navigator) {
		try {
			const file = new File([json], filename, { type: "application/json" });
			const nav = navigator as Navigator & {
				canShare?: (data: { files: File[] }) => boolean;
			};
			if (!nav.canShare || nav.canShare({ files: [file] })) {
				await navigator.share({
					files: [file],
					title: "kneecap M1 spike results",
				});
				return { method: "share" };
			}
		} catch {
			// User cancelled or share failed — fall through to clipboard.
		}
	}

	if (typeof navigator !== "undefined" && navigator.clipboard) {
		try {
			await navigator.clipboard.writeText(json);
			return { method: "clipboard" };
		} catch {
			// Fall through to manual.
		}
	}

	return { method: "manual" };
}
