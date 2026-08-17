/**
 * SpikeDiagnostics — a SEPARATE, throwaway native plugin for the M1 spike
 * harness only (plan M1 / this milestone's spike task).
 *
 * WHY A SEPARATE PLUGIN, not an addition to `NativeBridge`: `NativeBridge`
 * (`./capacitor-bridge.ts`) is the frozen, production interface — its
 * `exportProject`/`transcribe` are real M9/M10 work that this spike does not
 * do (a hand-rolled crossfade exporter built for six-hardcoded-frames of a
 * throwaway spike is not the M9 exporter and must never be mistaken for it).
 * `SpikeDiagnostics` is intentionally throwaway scaffolding, isolated so it
 * can be deleted in one PR once M1 is read and the real M9/M10 work lands.
 *
 * Lives inside `packages/native-bridge` — not `apps/mobile/src` — because
 * this package is the one directory `scripts/invariants.sh`'s bridge-import
 * gate excludes from the "no `@capacitor/*` import" scan (see that script's
 * header comment). `apps/mobile/src/spike/*` imports this module by its
 * package subpath (`@kneecap/native-bridge/spike-diagnostics`), never
 * `@capacitor/core` directly.
 */

import { registerPlugin, Capacitor } from "@capacitor/core";

export interface SpikeExportResult {
	ran: boolean;
	wallClockMs: number | null;
	outputDurationMs: number | null;
	outputSizeBytes: number | null;
	crossfadeApplied: boolean | null;
	textOverlayApplied: boolean | null;
	note: string | null;
	error: string | null;
}

export interface SpikeMemoryFootprint {
	residentBytes: number;
}

interface SpikeDiagnosticsPluginSpec {
	getMemoryFootprint(): Promise<SpikeMemoryFootprint>;
	exportSpikeSequence(): Promise<SpikeExportResult>;
}

const SpikeDiagnosticsPlugin = registerPlugin<SpikeDiagnosticsPluginSpec>(
	"SpikeDiagnostics",
);

export interface SpikeDiagnosticsBridge {
	readonly platform: "ios" | "android" | "web";
	readonly isNative: boolean;
	getMemoryFootprintBytes(): Promise<number | null>;
	exportSpikeSequence(): Promise<SpikeExportResult>;
}

/**
 * No caching (unlike `getNativeBridge()`): this is a diagnostics-only
 * surface with no state worth memoizing, and the spike UI calls it exactly
 * once per test run.
 */
export function getSpikeDiagnosticsBridge(): SpikeDiagnosticsBridge {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- same narrowing as capacitor-bridge.ts's `Capacitor.getPlatform()` cast.
	const platform = Capacitor.getPlatform() as "ios" | "android" | "web";
	const isNative = Capacitor.isNativePlatform();

	return {
		platform,
		isNative,

		async getMemoryFootprintBytes(): Promise<number | null> {
			if (!isNative) return null;
			try {
				const { residentBytes } = await SpikeDiagnosticsPlugin.getMemoryFootprint();
				return residentBytes;
			} catch {
				return null;
			}
		},

		async exportSpikeSequence(): Promise<SpikeExportResult> {
			if (!isNative) {
				return {
					ran: false,
					wallClockMs: null,
					outputDurationMs: null,
					outputSizeBytes: null,
					crossfadeApplied: null,
					textOverlayApplied: null,
					note: null,
					error: "SpikeDiagnostics is native-only — running in a plain browser/web-fallback context.",
				};
			}
			try {
				return await SpikeDiagnosticsPlugin.exportSpikeSequence();
			} catch (err) {
				return {
					ran: false,
					wallClockMs: null,
					outputDurationMs: null,
					outputSizeBytes: null,
					crossfadeApplied: null,
					textOverlayApplied: null,
					note: null,
					error: err instanceof Error ? err.message : "unknown exportSpikeSequence error",
				};
			}
		},
	};
}
