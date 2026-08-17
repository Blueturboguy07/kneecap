/**
 * Test 3 (plan M1 item 3): native hardware export of a hand-written 2-clip +
 * cross-fade + text-overlay EDL. AVFoundation on iOS, Media3 on Android.
 *
 * The actual export runs entirely native — see
 * `ios/App/App/SpikeDiagnosticsPlugin.swift` and
 * `android/app/src/main/java/dev/kneecap/app/SpikeDiagnosticsPlugin.kt`.
 * This file just calls through `SpikeDiagnostics.exportSpikeSequence()` and
 * reshapes the result; there is no "2-clip + cross-fade" EDL object passed
 * across the bridge — plan M1 explicitly scopes this as a HAND-WRITTEN
 * fixture ("a hand-written 2-clip + cross-fade + text-overlay EDL"), so the
 * native side owns its own fixture rather than this spike reimplementing
 * `buildEdl()`/the EDL v1 schema for a throwaway harness.
 *
 * iOS and Android take genuinely different approaches, both documented in
 * their native files and worth restating here because it changes how to
 * read this test's `note` field:
 *   - iOS generates its 2 source clips ON-DEVICE via AVAssetWriter (solid
 *     color, no bundled asset — avoids hand-editing the fragile
 *     Xcode project file for a throwaway spike), then builds a real
 *     crossfade via AVMutableVideoComposition opacity ramps + a text overlay
 *     via AVVideoCompositionCoreAnimationTool, exported with
 *     AVAssetExportSession.
 *   - Android uses 2 clips bundled at `android/app/src/main/assets/spike/`
 *     (trivial and safe to bundle — no project-file surgery needed, unlike
 *     iOS) and Media3 Transformer. Whether the installed Media3 version
 *     supports true cross-fade compositing between two `EditedMediaItem`
 *     sequences is EXACTLY plan risk-register item #4's open question — see
 *     the Kotlin file's own comment for what shipped. If Media3 could not be
 *     made to cross-fade, the export still runs (sequential concatenation +
 *     text overlay) and `crossfadeApplied: false` with a `note` explaining
 *     why — that is itself real M1 data, not a broken harness.
 */
import { getSpikeDiagnosticsBridge } from "@kneecap/native-bridge/spike-diagnostics";
import type { NativeExportResult } from "../types";

export async function runNativeExport(): Promise<NativeExportResult> {
	const bridge = getSpikeDiagnosticsBridge();
	const result = await bridge.exportSpikeSequence();

	return {
		testId: "native-export",
		ran: result.ran,
		wallClockMs: result.wallClockMs,
		outputDurationMs: result.outputDurationMs,
		outputSizeBytes: result.outputSizeBytes,
		crossfadeApplied: result.crossfadeApplied,
		textOverlayApplied: result.textOverlayApplied,
		note: result.note,
		error: result.error,
	};
}
