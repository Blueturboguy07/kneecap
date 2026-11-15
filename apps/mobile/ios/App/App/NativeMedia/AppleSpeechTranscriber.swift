import AVFoundation
import Foundation
import Speech

/// kneecap M10 (round 20) — the iOS half of `NativeBridge.transcribe()`,
/// implemented on Apple's Speech framework instead of whisper.cpp.
///
/// WHY NOT WHISPER (founder: "worried whisper will be too heavy for
/// mobile — check"): whisper.cpp on iOS costs a bundled/downloaded model
/// (tiny.en q5 ≈ 32MB, base.en ≈ 60MB), a few hundred MB of peak RAM, an
/// out-of-repo xcframework build, and the audio-decode pipeline
/// `WhisperTranscriber.swift`'s own header documents as unimplemented.
/// Apple's Speech framework costs ZERO bytes of app weight, runs
/// on-device (private, offline), returns per-word timestamps + confidence
/// — exactly the wire contract's `coarseStart/EndMicros` envelope — and
/// `caption-smoothing.ts` runs identically on its words (`dtwStartMicros`
/// stays null, which the smoother already treats as "no refinement
/// signal"). The reference editor does NONE of this on-device: its
/// auto-captions upload audio to a server ASR (they fail offline) — so any
/// on-device path already beats it on privacy and offline. The
/// whisper.cpp scaffold stays as the documented Android engine (already
/// built there) and a future iOS quality option; `SpeechAnalyzer`/
/// `SpeechTranscriber` (iOS 26's new API, the plan's own "preferred path"
/// note) is the designated upgrade once this baseline is device-proven.
///
/// This file is PURE Foundation + Speech (no Capacitor) so
/// `verify-transcription` compiles it into a macOS CLI and exercises the
/// real mapping — the same harness pattern as `verify-export-pipeline`.
public enum AppleSpeechTranscriberError: Error, CustomStringConvertible {
	case audioNotReadable(String)
	case localeUnsupported(String)
	case onDeviceUnavailable(String)
	case recognitionFailed(String)

	public var description: String {
		switch self {
		case .audioNotReadable(let m): return "audio not readable: \(m)"
		case .localeUnsupported(let m): return "speech recognition unsupported for locale: \(m)"
		case .onDeviceUnavailable(let m): return "on-device speech recognition unavailable: \(m)"
		case .recognitionFailed(let m): return "speech recognition failed: \(m)"
		}
	}
}

public enum AppleSpeechTranscriber {

	/// One recognized word in a plain, framework-free shape — lets the wire
	/// mapper below be unit-tested by the harness without constructing
	/// (unconstructable) `SFTranscriptionSegment`s.
	public struct RecognizedWord {
		public let text: String
		/// Seconds from the start of the AUDIO FILE (source-relative).
		public let startSeconds: Double
		public let durationSeconds: Double
		/// 0...1; Apple reports 0 when confidence is unavailable.
		public let confidence: Double

		public init(text: String, startSeconds: Double, durationSeconds: Double, confidence: Double) {
			self.text = text
			self.startSeconds = startSeconds
			self.durationSeconds = durationSeconds
			self.confidence = confidence
		}
	}

	/// `MediaHandle.uri` arrives as either an absolute sandbox path or a
	/// `file://` URL string — same duality `NativeBridgePlugin+Export.swift`
	/// handles for `EdlAsset.sourceUri`.
	public static func audioURL(fromUri uri: String) -> URL {
		if uri.hasPrefix("file://"), let url = URL(string: uri) {
			return url
		}
		return URL(fileURLWithPath: uri)
	}

	/// Extract the media file's audio track to a temporary plain .m4a.
	///
	/// FOUND ON DEVICE (round 21.1): feeding a VIDEO container (the clip's
	/// .mov/.mp4) straight to `SFSpeechURLRecognitionRequest` "succeeds"
	/// with one EMPTY zero-length segment — the recognizer reads no audio
	/// from it. The macOS harness passed because it fed a pure audio file.
	/// `AVAssetExportSession` reads ANY AVAsset container and writes the
	/// audio-only file the recognizer is actually reliable on. Completion
	/// is called exactly once; the caller deletes the temp file.
	static func extractAudio(
		from url: URL,
		completion: @escaping (Result<URL, AppleSpeechTranscriberError>) -> Void
	) {
		let asset = AVURLAsset(url: url)
		Task {
			do {
				let audioTracks = try await asset.loadTracks(withMediaType: .audio)
				guard !audioTracks.isEmpty else {
					completion(.failure(.audioNotReadable("this clip has no audio track to transcribe")))
					return
				}
				guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
					completion(.failure(.audioNotReadable("audio extraction session could not be created")))
					return
				}
				let outURL = FileManager.default.temporaryDirectory
					.appendingPathComponent("kneecap-stt-\(UUID().uuidString).m4a")
				session.outputURL = outURL
				session.outputFileType = .m4a
			session.exportAsynchronously {
					if session.status == .completed {
						let bytes = (try? FileManager.default.attributesOfItem(atPath: outURL.path)[.size] as? Int) ?? 0
						print("[kneecap-stt] extracted \(outURL.lastPathComponent): \(bytes ?? 0) bytes from \(url.lastPathComponent)")
						completion(.success(outURL))
					} else {
						let reason = session.error?.localizedDescription ?? "status \(session.status.rawValue)"
						completion(.failure(.audioNotReadable("audio extraction failed: \(reason)")))
					}
				}
			} catch {
				completion(.failure(.audioNotReadable("audio tracks unreadable: \(error.localizedDescription)")))
			}
		}
	}

	/// Transcribe a media file's audio on-device. `modelSize` from the wire
	/// contract is accepted and ignored — Apple's recognizer has no model
	/// tiers (documented on the TS side too). Completion is called exactly
	/// once, on an arbitrary queue.
	public static func transcribe(
		audioUri: String,
		languageHint: String?,
		completion: @escaping (Result<[String: Any], AppleSpeechTranscriberError>) -> Void
	) {
		let sourceURL = audioURL(fromUri: audioUri)
		guard FileManager.default.fileExists(atPath: sourceURL.path) else {
			completion(.failure(.audioNotReadable(sourceURL.path)))
			return
		}
		extractAudio(from: sourceURL) { extraction in
			switch extraction {
			case .failure(let error):
				completion(.failure(error))
			case .success(let audioOnlyURL):
				recognize(audioFileURL: audioOnlyURL, languageHint: languageHint) { result in
					try? FileManager.default.removeItem(at: audioOnlyURL)
					completion(result)
				}
			}
		}
	}

	/// The recognition half, over a PLAIN AUDIO file (see extractAudio).
	///
	/// ROUND 21.3, from the founder's device trail ("recognized 1 raw
	/// words" for a clip full of speech, extraction healthy at 3MB):
	/// `SFSpeechURLRecognitionRequest` + `requiresOnDeviceRecognition` is
	/// KNOWN-unreliable on iOS for file input (fine on macOS — why the
	/// harness passed). Two engines now:
	///   1. iOS/macOS 26+: Apple's `SpeechAnalyzer`/`SpeechTranscriber` —
	///      the new API built for exactly this (what Voice Memos uses).
	///   2. Everywhere else / on any 26-path failure: the community-proven
	///      workaround — feed the file as PCM buffers through
	///      `SFSpeechAudioBufferRecognitionRequest` with partials on,
	///      keeping the richest transcription seen.
	static func recognize(
		audioFileURL url: URL,
		languageHint: String?,
		completion: @escaping (Result<[String: Any], AppleSpeechTranscriberError>) -> Void
	) {
		let localeId = languageHint ?? "en-US"
		if #available(iOS 26.0, macOS 26.0, *) {
			Task {
				do {
					let payload = try await recognizeWithSpeechAnalyzer(url: url, localeId: localeId)
					completion(.success(payload))
				} catch {
					print("[kneecap-stt] SpeechAnalyzer path failed (\(error)) — falling back to SFSpeech buffer path")
					recognizeWithBufferRequest(url: url, localeId: localeId, completion: completion)
				}
			}
		} else {
			recognizeWithBufferRequest(url: url, localeId: localeId, completion: completion)
		}
	}

	/// iOS 26+ engine: SpeechAnalyzer + SpeechTranscriber with audio time
	/// ranges. Ensures the locale's model asset is installed first (a
	/// system-managed, one-time download shared across apps — the same
	/// model dictation uses).
	@available(iOS 26.0, macOS 26.0, *)
	static func recognizeWithSpeechAnalyzer(url: URL, localeId: String) async throws -> [String: Any] {
		let locale = Locale(identifier: localeId)
		let transcriber = SpeechTranscriber(
			locale: locale,
			transcriptionOptions: [],
			reportingOptions: [],
			attributeOptions: [.audioTimeRange]
		)
		if let installRequest = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
			print("[kneecap-stt] SpeechAnalyzer: downloading locale model asset…")
			try await installRequest.downloadAndInstall()
		}

		let analyzer = SpeechAnalyzer(modules: [transcriber])
		let audioFile = try AVAudioFile(forReading: url)

		// Consume results concurrently with feeding — the transcriber's
		// results stream ends when the analyzer finishes.
		async let collected: [(String, Double, Double)] = {
			var words: [(String, Double, Double)] = []
			for try await result in transcriber.results {
				guard result.isFinal else { continue }
				for run in result.text.runs {
					let text = String(result.text[run.range].characters)
					if let timeRange = run.audioTimeRange {
						words.append((text, timeRange.start.seconds, timeRange.duration.seconds))
					} else if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
						words.append((text, -1, 0))
					}
				}
			}
			return words
		}()

		if let lastSample = try await analyzer.analyzeSequence(from: audioFile) {
			try await analyzer.finalizeAndFinish(through: lastSample)
		} else {
			await analyzer.cancelAndFinishNow()
		}

		let rawRuns = try await collected
		// Runs are word/phrase fragments incl. bare whitespace; keep timed,
		// non-empty ones. Untimed fragments inherit a zero-length envelope at
		// the previous word's end (smoothing downstream fixes overlaps).
		var words: [RecognizedWord] = []
		var cursor: Double = 0
		for (text, start, duration) in rawRuns {
			let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
			if trimmed.isEmpty { continue }
			let startSec = start >= 0 ? start : cursor
			words.append(RecognizedWord(text: trimmed, startSeconds: startSec, durationSeconds: max(0, duration), confidence: 0))
			cursor = startSec + max(0, duration)
		}
		let fullText = words.map(\.text).joined(separator: " ")
		print("[kneecap-stt] SpeechAnalyzer recognized \(words.count) words")
		return wireResult(words: words, fullText: fullText)
	}

	/// Pre-26 engine: the buffer-request workaround. Partials ON and the
	/// richest transcription kept — on-device file recognition is known to
	/// deliver good partials and then a poorer (even empty) final.
	static func recognizeWithBufferRequest(
		url: URL,
		localeId: String,
		completion: @escaping (Result<[String: Any], AppleSpeechTranscriberError>) -> Void
	) {
		guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
			completion(.failure(.localeUnsupported(localeId)))
			return
		}
		guard recognizer.isAvailable else {
			completion(.failure(.recognitionFailed("recognizer unavailable (locale \(localeId))")))
			return
		}
		print("[kneecap-stt] buffer engine: locale=\(localeId) onDevice=\(recognizer.supportsOnDeviceRecognition)")

		let request = SFSpeechAudioBufferRecognitionRequest()
		request.shouldReportPartialResults = true
		request.taskHint = .dictation
		if #available(iOS 16.0, macOS 13.0, *) {
			request.addsPunctuation = true
		}
		// Local-first: never silently upload the user's audio.
		if recognizer.supportsOnDeviceRecognition {
			request.requiresOnDeviceRecognition = true
		} else {
			completion(.failure(.onDeviceUnavailable(
				"locale \(localeId) has no on-device model on this device — " +
				"download it in Settings > General > Keyboard > Dictation, or use a supported language"
			)))
			return
		}

		var bestWords: [RecognizedWord] = []
		var bestText = ""
		var completed = false
		var retainedRecognizer: SFSpeechRecognizer? = recognizer
		let finish: (Result<[String: Any], AppleSpeechTranscriberError>) -> Void = { result in
			guard !completed else { return }
			completed = true
			retainedRecognizer = nil
			_ = retainedRecognizer // silence unused-write warning; the var IS the retain
			completion(result)
		}

		recognizer.recognitionTask(with: request) { result, error in
			if let result {
				let words = result.bestTranscription.segments.map { segment in
					RecognizedWord(
						text: segment.substring,
						startSeconds: segment.timestamp,
						durationSeconds: segment.duration,
						confidence: Double(segment.confidence)
					)
				}
				if words.count >= bestWords.count {
					bestWords = words
					bestText = result.bestTranscription.formattedString
				}
				if result.isFinal {
					print("[kneecap-stt] buffer engine final: \(words.count) words (best seen \(bestWords.count))")
					finish(.success(wireResult(words: bestWords, fullText: bestText)))
				}
			}
			if let error {
				// On-device tasks are known to error AFTER delivering good
				// partials — salvage them instead of failing the generate.
				if !bestWords.isEmpty {
					print("[kneecap-stt] buffer engine errored (\(error.localizedDescription)) — salvaging \(bestWords.count) partial words")
					finish(.success(wireResult(words: bestWords, fullText: bestText)))
				} else {
					finish(.failure(.recognitionFailed(error.localizedDescription)))
				}
			}
		}

		do {
			let audioFile = try AVAudioFile(forReading: url)
			let format = audioFile.processingFormat
			print("[kneecap-stt] feeding \(audioFile.length) frames @ \(format.sampleRate)Hz")
			while audioFile.framePosition < audioFile.length {
				guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8192) else { break }
				try audioFile.read(into: buffer)
				if buffer.frameLength == 0 { break }
				request.append(buffer)
			}
			request.endAudio()
		} catch {
			finish(.failure(.audioNotReadable("PCM read failed: \(error.localizedDescription)")))
		}
	}

	/// Map recognized words into the exact `NativeTranscribeResult` wire
	/// shape `capacitor-bridge.ts` expects: one segment spanning the whole
	/// recognized span, word tokens carrying the coarse envelope
	/// (`caption-smoothing.ts` chunks/smooths downstream; caption LINE
	/// grouping is editor-core's `buildCaptionElementsFromTranscript`'s
	/// job, not this mapper's). `dtwStartMicros` is always null — Apple
	/// gives one timing signal, which IS the reliable envelope. Zero words
	/// (no speech) returns `segments: []` per the contract's "genuinely no
	/// decodable words" case.
	public static func wireResult(words allWords: [RecognizedWord], fullText: String) -> [String: Any] {
		// Empty tokens are noise, never words: the device bug this guards
		// (round 21.1) was a single "" word with zero timestamps standing in
		// for a whole spoken clip — emitting it produced a phantom caption.
		let words = allWords.filter {
			!$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
		}
		guard let first = words.first, let last = words.last else {
			return ["segments": [[String: Any]]()]
		}
		let micros = { (seconds: Double) in Int((seconds * 1_000_000).rounded()) }
		let tokens: [[String: Any]] = words.map { word in
			[
				"text": word.text,
				"coarseStartMicros": micros(word.startSeconds),
				"coarseEndMicros": micros(word.startSeconds + word.durationSeconds),
				"dtwStartMicros": NSNull(),
				// Apple reports 0 for "confidence unavailable" (e.g. every
				// non-final result, some on-device paths) — map that to the
				// wire contract's null rather than lying "zero confidence".
				"confidence": word.confidence > 0 ? word.confidence : NSNull(),
			]
		}
		let segment: [String: Any] = [
			"startMicros": micros(first.startSeconds),
			"endMicros": micros(last.startSeconds + last.durationSeconds),
			"text": fullText,
			"confidence": NSNull(),
			"tokens": tokens,
		]
		return ["segments": [segment]]
	}
}
