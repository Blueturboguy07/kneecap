import Foundation
import AVFAudio

/// Native preview-audio router (2026-08-20). The device bisect proved this
/// phone's WKWebView renders WebAudio SILENTLY while reporting a running
/// context (web test tone inaudible), while native audio plays fine (native
/// test tone audible). So preview audio no longer goes through the webview
/// at all: the JS `AudioManager` hands the whole audible-clip schedule over
/// the bridge and this engine mixes it natively — the same architecture
/// commercial mobile editors use.
///
/// v1 scope, deliberately: flat per-clip volume (no animated gain curves),
/// constant per-clip rate via AVAudioUnitTimePitch, schedule rebuilt from
/// scratch on every play/seek (no incremental patching). Drift vs the JS
/// wall clock is uncorrected between seeks — negligible at preview
/// timescales and resynced on every transport action.
final class NativeAudioPreview {
	struct ClipSchedule {
		let path: String
		let startSec: Double
		let durationSec: Double
		let sourceOffsetSec: Double
		let volume: Double
		let rate: Double
	}

	private var engine: AVAudioEngine?
	private var players: [AVAudioPlayerNode] = []
	private let levelLock = NSLock()
	private var lastRms: Double = 0

	/** Running RMS of the mix output, for the #/autotest measured-signal
	 *  assertion (the native analogue of the WebAudio analyser tap). */
	var outputLevel: Double {
		levelLock.lock()
		defer { levelLock.unlock() }
		return lastRms
	}

	func stop() {
		for player in players {
			player.stop()
		}
		players = []
		if let engine {
			engine.mainMixerNode.removeTap(onBus: 0)
			engine.stop()
		}
		engine = nil
		levelLock.lock()
		lastRms = 0
		levelLock.unlock()
	}

	func start(clips: [ClipSchedule], atSec: Double) throws {
		stop()
		guard !clips.isEmpty else { return }

		#if os(iOS)
		try AVAudioSession.sharedInstance().setActive(true)
		#endif
		let engine = AVAudioEngine()
		self.engine = engine

		var scheduled: [(player: AVAudioPlayerNode, file: AVAudioFile, clip: ClipSchedule, playOffsetInClip: Double)] = []

		for clip in clips {
			let playOffsetInClip = max(0, atSec - clip.startSec)
			if playOffsetInClip >= clip.durationSec { continue }

			// AVAudioFile opens the audio track of mp4/mov movie files too
			// (ExtAudioFile under the hood) — the proxy needs no sidecar.
			let file: AVAudioFile
			do {
				file = try AVAudioFile(forReading: URL(fileURLWithPath: clip.path))
			} catch {
				print("[kneecap-audio] cannot open \(clip.path): \(error.localizedDescription)")
				continue
			}

			let player = AVAudioPlayerNode()
			engine.attach(player)

			var lastNode: AVAudioNode = player
			if abs(clip.rate - 1.0) > 0.001 {
				let timePitch = AVAudioUnitTimePitch()
				timePitch.rate = Float(clip.rate)
				engine.attach(timePitch)
				engine.connect(player, to: timePitch, format: file.processingFormat)
				lastNode = timePitch
			}
			engine.connect(lastNode, to: engine.mainMixerNode, format: file.processingFormat)
			player.volume = Float(max(0, min(2, clip.volume)))

			scheduled.append((player, file, clip, playOffsetInClip))
			players.append(player)
		}

		guard !scheduled.isEmpty else {
			self.engine = nil
			return
		}

		// Measured-signal tap (see `outputLevel`).
		let format = engine.mainMixerNode.outputFormat(forBus: 0)
		engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
			guard let self, let data = buffer.floatChannelData?[0] else { return }
			let frames = Int(buffer.frameLength)
			if frames == 0 { return }
			var sum: Double = 0
			for frame in 0..<frames {
				let value = Double(data[frame])
				sum += value * value
			}
			let rms = (sum / Double(frames)).squareRoot()
			self.levelLock.lock()
			self.lastRms = rms
			self.levelLock.unlock()
		}

		try engine.start()

		let outputSampleRate = engine.mainMixerNode.outputFormat(forBus: 0).sampleRate
		for (player, file, clip, playOffsetInClip) in scheduled {
			let fileRate = file.processingFormat.sampleRate
			let sourceStartSec = clip.sourceOffsetSec + playOffsetInClip * clip.rate
			let remainingClipSec = clip.durationSec - playOffsetInClip
			let sourceLengthSec = remainingClipSec * clip.rate

			let startFrame = AVAudioFramePosition(max(0, sourceStartSec) * fileRate)
			let availableFrames = max(0, file.length - startFrame)
			let frameCount = AVAudioFrameCount(min(Double(availableFrames), sourceLengthSec * fileRate))
			if frameCount == 0 { continue }

			player.scheduleSegment(file, startingFrame: startFrame, frameCount: frameCount, at: nil)

			let delaySec = max(0, clip.startSec - atSec)
			if delaySec > 0,
			   let renderTime = engine.mainMixerNode.lastRenderTime,
			   renderTime.isSampleTimeValid {
				// Anchor the future start on the LIVE render clock — a bare
				// sample-time AVAudioTime is meaningless without it.
				let startTime = AVAudioTime(
					sampleTime: renderTime.sampleTime + AVAudioFramePosition(delaySec * outputSampleRate),
					atRate: outputSampleRate
				)
				player.play(at: startTime)
			} else {
				player.play()
			}
		}
	}
}
