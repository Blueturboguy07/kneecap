import Foundation
import AVFoundation
import CoreImage
import CoreMedia

/// kneecap M4 — hardware-accelerated preview-proxy transcode.
///
/// Plan Amendment 4 (§2.1) / M4 item 4: "on import, natively transcode a
/// downscaled, short-GOP (ideally near-all-intra) proxy; point the webview's
/// `VideoCache` at the proxy; keep the original untouched for native export."
/// This is the AVAssetReader → CoreImage → AVAssetWriterInputPixelBufferAdaptor
/// pipeline the plan names explicitly (M4 item 4) as the iOS shape of it —
/// `AVAssetWriter`'s H.264 encode runs on VideoToolbox under the hood; this
/// file just doesn't call VideoToolbox's C API directly because
/// `AVAssetWriter` already is that hardware path with a Swift-friendly
/// surface, which is why `AVVideoCompressionPropertiesKey` (not a raw
/// `VTCompressionSession` property) is where `AVVideoMaxKeyFrameIntervalKey`
/// (the short-GOP control) lives below.
///
/// Platform-agnostic (Foundation + AVFoundation + CoreImage only) for the
/// same reason as `MediaProbe.swift` — see its header comment.
public struct ProxySpec {
	/// Target short edge, px — mirrors
	/// `packages/native-bridge/src/types.ts`'s `ProxySpec.targetHeight`
	/// (plan Amendment 4 default: 540, phone preview).
	public var targetShortEdge: Int
	/// Frames between keyframes. Small == "near-all-intra", the scrub-latency
	/// mitigation the whole proxy pipeline exists for (plan §2.3/Amendment 4).
	public var shortGopInterval: Int

	public init(targetShortEdge: Int, shortGopInterval: Int) {
		self.targetShortEdge = targetShortEdge
		self.shortGopInterval = shortGopInterval
	}
}

public struct ProxyResult: Equatable {
	public var outputURL: URL
	public var width: Int
	public var height: Int
}

public enum ProxyTranscodeError: Error, CustomStringConvertible {
	case noVideoTrack
	case readerSetupFailed(String)
	case writerSetupFailed(String)
	case readerFailed(String)
	case writerFailed(String)

	public var description: String {
		switch self {
		case .noVideoTrack: return "source has no video track"
		case .readerSetupFailed(let m): return "reader setup failed: \(m)"
		case .writerSetupFailed(let m): return "writer setup failed: \(m)"
		case .readerFailed(let m): return "reader failed: \(m)"
		case .writerFailed(let m): return "writer failed: \(m)"
		}
	}
}

public enum ProxyTranscoder {
	/// Transcodes `sourceURL` to a downscaled, short-GOP H.264 proxy at
	/// `outputURL`. Video is decoded (hardware, via AVAssetReader), rotated
	/// upright and scaled (CoreImage, GPU-backed `CIContext`), then
	/// re-encoded (hardware, via AVAssetWriter/VideoToolbox). Audio is
	/// passed through undecoded (`outputSettings: nil` on both the reader
	/// output and writer input) — the proxy's entire reason to exist is
	/// fixing VIDEO scrub cost (plan §2.3's long-GOP random-access argument),
	/// audio decode was never the bottleneck, so re-encoding it would be
	/// pure waste.
	///
	/// Video and audio are drained **sequentially** (all video samples
	/// written and the video input marked finished, then all audio samples),
	/// not concurrently on two `requestMediaDataWhenReady` queues. This is a
	/// deliberate simplification for an offline (`expectsMediaDataInRealTime
	/// = false`) transcode: `AVAssetReader` supports pulling from multiple
	/// track outputs of the same reader in any order (each output demuxes
	/// independently), and `AVAssetWriter` only requires monotonic
	/// presentation timestamps *per input*, which sequential draining still
	/// satisfies. It trades a small amount of writer-side interleaving
	/// efficiency for avoiding a two-queue completion-race that is easy to
	/// get subtly wrong (e.g. calling `finishWriting()` before the slower of
	/// the two inputs has actually finished).
	public static func transcode(
		sourceURL: URL,
		outputURL: URL,
		spec: ProxySpec,
		onProgress: (@Sendable (Double) -> Void)? = nil
	) async throws -> ProxyResult {
		let asset = AVURLAsset(url: sourceURL)
		let duration = try await asset.load(.duration)
		let tracks = try await asset.load(.tracks)

		guard let videoTrack = tracks.first(where: { $0.mediaType == .video }) else {
			throw ProxyTranscodeError.noVideoTrack
		}
		let audioTrack = tracks.first(where: { $0.mediaType == .audio })

		let naturalSize = try await videoTrack.load(.naturalSize)
		let transform = try await videoTrack.load(.preferredTransform)
		let displaySize = naturalSize.applying(transform)
		let displayWidth = abs(displaySize.width)
		let displayHeight = abs(displaySize.height)
		let shortEdge = min(displayWidth, displayHeight)
		let scale: CGFloat = shortEdge > 0 ? min(1.0, CGFloat(spec.targetShortEdge) / shortEdge) : 1.0

		// H.264 4:2:0 requires even width/height.
		func evenDown(_ v: CGFloat) -> Int {
			let i = Int(v)
			return max(2, i - (i % 2))
		}
		let outW = evenDown(displayWidth * scale)
		let outH = evenDown(displayHeight * scale)

		if FileManager.default.fileExists(atPath: outputURL.path) {
			try FileManager.default.removeItem(at: outputURL)
		}
		try FileManager.default.createDirectory(
			at: outputURL.deletingLastPathComponent(),
			withIntermediateDirectories: true
		)

		// --- Reader ---
		let reader: AVAssetReader
		do {
			reader = try AVAssetReader(asset: asset)
		} catch {
			throw ProxyTranscodeError.readerSetupFailed(error.localizedDescription)
		}

		// Decode AT PROXY RESOLUTION via a video composition — never at
		// source resolution. The previous shape (AVAssetReaderTrackOutput
		// decoding full frames to 32BGRA + CoreImage downscale per frame)
		// held a 4K working set of ~33MB/frame uncompressed BGRA plus CI
		// intermediates, and on-device imports of real iPhone footage were
		// JETSAM-KILLED — Xcode: "killed by the operating system because it
		// is using too much memory" (founder's iPhone, 2026-08-19). With the
		// composition, VideoToolbox hands us upright, already-scaled ~540p
		// frames (~2MB) that are appended directly, no CoreImage at all.
		let frameRate = try await videoTrack.load(.nominalFrameRate)
		let composition = AVMutableVideoComposition()
		composition.renderSize = CGSize(width: outW, height: outH)
		composition.frameDuration = CMTime(
			value: 1,
			timescale: CMTimeScale(max(1, Int32(frameRate.rounded())))
		)
		let instruction = AVMutableVideoCompositionInstruction()
		instruction.timeRange = CMTimeRange(start: .zero, duration: duration)
		let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
		// Upright first (the same preferredTransform AVPlayer applies), then
		// scale display-space into the proxy's render size.
		layer.setTransform(
			transform.concatenating(CGAffineTransform(scaleX: scale, y: scale)),
			at: .zero
		)
		instruction.layerInstructions = [layer]
		composition.instructions = [instruction]

		let videoReaderOutput = AVAssetReaderVideoCompositionOutput(
			videoTracks: [videoTrack],
			videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
		)
		videoReaderOutput.videoComposition = composition
		videoReaderOutput.alwaysCopiesSampleData = false
		guard reader.canAdd(videoReaderOutput) else {
			throw ProxyTranscodeError.readerSetupFailed("cannot add video track output")
		}
		reader.add(videoReaderOutput)

		var audioReaderOutput: AVAssetReaderTrackOutput?
		if let audioTrack {
			// Decode to PCM — NOT nil-passthrough. Passthrough into an .mp4
			// writer input with nil outputSettings and no sourceFormatHint
			// makes `writer.canAdd` return false, and the guard below then
			// silently produced AUDIO-LESS proxies — every imported clip
			// played mute (found via the #/autotest audio probe, 2026-08-19:
			// getPrimaryAudioTrack() == null on the proxy itself). PCM in →
			// AAC out below is also robust to ANY source audio codec.
			let out = AVAssetReaderTrackOutput(
				track: audioTrack,
				outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM]
			)
			out.alwaysCopiesSampleData = false
			if reader.canAdd(out) {
				reader.add(out)
				audioReaderOutput = out
			}
		}

		// --- Writer ---
		let writer: AVAssetWriter
		do {
			writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
		} catch {
			throw ProxyTranscodeError.writerSetupFailed(error.localizedDescription)
		}

		let compressionProps: [String: Any] = [
			AVVideoAverageBitRateKey: estimateBitrate(width: outW, height: outH),
			AVVideoMaxKeyFrameIntervalKey: spec.shortGopInterval,
			AVVideoProfileLevelKey: AVVideoProfileLevelH264MainAutoLevel,
		]
		let videoWriterInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
			AVVideoCodecKey: AVVideoCodecType.h264,
			AVVideoWidthKey: outW,
			AVVideoHeightKey: outH,
			AVVideoCompressionPropertiesKey: compressionProps,
		])
		videoWriterInput.expectsMediaDataInRealTime = false

		let pixelBufferAttrs: [String: Any] = [
			kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
			kCVPixelBufferWidthKey as String: outW,
			kCVPixelBufferHeightKey as String: outH,
		]
		let adaptor = AVAssetWriterInputPixelBufferAdaptor(
			assetWriterInput: videoWriterInput,
			sourcePixelBufferAttributes: pixelBufferAttrs
		)
		guard writer.canAdd(videoWriterInput) else {
			throw ProxyTranscodeError.writerSetupFailed("cannot add video input")
		}
		writer.add(videoWriterInput)

		var audioWriterInput: AVAssetWriterInput?
		if audioReaderOutput != nil {
			// Real AAC encode of the PCM stream above (see the reader-side
			// comment for why passthrough silently produced mute proxies).
			let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
				AVFormatIDKey: kAudioFormatMPEG4AAC,
				AVSampleRateKey: 44_100,
				AVNumberOfChannelsKey: 2,
				AVEncoderBitRateKey: 128_000,
			])
			input.expectsMediaDataInRealTime = false
			if writer.canAdd(input) {
				writer.add(input)
				audioWriterInput = input
			} else {
				// Never silently drop audio again — this guard hiding a
				// failed add is exactly how the mute-proxy bug lived.
				throw ProxyTranscodeError.writerSetupFailed("cannot add AAC audio input")
			}
		}

		guard reader.startReading() else {
			throw ProxyTranscodeError.readerFailed(reader.error?.localizedDescription ?? "unknown")
		}
		guard writer.startWriting() else {
			throw ProxyTranscodeError.writerFailed(writer.error?.localizedDescription ?? "unknown")
		}
		writer.startSession(atSourceTime: .zero)

		let durationSeconds = max(duration.seconds, 0.001)
		print("[kneecap-mem] transcode start footprint=\(physFootprintMB())MB")

		// The two track loops MUST drain concurrently: AVAssetReader buffers
		// samples for every attached output, and an unconsumed output
		// eventually blocks the other's reads. The original sequential
		// video-then-audio order survived only because passthrough AAC
		// packets are tiny; with the audio output decoding to PCM (see
		// above) the buffer fills within seconds and the video phase crawls
		// to a stall (observed live: 27% after 4 minutes on a 6s clip,
		// #/autotest 2026-08-19). Concurrent draining is the standard
		// AVAssetWriter pattern.
		if let audioReaderOutput, let audioWriterInput {
			async let videoDone: Void = runVideoPhase(
				reader: reader,
				readerOutput: videoReaderOutput,
				writerInput: videoWriterInput,
				adaptor: adaptor,
				durationSeconds: durationSeconds,
				onProgress: onProgress
			)
			async let audioDone: Void = runAudioPhase(
				reader: reader,
				readerOutput: audioReaderOutput,
				writerInput: audioWriterInput
			)
			try await videoDone
			try await audioDone
		} else {
			try await runVideoPhase(
				reader: reader,
				readerOutput: videoReaderOutput,
				writerInput: videoWriterInput,
				adaptor: adaptor,
				durationSeconds: durationSeconds,
				onProgress: onProgress
			)
		}

		await writer.finishWriting()
		if writer.status != .completed {
			throw ProxyTranscodeError.writerFailed(
				writer.error?.localizedDescription ?? "writer ended in status \(writer.status.rawValue)"
			)
		}

		onProgress?(1.0)
		print("[kneecap-mem] transcode end footprint=\(physFootprintMB())MB")
		return ProxyResult(outputURL: outputURL, width: outW, height: outH)
	}

	/// Resident memory footprint in MB — the number jetsam judges. Logged
	/// around the transcode so a future on-device memory kill names its
	/// spike in the console instead of needing another guessing round
	/// (2026-08-19: real iPhone imports were jetsam-killed, invisible in
	/// the RAM-rich simulator).
	private static func physFootprintMB() -> Int {
		var info = task_vm_info_data_t()
		var count = mach_msg_type_number_t(
			MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size
		)
		let result = withUnsafeMutablePointer(to: &info) {
			$0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
				task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
			}
		}
		guard result == KERN_SUCCESS else { return -1 }
		return Int(info.phys_footprint / (1024 * 1024))
	}

	private static func runVideoPhase(
		reader: AVAssetReader,
		readerOutput: AVAssetReaderOutput,
		writerInput: AVAssetWriterInput,
		adaptor: AVAssetWriterInputPixelBufferAdaptor,
		durationSeconds: Double,
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

			let queue = DispatchQueue(label: "app.kneecap.proxy.video")
			writerInput.requestMediaDataWhenReady(on: queue) {
				while writerInput.isReadyForMoreMediaData {
					if reader.status != .reading {
						writerInput.markAsFinished()
						finish(reader.status == .failed
							? ProxyTranscodeError.readerFailed(reader.error?.localizedDescription ?? "unknown")
							: nil)
						return
					}
					guard let sampleBuffer = readerOutput.copyNextSampleBuffer() else {
						writerInput.markAsFinished()
						finish(reader.status == .failed
							? ProxyTranscodeError.readerFailed(reader.error?.localizedDescription ?? "unknown")
							: nil)
						return
					}
					// Frames arrive from AVAssetReaderVideoCompositionOutput
					// already upright and at the proxy's render size — append
					// directly. (The old per-frame CoreImage transform+render
					// at SOURCE resolution is what got the app jetsam-killed
					// on device — see the reader-setup comment.)
					guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { continue }
					let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
					_ = adaptor.append(imageBuffer, withPresentationTime: pts)

					if durationSeconds > 0 {
						onProgress?(min(0.999, CMTimeGetSeconds(pts) / durationSeconds))
					}
				}
			}
		}
	}

	private static func runAudioPhase(
		reader: AVAssetReader,
		readerOutput: AVAssetReaderTrackOutput,
		writerInput: AVAssetWriterInput
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

			let queue = DispatchQueue(label: "app.kneecap.proxy.audio")
			writerInput.requestMediaDataWhenReady(on: queue) {
				while writerInput.isReadyForMoreMediaData {
					if reader.status != .reading {
						writerInput.markAsFinished()
						finish(reader.status == .failed
							? ProxyTranscodeError.readerFailed(reader.error?.localizedDescription ?? "unknown")
							: nil)
						return
					}
					guard let sampleBuffer = readerOutput.copyNextSampleBuffer() else {
						writerInput.markAsFinished()
						finish(nil)
						return
					}
					_ = writerInput.append(sampleBuffer)
				}
			}
		}
	}

	/// A deliberately rough heuristic (~0.07 bit/pixel-frame at an assumed
	/// 30fps, clamped to a sane range) — this proxy is for scrubbing, not
	/// archival quality, and the plan's own success metric for it is scrub
	/// latency (M1 exit criterion #2), not bitrate efficiency.
	static func estimateBitrate(width: Int, height: Int) -> Int {
		let pixelsPerSecond = Double(width * height) * 30.0
		let bits = Int(pixelsPerSecond * 0.07)
		return min(max(bits, 500_000), 6_000_000)
	}
}
