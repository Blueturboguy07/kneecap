import Foundation

/// kneecap M10 — the iOS half of `NativeBridge.transcribe()`, plan M10
/// items 1-2 ("whisper.cpp as the cross-platform engine, native plugin...
/// iOS: build with -DWHISPER_COREML=1"). Deliberately parallel in shape to
/// `apps/mobile/android/app/src/main/java/dev/kneecap/app/stt/WhisperTranscriber.java`
/// — same wire contract, same two honestly-open gaps, same reasoning for
/// why each throws instead of faking success.
///
/// STATUS — READ BEFORE WIRING THIS INTO THE APP TARGET:
///
/// This file is real, reviewed Swift, written directly against the real
/// whisper.h C API (verified locally: `brew install whisper-cpp` gave
/// whisper.cpp 1.9.2 with a real `/opt/homebrew/include/whisper.h` this
/// session cross-checked every struct field and function signature
/// against). It is INTENTIONALLY NOT added to `App.xcodeproj/project.pbxproj`
/// — this Xcode project uses explicit `PBXFileReference`/`PBXBuildFile`
/// entries (not Xcode 16's synchronized-folder groups), so a `.swift` file
/// dropped into this directory is inert until explicitly wired in. That is
/// deliberate: adding `import whisper` to a file the build graph DOES
/// compile (e.g. editing the already-wired `NativeBridgePlugin.swift`
/// directly) before `whisper.xcframework` is actually embedded would break
/// the M3 CI build (`.github/workflows/mobile-ci.yml`'s
/// `ios-simulator-build` job) for every other track working in this repo
/// right now. Wiring this in for real requires, in order:
///
///   1. Run whisper.cpp's own `./build-xcframework.sh` (from a whisper.cpp
///      checkout — NOT part of this repo, referenced the same way the
///      plan's Core ML step references `generate-coreml-model.sh`) to
///      produce `whisper.xcframework`.
///   2. Embed that xcframework in `App.xcodeproj` (drag into the project,
///      "Embed & Sign" on the App target — the same one-real-manual-step
///      pattern as plan M10 item 2's Core ML `.mlmodelc` signing).
///   3. Add THIS file to the App target's Sources build phase (again, one
///      manual Xcode step, or a careful hand-edit of `project.pbxproj`
///      adding matching `PBXFileReference`/`PBXBuildFile`/sources-phase
///      entries — not attempted this session; hand-editing `.pbxproj` by
///      script is a real, separate risk class, the same reason M13's
///      signing work stays in CI rather than an agent session).
///   4. Register a `transcribe` `CAPPluginMethod` on
///      `NativeBridgePlugin.swift` that calls into this file — NOT done
///      yet either, for the same reason as step 3: that file IS currently
///      compiled by CI and stays exactly as M3 left it until steps 1-3 are
///      real.
///
/// Two further gaps, same as Android, kept honest rather than faked:
///
///   - `decodeToMono16kFloat` is not implemented (AVFoundation
///     `AVAssetReader` + a sample-rate/channel-count converter — real
///     work, overlaps with M4's media pipeline exactly like the Android
///     side).
///   - Runtime iOS-26 detection for `SpeechAnalyzer`/`SpeechTranscriber`
///     (plan M10 item 2's second half) is not implemented in this file at
///     all — it belongs in `NativeBridgePlugin.swift` as a preferred path
///     ahead of this whisper.cpp fallback, once this file is wired in.
enum WhisperTranscriberError: Error {
	case modelAssetNotFound(String)
	case notYetWired(String)
	case contextInitFailed(String)
}

enum WhisperTranscriber {

	/// - Parameters:
	///   - audioUri: native-custody handle to the source clip's audio
	///     (matches `MediaHandle.uri` — never a `blob:` URL).
	///   - modelSize: "tiny" or "base" (`TranscribeOptions.modelSize`);
	///     resolves to the bundled `.en` asset in
	///     `App/App/Resources/models/ggml-{modelSize}.en.bin` — see that
	///     directory's README and `scripts/download-whisper-model.sh`.
	/// - Returns: the same wire shape
	///   `packages/native-bridge/src/capacitor-bridge.ts`'s
	///   `NativeTranscribeResult` expects — a dictionary ready for
	///   `CAPPluginCall.resolve(_:)`, once a `transcribe` plugin method
	///   exists to call this (see this file's header comment, step 4).
	static func transcribe(
		audioUri: String,
		modelSize: String,
		languageHint: String?
	) throws -> [String: Any] {
		guard let modelURL = bundledModelURL(modelSize: modelSize) else {
			throw WhisperTranscriberError.modelAssetNotFound(
				"ggml-\(modelSize).en.bin not found in App/App/Resources/models — "
					+ "run scripts/download-whisper-model.sh before building."
			)
		}

		// Same ordering rationale as the Android side: the audio-decode gap
		// is more informative than "whisper module not linked," so it's
		// checked first even though, structurally, both must be fixed
		// before this ever returns real data.
		_ = try decodeToMono16kFloat(audioUri: audioUri)

		throw WhisperTranscriberError.notYetWired(
			"WhisperTranscriber.transcribe: this file is not yet part of the App target's "
				+ "build (see this file's header comment) — reaching this line at all would "
				+ "mean the xcframework, pbxproj wiring, and audio decode are ALL done, which "
				+ "they are not as of M10 part 1. modelURL=\(modelURL.path)"
		)

		// The shape a real implementation returns, once wired — kept here
		// as a comment (not dead code the compiler would need to reconcile
		// with the `throw` above) so the wire contract stays documented
		// next to the one place that produces it:
		//
		// return [
		//     "segments": segments.map { segment in
		//         [
		//             "startMicros": segment.t0 * 10_000,
		//             "endMicros": segment.t1 * 10_000,
		//             "text": segment.text,
		//             "confidence": NSNull(),
		//             "tokens": segment.tokens.map { token in
		//                 [
		//                     "text": token.text,
		//                     "coarseStartMicros": token.t0 * 10_000,
		//                     "coarseEndMicros": token.t1 * 10_000,
		//                     "dtwStartMicros": token.t_dtw == -1 ? NSNull() : token.t_dtw * 10_000,
		//                     "confidence": token.p,
		//                 ]
		//             },
		//         ]
		//     }
		// ]
	}

	private static func bundledModelURL(modelSize: String) -> URL? {
		Bundle.main.url(
			forResource: "ggml-\(modelSize).en",
			withExtension: "bin",
			subdirectory: "models"
		)
	}

	/// See this file's header comment. Throws with a specific, actionable
	/// reason rather than returning empty/fake PCM.
	private static func decodeToMono16kFloat(audioUri: String) throws -> [Float] {
		throw WhisperTranscriberError.notYetWired(
			"Audio decode to 16kHz mono float32 PCM is not implemented yet (M10 follow-up; "
				+ "AVAssetReader + resampling, overlaps with M4's media pipeline). audioUri=\(audioUri)"
		)
	}
}
