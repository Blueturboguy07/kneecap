import Foundation
import AVFoundation
import CoreMedia

/// kneecap M9 — top-level EDL export orchestration (plan M9 items 4, 5, 7):
/// `AVAssetReader` (reading the composed+video-composited frames) ->
/// `AVAssetWriter` (VideoToolbox-backed hardware H.264/HEVC encode),
/// streamed to disk with no full-file in-memory buffering, progress
/// callbacks, cooperative cancellation, and a post-export integrity re-probe.
///
/// Reuses the SAME reader/writer/`requestMediaDataWhenReady` shape as
/// `NativeMedia/ProxyTranscoder.swift` — but does NOT need that file's
/// manual `CIContext.render` step, because `AVAssetReaderVideoCompositionOutput`
/// already runs the video composition (custom transition compositor +
/// Core-Animation overlay tool) internally and hands back already-composited
/// sample buffers; this file's writer side is a direct
/// `AVAssetWriterInput.append(_:)` passthrough of those buffers, with the
/// writer's OWN `outputSettings` doing the actual hardware encode.
public struct EdlExportResult: Equatable {
	public var outputURL: URL
	public var durationMicros: Int64
	public var width: Int
	public var height: Int
	public var hasAudio: Bool
}

public enum EdlExportStatus: Equatable {
	case running(Double)
	case cancelled
}

public enum EdlExportError: Error, CustomStringConvertible {
	case unsupportedContainer(String)
	case readerSetupFailed(String)
	case writerSetupFailed(String)
	case readerFailed(String)
	case writerFailed(String)
	case integrityCheckFailed(String)
	case cancelled

	public var description: String {
		switch self {
		case .unsupportedContainer(let c): return "output.container \"\(c)\" is not supported by this exporter (only \"mp4\")"
		case .readerSetupFailed(let m): return "reader setup failed: \(m)"
		case .writerSetupFailed(let m): return "writer setup failed: \(m)"
		case .readerFailed(let m): return "reader failed: \(m)"
		case .writerFailed(let m): return "writer failed: \(m)"
		case .integrityCheckFailed(let m): return "export produced a file that failed the output integrity re-probe: \(m)"
		case .cancelled: return "export was cancelled"
		}
	}
}

/// Cooperative cancellation flag — plan M9 exit criterion "Cancel mid-export
/// leaves no partial file and no leaked encoder." A plain lock-guarded
/// `Bool` rather than `Task` cancellation because the video/audio drain
/// loops below are driven by AVFoundation's own `requestMediaDataWhenReady`
/// callback queues, not by cooperative Swift-concurrency checkpoints — this
/// flag is polled at every iteration of those loops instead.
public final class EdlExportHandle: @unchecked Sendable {
	private let lock = NSLock()
	private var _cancelled = false
	public init() {}
	public func cancel() {
		lock.lock(); _cancelled = true; lock.unlock()
	}
	public var isCancelled: Bool {
		lock.lock(); defer { lock.unlock() }
		return _cancelled
	}
}

public enum EdlExporter {
	public static func export(
		edl: EdlDocument,
		overlayFrames: [PrerenderedOverlayFrame] = [],
		resolveAssetURL: @escaping (EdlAsset) -> URL?,
		outputURL: URL,
		handle: EdlExportHandle = EdlExportHandle(),
		onProgress: (@Sendable (Double) -> Void)? = nil
	) async throws -> EdlExportResult {
		guard edl.output.container == "mp4" else {
			throw EdlExportError.unsupportedContainer(edl.output.container)
		}

		let built = try await CompositionBuilder.build(edl: edl, resolveAssetURL: resolveAssetURL)
		// `built.remappedEdl`, NOT `edl` — see `VideoCompositionBuilder
		// .build`'s doc comment on why overlay timing must read the
		// transition-compressed document.
		let videoComposition = try VideoCompositionBuilder.build(
			edl: built.remappedEdl,
			built: built,
			resolveAssetURL: resolveAssetURL,
			overlayFrames: overlayFrames
		)
		let composition = built.composition

		if FileManager.default.fileExists(atPath: outputURL.path) {
			try FileManager.default.removeItem(at: outputURL)
		}
		try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)

		// --- Reader: pulls already-composited (transitions + overlays
		// baked in) video frames, and pre-mixed (per-clip volume + the
		// cross-fade audio ramps `CompositionBuilder` wrote into
		// `built.audioMix`) audio. ---
		let reader: AVAssetReader
		do {
			reader = try AVAssetReader(asset: composition)
		} catch {
			throw EdlExportError.readerSetupFailed(describe(error))
		}

		let videoTracks = composition.tracks(withMediaType: .video).filter { CompositionBuilder.hasMedia($0) }
		guard !videoTracks.isEmpty else {
			throw EdlExportError.readerSetupFailed("the timeline has no video or photo frames to export")
		}
		let videoOutput = AVAssetReaderVideoCompositionOutput(
			videoTracks: videoTracks,
			videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
		)
		videoOutput.videoComposition = videoComposition
		videoOutput.alwaysCopiesSampleData = false
		guard reader.canAdd(videoOutput) else {
			throw EdlExportError.readerSetupFailed("cannot add video composition output")
		}
		reader.add(videoOutput)

		// Only tracks with real media: an audio-mix output over empty tracks
		// makes startReading fail (-11800, underlying -12710). A project with
		// no audio (photos, muted or silent clips) exports video only.
		let audioTracks = composition.tracks(withMediaType: .audio).filter { CompositionBuilder.hasMedia($0) }
		var audioOutput: AVAssetReaderAudioMixOutput?
		if edl.output.includeAudio, !audioTracks.isEmpty {
			// LINEAR PCM, not passthrough (round 39): boosting a clip past
			// 0 dBFS (the volume slider reaches 1000% / +20 dB) makes the
			// summed mix exceed full scale, and an unlimited encode turns
			// that into hard digital clipping — the "audio rips at 1000x"
			// the founder heard. Decoding to float here lets `softLimit`
			// below round the peaks off before the AAC encoder sees them.
			let out = AVAssetReaderAudioMixOutput(audioTracks: audioTracks, audioSettings: [
				AVFormatIDKey: kAudioFormatLinearPCM,
				AVLinearPCMBitDepthKey: 32,
				AVLinearPCMIsFloatKey: true,
				AVLinearPCMIsNonInterleaved: false,
				AVLinearPCMIsBigEndianKey: false,
				AVSampleRateKey: 44100,
				AVNumberOfChannelsKey: 2,
			])
			out.audioMix = built.audioMix
			// MUST copy: the limiter below rewrites these samples in place, and
			// with `false` the reader vends buffers backed by memory it still
			// owns. Those writes were silently discarded — the exported audio
			// was byte-for-byte identical with the limiter running and with it
			// removed, which is why "audio rips at 1000%" survived a fix that
			// measured its own limiter working. The video output stays
			// zero-copy; nothing mutates those.
			out.alwaysCopiesSampleData = true
			if reader.canAdd(out) {
				reader.add(out)
				audioOutput = out
			}
		}

		// --- Writer: hardware encode via AVAssetWriter/VideoToolbox. ---
		let writer: AVAssetWriter
		do {
			writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
		} catch {
			throw EdlExportError.writerSetupFailed(describe(error))
		}

		let videoCodec: AVVideoCodecType = edl.output.videoCodec.lowercased().contains("hevc")
			|| edl.output.videoCodec.lowercased().contains("h265")
			? .hevc : .h264
		let videoWriterInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
			AVVideoCodecKey: videoCodec,
			AVVideoWidthKey: edl.output.resolution.width,
			AVVideoHeightKey: edl.output.resolution.height,
			AVVideoCompressionPropertiesKey: [
				AVVideoAverageBitRateKey: edl.output.bitrate,
			],
		])
		videoWriterInput.expectsMediaDataInRealTime = false
		guard writer.canAdd(videoWriterInput) else {
			throw EdlExportError.writerSetupFailed("cannot add video input")
		}
		writer.add(videoWriterInput)

		var audioWriterInput: AVAssetWriterInput?
		if audioOutput != nil {
			// AAC unconditionally: `output.audioCodec` in EDL v1 is
			// producer-declared intent, but AVAssetWriter's only
			// production-realistic lossy AAC-family option on this
			// platform is `kAudioFormatMPEG4AAC` — a non-"aac" value here
			// (there is none in the frozen v1 schema's practical range) is
			// treated as AAC rather than failing the export.
			let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
				AVFormatIDKey: kAudioFormatMPEG4AAC,
				AVNumberOfChannelsKey: 2,
				AVSampleRateKey: 44100,
				AVEncoderBitRateKey: 128_000,
			])
			input.expectsMediaDataInRealTime = false
			if writer.canAdd(input) {
				writer.add(input)
				audioWriterInput = input
			}
		}

		// Coverage diagnostic (round 32): AVFoundation reports an
		// out-of-spec video composition as a bare -11841
		// (AVErrorInvalidVideoComposition) with no detail, so print the shape
		// that decides validity — instructions MUST tile [0, duration]
		// contiguously. `built.backgroundOnlyRanges` fills spans with no main
		// clip; anything still uncovered here would be a real bug.
		if let first = videoComposition.instructions.first,
		   let last = videoComposition.instructions.last {
			let covered = CMTimeRangeGetUnion(first.timeRange, otherRange: last.timeRange)
			print("[kneecap-export] video composition: \(videoComposition.instructions.count) instruction(s) covering \(covered.start.seconds)s–\(covered.end.seconds)s of \(composition.duration.seconds)s, renderSize=\(Int(videoComposition.renderSize.width))x\(Int(videoComposition.renderSize.height))")
		}

		print("[kneecap-export] reader: \(videoTracks.count) video track(s), \(audioOutput == nil ? 0 : audioTracks.count) audio track(s) mixed")

		resetLimiter()

		guard reader.startReading() else {
			throw EdlExportError.readerFailed(describe(reader.error))
		}
		guard writer.startWriting() else {
			throw EdlExportError.writerFailed(describe(writer.error))
		}
		writer.startSession(atSourceTime: .zero)

		let totalSeconds = EdlTime.cmTime(ticks: built.totalDurationTicks, ticksPerSecond: edl.meta.ticksPerSecond).seconds

		do {
			// CONCURRENTLY, not sequentially — unlike `ProxyTranscoder`'s
			// plain `AVAssetReaderTrackOutput`s (which really can be
			// drained one-after-another; see that file's own doc comment),
			// `AVAssetReaderVideoCompositionOutput`'s internal composition
			// pipeline (CoreMedia's "remaker"/videomediaconverter threads)
			// deadlocks if its sibling `AVAssetReaderAudioMixOutput` on the
			// SAME `AVAssetReader` is left completely undrained while the
			// video side runs — confirmed empirically in this repo's own
			// `verify-export-pipeline` harness (both threads sat parked on
			// `pthread_cond_wait` indefinitely under the old sequential
			// version; `sample` showed zero CPU activity anywhere). A
			// single `AVAssetReader` with multiple outputs expects them
			// serviced roughly together; a `TaskGroup` running both drain
			// loops at once is the fix, and is also the more standard
			// AVFoundation multi-track transcode shape.
			try await withThrowingTaskGroup(of: Void.self) { group in
				group.addTask {
					try await runPhase(
						reader: reader,
						readerOutput: videoOutput,
						writerInput: videoWriterInput,
						handle: handle,
						queueLabel: "app.kneecap.export.video",
						progressWeight: 0.9,
						totalSeconds: totalSeconds,
						onProgress: onProgress
					)
				}
				if let audioOutput, let audioWriterInput {
					group.addTask {
						try await runPhase(
							reader: reader,
							readerOutput: audioOutput,
							writerInput: audioWriterInput,
							isAudio: true,
							handle: handle,
							queueLabel: "app.kneecap.export.audio",
							progressWeight: nil,
							totalSeconds: totalSeconds,
							onProgress: nil
						)
					}
				}
				try await group.waitForAll()
			}
		} catch {
			reader.cancelReading()
			writer.cancelWriting()
			try? FileManager.default.removeItem(at: outputURL)
			throw error
		}

		if handle.isCancelled {
			reader.cancelReading()
			writer.cancelWriting()
			try? FileManager.default.removeItem(at: outputURL)
			throw EdlExportError.cancelled
		}

		limiterStateLock.lock()
		let peakSeen = limiterPeakSeen
		let buffersSeen = limiterBuffersSeen
		limiterStateLock.unlock()
		print("[kneecap-audio] limiter saw \(buffersSeen) buffer(s), peak \(peakSeen) (1.0 = full scale)")

		await writer.finishWriting()
		if writer.status != .completed {
			try? FileManager.default.removeItem(at: outputURL)
			throw EdlExportError.writerFailed(writer.error.map { describe($0) } ?? "writer ended in status \(writer.status.rawValue)")
		}

		onProgress?(0.98)

		// --- Output integrity check (plan M9 item 7): re-probe rather than
		// trust our own success path. ---
		let probed: ProbedMedia
		do {
			probed = try await MediaProbe.probe(url: outputURL)
		} catch {
			throw EdlExportError.integrityCheckFailed("re-probe threw: \(error)")
		}
		guard probed.kind == "video" else {
			throw EdlExportError.integrityCheckFailed("re-probed kind was \"\(probed.kind)\", expected \"video\"")
		}
		let expectedMicros = Int64((totalSeconds * 1_000_000).rounded())
		let toleranceMicros: Int64 = 300_000 // 0.3s — GOP/encoder rounding slack, not a silent-corruption mask
		guard abs(probed.durationMicros - expectedMicros) <= toleranceMicros else {
			throw EdlExportError.integrityCheckFailed(
				"re-probed duration \(probed.durationMicros)µs is outside tolerance of expected \(expectedMicros)µs"
			)
		}

		onProgress?(1.0)
		return EdlExportResult(
			outputURL: outputURL,
			durationMicros: probed.durationMicros,
			width: probed.width,
			height: probed.height,
			hasAudio: probed.hasAudio
		)
	}

	/// Error text with its domain and code, plus the underlying code when
	/// there is one. AVFoundation's -11800 text alone ("The operation could
	/// not be completed") does not say what went wrong.
	static func describe(_ error: Error?) -> String {
		guard let error else { return "unknown" }
		let nsError = error as NSError
		var text = "\(nsError.localizedDescription) (\(nsError.domain) \(nsError.code)"
		if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError {
			text += ", underlying \(underlying.domain) \(underlying.code)"
		}
		return text + ")"
	}

	/// Shared drain loop for both the video and audio reader outputs —
	/// direct sample-buffer passthrough (`writerInput.append(sampleBuffer)`),
	/// no manual pixel-buffer rendering: the video composition already
	/// happened inside `AVAssetReaderVideoCompositionOutput` before this
	/// function ever sees a sample buffer.

	/// LOOK-AHEAD BRICKWALL LIMITER over the export's float PCM.
	///
	/// The volume control reaches 1000% (+20 dB), so the summed mix runs far
	/// past full scale and something has to bring it back. Round 39's
	/// feed-forward version could not: it derived the gain from samples as
	/// they arrived, so on any sudden onset the gain was still ~1 when the
	/// peak went through and a final `min(ceiling, max(-ceiling, …))` clamp
	/// squared the waveform off. Measured offline on synthetic speech boosted
	/// 10x: 46 clipped runs per second, the longest 2.06 ms of flat top —
	/// audible tearing on every syllable, which is what the founder kept
	/// hearing after that "fix". (Its own verification passed because it
	/// counted samples sitting exactly on the ceiling in the DECODED AAC,
	/// where lossy coding moves every sample slightly off that value. Never
	/// measure clipping after a lossy round trip.)
	///
	/// This version delays the audio by the look-ahead window and derives the
	/// gain from samples that have not been emitted yet, so the gain is
	/// already down when the peak arrives:
	///
	///   gain[n] = boxcar_L( releaseSmoothed( slidingMin_2L( ceiling / |x| ) ) )
	///   out[n]  = x[n - L] * gain[n]
	///
	/// Every value averaged into `gain[n]` is a minimum taken over a window
	/// that still contains the sample being emitted, so the applied gain is
	/// always <= the gain that sample needs and NO clamp is required. Same
	/// measurement, same signal: 0 clipped runs, peak exactly at the ceiling,
	/// and steady-tone THD 3.0% -> 0.2%.
	///
	/// The algorithm is duplicated in `LookaheadLimiter.kt` (Android export)
	/// and `limiter.ts` (web preview); the three must stay audibly identical,
	/// so change them together and re-run their shared fixture.
	final class LookaheadLimiter {
		private let ceiling: Float
		private let lookahead: Int
		private let releaseCoefficient: Float

		private var delayLine: [Float]
		private var delayWrite = 0
		/// Monotonic deque over the required-gain curve; its front is the
		/// minimum across the look-ahead window in O(1) amortized.
		private var minIndices: [Int] = []
		private var minValues: [Float] = []
		private var boxcar: [Float]
		private var boxcarWrite = 0
		private var boxcarSum: Float
		private var heldGain: Float = 1
		private var sampleIndex = 0

		/// - Parameters:
		///   - ceiling: -1.0 dBFS. Sample-peak limiting does NOT bound
		///     INTER-sample peaks — a reconstructed waveform can exceed the
		///     sample peak by ~3 dB in the pathological case and typically
		///     0.3-1.5 dB on real material — and a lossy encoder adds its own
		///     overshoot on top. -1 dBFS absorbs both; hotter than that before
		///     an AAC encode is how "limited" audio still arrives clipped.
		///   - lookaheadMs: 4 ms — long enough to catch a transient, short
		///     enough that the added delay is inaudible and irrelevant offline.
		///   - releaseMs: 150 ms — slow enough not to pump on speech.
		/// -1.0 dBFS; must match `LookaheadLimiter.CEILING` on Android.
		static let defaultCeiling: Float = 0.891

		init(sampleRate: Float, ceiling: Float = LookaheadLimiter.defaultCeiling, lookaheadMs: Float = 4, releaseMs: Float = 150) {
			self.ceiling = ceiling
			self.lookahead = max(2, Int(sampleRate * lookaheadMs / 1000))
			self.releaseCoefficient = exp(-1.0 / (sampleRate * releaseMs / 1000))
			self.delayLine = [Float](repeating: 0, count: self.lookahead)
			self.boxcar = [Float](repeating: 1, count: self.lookahead)
			self.boxcarSum = Float(self.lookahead)
		}

		func process(samples: UnsafeMutablePointer<Float>, count: Int) {
			for index in 0..<count {
				let value = samples[index].isFinite ? samples[index] : 0
				let magnitude = abs(value)
				let required: Float = magnitude > ceiling ? ceiling / magnitude : 1

				while let last = minValues.last, last >= required {
					minValues.removeLast()
					minIndices.removeLast()
				}
				minValues.append(required)
				minIndices.append(sampleIndex)
				while let first = minIndices.first, first <= sampleIndex - 2 * lookahead {
					minIndices.removeFirst()
					minValues.removeFirst()
				}
				let slidingMin = minValues.first ?? 1

				// Drop instantly, recover slowly. Staying <= slidingMin is what
				// preserves the no-overshoot guarantee.
				heldGain = slidingMin < heldGain
					? slidingMin
					: releaseCoefficient * heldGain + (1 - releaseCoefficient) * slidingMin

				boxcarSum += heldGain - boxcar[boxcarWrite]
				boxcar[boxcarWrite] = heldGain
				boxcarWrite = (boxcarWrite + 1) % lookahead

				let emitted = delayLine[delayWrite]
				delayLine[delayWrite] = value
				delayWrite = (delayWrite + 1) % lookahead
				sampleIndex += 1

				samples[index] = emitted * (boxcarSum / Float(lookahead))
			}
		}
	}

	/// Applies the export's limiter to one decoded float PCM buffer.
	static func softLimit(sampleBuffer: CMSampleBuffer) {
		guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
		var lengthAtOffset = 0
		var totalLength = 0
		var pointer: UnsafeMutablePointer<Int8>?
		guard CMBlockBufferGetDataPointer(
			block,
			atOffset: 0,
			lengthAtOffsetOut: &lengthAtOffset,
			totalLengthOut: &totalLength,
			dataPointerOut: &pointer
		) == kCMBlockBufferNoErr, let pointer else { return }

		let count = totalLength / MemoryLayout<Float>.size
		var observedPeak: Float = 0

		limiterStateLock.lock()
		if activeLimiter == nil {
			// 44100 matches the reader's AVSampleRateKey above. The limiter is
			// stateful across the whole stream (an export is one continuous
			// signal), and the sample interleaving is irrelevant to it: a peak
			// in either channel pulls both down together, which is what keeps
			// the stereo image from wandering under gain reduction.
			activeLimiter = LookaheadLimiter(sampleRate: 44100)
		}
		let limiter = activeLimiter
		limiterStateLock.unlock()

		pointer.withMemoryRebound(to: Float.self, capacity: count) { samples in
			for index in 0..<count { observedPeak = max(observedPeak, abs(samples[index])) }
			limiter?.process(samples: samples, count: count)
		}

		limiterStateLock.lock()
		limiterPeakSeen = max(limiterPeakSeen, observedPeak)
		limiterBuffersSeen += 1
		limiterStateLock.unlock()
	}

	/// Fresh limiter state per export — leftover gain reduction from a
	/// previous run would duck the first second of the next one.
	static func resetLimiter() {
		limiterStateLock.lock()
		activeLimiter = nil
		limiterPeakSeen = 0
		limiterBuffersSeen = 0
		limiterStateLock.unlock()
	}

	nonisolated(unsafe) static var activeLimiter: LookaheadLimiter?
	static let limiterStateLock = NSLock()

	nonisolated(unsafe) static var limiterPeakSeen: Float = 0
	nonisolated(unsafe) static var limiterBuffersSeen = 0

	private static func runPhase(
		reader: AVAssetReader,
		readerOutput: AVAssetReaderOutput,
		writerInput: AVAssetWriterInput,
		isAudio: Bool = false,
		handle: EdlExportHandle,
		queueLabel: String,
		progressWeight: Double?,
		totalSeconds: Double,
		onProgress: (@Sendable (Double) -> Void)?
	) async throws {
		try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
			var finished = false
			func finish(_ error: Error?) {
				if finished { return }
				finished = true
				if let error {
					continuation.resume(throwing: error)
				} else {
					continuation.resume()
				}
			}

			let queue = DispatchQueue(label: queueLabel)
			writerInput.requestMediaDataWhenReady(on: queue) {
				while writerInput.isReadyForMoreMediaData {
					if handle.isCancelled {
						writerInput.markAsFinished()
						finish(nil)
						return
					}
					if reader.status != .reading {
						writerInput.markAsFinished()
						finish(reader.status == .failed
							? EdlExportError.readerFailed(Self.describe(reader.error))
							: nil)
						return
					}
					guard let sampleBuffer = readerOutput.copyNextSampleBuffer() else {
						writerInput.markAsFinished()
						finish(reader.status == .failed
							? EdlExportError.readerFailed(Self.describe(reader.error))
							: nil)
						return
					}
						if isAudio { Self.softLimit(sampleBuffer: sampleBuffer) }
					guard writerInput.append(sampleBuffer) else {
						writerInput.markAsFinished()
						finish(EdlExportError.writerFailed("append failed"))
						return
					}
					if let progressWeight, totalSeconds > 0 {
						let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
						let fraction = min(0.97, (CMTimeGetSeconds(pts) / totalSeconds) * progressWeight)
						onProgress?(fraction)
					}
				}
			}
		}
	}
}
