import Foundation
import Capacitor
import Speech

/// kneecap M10 (round 20) — the `transcribe` plugin method, Capacitor glue
/// over `NativeMedia/AppleSpeechTranscriber.swift` (which holds ALL the
/// recognition + wire-mapping logic so `verify-transcription` can compile
/// and exercise it without Capacitor). See that file's header for why this
/// is Apple Speech and not whisper.cpp on iOS.
///
/// Error-code mapping follows `NATIVE_BRIDGE_ERROR_CODES`
/// (packages/native-bridge/src/types.ts): authorization -> PERMISSION_DENIED,
/// locale/on-device gaps -> UNSUPPORTED, everything IO-ish -> IO_ERROR. The
/// TS bridge preserves these codes verbatim (`toNativeBridgeError`).
///
/// 1.0.8 (blind test 1.0.7, item 8): the clip's sound first, the speech
/// permission second. The audio track is read (`extractAudio`) before
/// `requestAuthorization`, so a clip with no sound never shows the speech
/// permission prompt. The Captions panel asks for captions only when the
/// person taps Generate on a project with sound (captions-actions.ts).
extension NativeBridgePlugin {

	@objc func transcribe(_ call: CAPPluginCall) {
		guard let audioUri = call.getString("audioUri"), !audioUri.isEmpty else {
			call.reject("transcribe requires audioUri", "IO_ERROR")
			return
		}
		// `modelSize` is part of the wire contract for the Android
		// whisper.cpp engine; Apple's recognizer has no model tiers, so it
		// is accepted and ignored here (documented on the TS side too).
		let languageHint = call.getString("languageHint")

		let sourceURL = AppleSpeechTranscriber.audioURL(fromUri: audioUri)
		guard FileManager.default.fileExists(atPath: sourceURL.path) else {
			call.reject(AppleSpeechTranscriberError.audioNotReadable(sourceURL.path).description, "IO_ERROR")
			return
		}
		AppleSpeechTranscriber.extractAudio(from: sourceURL) { extraction in
			switch extraction {
			case .failure(let error):
				// No audio track (or an unreadable one): no permission prompt.
				call.reject(error.description, "IO_ERROR")
			case .success(let audioOnlyURL):
				SFSpeechRecognizer.requestAuthorization { status in
					switch status {
					case .authorized:
						AppleSpeechTranscriber.recognize(
							audioFileURL: audioOnlyURL,
							languageHint: languageHint
						) { result in
							try? FileManager.default.removeItem(at: audioOnlyURL)
							switch result {
							case .success(let payload):
								call.resolve(payload)
							case .failure(let error):
								switch error {
								case .localeUnsupported, .onDeviceUnavailable:
									call.reject(error.description, "UNSUPPORTED")
								case .audioNotReadable, .recognitionFailed:
									call.reject(error.description, "IO_ERROR")
								}
							}
						}
					case .denied, .restricted:
						try? FileManager.default.removeItem(at: audioOnlyURL)
						call.reject(
							"speech recognition permission denied — enable it in Settings > kneecap",
							"PERMISSION_DENIED"
						)
					case .notDetermined:
						// The callback only fires with a determined status; this arm
						// exists for the enum, not for a reachable state.
						try? FileManager.default.removeItem(at: audioOnlyURL)
						call.reject("speech recognition authorization undetermined", "PERMISSION_DENIED")
					@unknown default:
						try? FileManager.default.removeItem(at: audioOnlyURL)
						call.reject("speech recognition authorization unknown state", "PERMISSION_DENIED")
					}
				}
			}
		}
	}
}
