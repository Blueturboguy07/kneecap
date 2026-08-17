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
		resolveAssetURL: (EdlAsset) -> URL?,
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
		let videoComposition = try VideoCompositionBuilder.build(edl: built.remappedEdl, built: built)
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
			throw EdlExportError.readerSetupFailed(error.localizedDescription)
		}

		let videoTracks = composition.tracks(withMediaType: .video)
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

		let audioTracks = composition.tracks(withMediaType: .audio)
		var audioOutput: AVAssetReaderAudioMixOutput?
		if edl.output.includeAudio, !audioTracks.isEmpty {
			let out = AVAssetReaderAudioMixOutput(audioTracks: audioTracks, audioSettings: nil)
			out.audioMix = built.audioMix
			out.alwaysCopiesSampleData = false
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
			throw EdlExportError.writerSetupFailed(error.localizedDescription)
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

		guard reader.startReading() else {
			throw EdlExportError.readerFailed(reader.error?.localizedDescription ?? "unknown")
		}
		guard writer.startWriting() else {
			throw EdlExportError.writerFailed(writer.error?.localizedDescription ?? "unknown")
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

		await writer.finishWriting()
		if writer.status != .completed {
			try? FileManager.default.removeItem(at: outputURL)
			throw EdlExportError.writerFailed(writer.error?.localizedDescription ?? "writer ended in status \(writer.status.rawValue)")
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

	/// Shared drain loop for both the video and audio reader outputs —
	/// direct sample-buffer passthrough (`writerInput.append(sampleBuffer)`),
	/// no manual pixel-buffer rendering: the video composition already
	/// happened inside `AVAssetReaderVideoCompositionOutput` before this
	/// function ever sees a sample buffer.
	private static func runPhase(
		reader: AVAssetReader,
		readerOutput: AVAssetReaderOutput,
		writerInput: AVAssetWriterInput,
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
							? EdlExportError.readerFailed(reader.error?.localizedDescription ?? "unknown")
							: nil)
						return
					}
					guard let sampleBuffer = readerOutput.copyNextSampleBuffer() else {
						writerInput.markAsFinished()
						finish(reader.status == .failed
							? EdlExportError.readerFailed(reader.error?.localizedDescription ?? "unknown")
							: nil)
						return
					}
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
