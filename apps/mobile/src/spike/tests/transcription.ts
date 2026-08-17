/**
 * Test 4 (plan M1 item 4): whisper.cpp `tiny` over 60s of speech on-device,
 * both platforms, reporting wall clock and word-timestamp output vs. ground
 * truth.
 *
 * NOT IMPLEMENTED in this pass — reported honestly, not faked. Bundling and
 * building whisper.cpp for iOS (XCFramework/SPM) and Android (NDK/CMake)
 * plus a real GGML `tiny` model file is substantial standalone integration
 * work belonging to plan M10 ("Local on-device captions"), which no track
 * has started as of this spike (verified: no `whisper` references anywhere
 * in the repo tree at the time this file was written). `NativeBridge.
 * transcribe()` itself already throws a typed `NOT_IMPLEMENTED` error
 * pending M10 — see `packages/native-bridge/src/capacitor-bridge.ts`.
 *
 * This function calls through that real (stubbed) bridge method rather than
 * a fake, so the harness's behavior here is genuine: it correctly detects
 * and reports "engine not bundled," which is itself the accurate M1 status
 * for this measurement today. When M10 lands a real transcribe()
 * implementation, this test starts producing real numbers with no code
 * change needed here.
 */
import { getNativeBridge, NativeBridgeError } from "@kneecap/native-bridge";
import type { TranscriptionResult } from "../types";

export async function runTranscription(): Promise<TranscriptionResult> {
	const bridge = await getNativeBridge();

	try {
		// No bundled 60s speech fixture + ground-truth transcript exists yet
		// either (that pairing belongs with the real M10 model integration,
		// not this spike) — so there is nothing to pass. If transcribe() ever
		// resolves instead of throwing, that alone is the signal M10 landed;
		// this call exists to detect exactly that transition.
		const handle = {
			id: "spike-placeholder",
			uri: "",
			kind: "audio" as const,
			fileName: "unbundled",
			sizeBytes: 0,
			durationMicros: 0,
			width: 0,
			height: 0,
			rotationDegrees: 0 as const,
			hasAudio: true,
			codec: "unknown",
			frameRate: null,
		};
		const iterator = bridge.transcribe({ handle, opts: { modelSize: "tiny" } });
		const start = performance.now();
		const segments = [];
		for await (const segment of iterator) segments.push(segment);
		return {
			testId: "transcription",
			ran: true,
			wallClockMs: performance.now() - start,
			wordCount: segments.length,
			meanWordTimingErrorMs: null,
			note: "transcribe() resolved — M10 has landed since this spike file was written; wire a real 60s ground-truth fixture to get meaningful word-timing-error numbers.",
			error: null,
		};
	} catch (err) {
		const isExpectedStub = err instanceof NativeBridgeError && err.code === "NOT_IMPLEMENTED";
		return {
			testId: "transcription",
			ran: false,
			wallClockMs: null,
			wordCount: null,
			meanWordTimingErrorMs: null,
			note: isExpectedStub
				? "ENGINE NOT BUNDLED — whisper.cpp + tiny model integration is plan M10 scope, not done in this M1 spike pass. See docs/SPIKE-GUIDE.md."
				: null,
			error: err instanceof Error ? err.message : "unknown transcribe() error",
		};
	}
}
