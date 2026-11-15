import AVFoundation
import CoreMedia

/// kneecap M9 — EDL v1 -> `AVMutableComposition` (plan M9 item 1).
///
/// Platform-agnostic (Foundation + AVFoundation + CoreMedia only, no
/// UIKit/Capacitor) — same rationale as `NativeMedia/*.swift`: this compiles
/// unmodified into both the app target and `verify-export-pipeline`.
public struct BuiltComposition {
	public var composition: AVMutableComposition
	public var totalDurationTicks: Int64
	/// Main-track clips only, in `startTicks` order — the input to
	/// `VideoCompositionBuilder`.
	public var mainPlacements: [ClipPlacement]
	/// Which composition video track each main-track clip's media landed
	/// on (alternating, so adjacent transition-overlapping clips are never
	/// on the same track — `AVMutableCompositionTrack` rejects overlapping
	/// inserts on one track).
	public var mainTrackIDs: [String: CMPersistentTrackID]
	public var transitionWindows: [TransitionWindow]
	/// Which composition video track each overlay (PiP) VIDEO clip's media
	/// landed on — one lane per overlay track (clips within one overlay
	/// track never overlap each other). Image overlay clips have no lane;
	/// they become `.still` layers in `VideoCompositionBuilder`.
	public var overlayVideoTrackIDs: [String: CMPersistentTrackID]
	/// The PACER lane under main-track IMAGE segments (round 28): a still
	/// has no real media, and `AVAssetReaderVideoCompositionOutput` paces
	/// composed frames purely by its REQUIRED source tracks' samples — an
	/// instruction requiring nothing is never scheduled (a trailing photo
	/// truncated the export; a mid-timeline one would be skipped). This
	/// lane holds looped 64×64 black filler across every image segment and
	/// still instructions REQUIRE it; the compositor never reads its
	/// frames — they only drive the frame clock.
	public var stillPacerTrackID: CMPersistentTrackID?
	/// Output spans with NO main-track clip under them — before the first
	/// clip, or (the -11841 case) after the last one when a PiP overlay or
	/// audio clip runs longer. A video composition MUST cover its whole
	/// duration, so `VideoCompositionBuilder` emits a background-only
	/// instruction for each of these, paced by `stillPacerTrackID`.
	public var backgroundOnlyRanges: [CMTimeRange]
	public var audioMix: AVMutableAudioMix?
	/// The input EDL with every NON-main-track clip's `startTicks` (and
	/// `meta.durationTicks`) remapped through
	/// `MainTrackPlacement.buildNominalToOutputRemap` — see that function's
	/// doc comment. `VideoCompositionBuilder` (overlays) reads THIS
	/// document, never the caller's original one, so overlay timing stays
	/// in sync with a main track that transitions have compressed.
	public var remappedEdl: EdlDocument
}

public enum CompositionBuilderError: Error, CustomStringConvertible {
	case assetNotResolvable(String)
	case assetHasNoUsableTrack(String)
	case noMainTrack

	public var description: String {
		switch self {
		case .assetNotResolvable(let id): return "asset \"\(id)\" could not be resolved to a readable URL"
		case .assetHasNoUsableTrack(let id): return "asset \"\(id)\" has no video/audio track AVFoundation could read"
		case .noMainTrack: return "EDL has no main video track"
		}
	}
}

public enum CompositionBuilder {
	/// `resolveAssetURL` turns an `EdlAsset.sourceUri` into a real, locally
	/// readable `URL` — kept as an injected closure (not baked into this
	/// file) so the standalone verification harness can point every asset
	/// at the one bundled fixture regardless of what placeholder scheme a
	/// hand-authored test EDL's `sourceUri` uses, while the real Capacitor
	/// plugin points it at actual sandbox custody paths
	/// (`NativeBridgePlugin+Export.swift`).
	public static func build(
		edl: EdlDocument,
		resolveAssetURL: (EdlAsset) -> URL?
	) async throws -> BuiltComposition {
		let tps = edl.meta.ticksPerSecond
		let composition = AVMutableComposition()

		var assetById: [String: EdlAsset] = [:]
		for a in edl.assets { assetById[a.assetId] = a }
		var avAssetCache: [String: AVURLAsset] = [:]

		func loadAsset(_ assetId: String) throws -> AVURLAsset {
			if let cached = avAssetCache[assetId] { return cached }
			guard let edlAsset = assetById[assetId], let url = resolveAssetURL(edlAsset) else {
				throw CompositionBuilderError.assetNotResolvable(assetId)
			}
			let avAsset = AVURLAsset(url: url)
			avAssetCache[assetId] = avAsset
			return avAsset
		}

		guard let mainTrack = edl.tracks.first(where: { $0.kind == "main" && $0.trackType == "video" }) else {
			throw CompositionBuilderError.noMainTrack
		}
		let mainVideoClips = mainTrack.clips.filter { $0.kind == "video" || $0.kind == "image" }

		let (placements, windows) = try MainTrackPlacement.computePlacements(
			clips: mainVideoClips,
			transitions: edl.transitions
		)
		var placementByClipId: [String: ClipPlacement] = [:]
		for p in placements { placementByClipId[p.clipId] = p }
		let sortedMainClips = mainVideoClips.sorted { $0.startTicks < $1.startTicks }
		let remapBreakpoints = MainTrackPlacement.buildNominalToOutputRemap(
			nominalClipsSorted: sortedMainClips,
			windows: windows
		)
		func remapTick(_ t: Int64) -> Int64 {
			MainTrackPlacement.remapNominalTick(t, breakpoints: remapBreakpoints)
		}

		// Two alternating video (and paired audio) composition tracks —
		// see `MainTrackPlacement.swift`'s header for why alternating
		// tracks are required once transitions introduce overlap.
		let videoLaneA = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
		let videoLaneB = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
		let audioLaneA = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
		let audioLaneB = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
		guard let videoLaneA, let videoLaneB, let audioLaneA, let audioLaneB else {
			throw CompositionBuilderError.noMainTrack
		}

		var mainTrackIDs: [String: CMPersistentTrackID] = [:]
		var audioRampInstructions: [AVMutableAudioMixInputParameters] = []
		let audioParamsA = AVMutableAudioMixInputParameters(track: audioLaneA)
		let audioParamsB = AVMutableAudioMixInputParameters(track: audioLaneB)
		audioRampInstructions = [audioParamsA, audioParamsB]

		for (i, clip) in sortedMainClips.enumerated() {
			guard let placement = placementByClipId[clip.clipId], let assetId = clip.assetId else { continue }
			// IMAGE clips never open as AVURLAssets — a JPEG has no tracks
			// (-11828 "Cannot Open"/assetProperty_Tracks killed every export
			// containing a main-track photo, founder's device 2026-08-23).
			// They keep their placement (the timeline layout stands) but get
			// no composition lane: VideoCompositionBuilder decodes them once
			// as stills and the compositor renders them like PiP `.still`s.
			if clip.kind == "image" { continue }
			let avAsset = try loadAsset(assetId)
			let assetTracks = try await avAsset.load(.tracks)
			let videoTrack = assetTracks.first { $0.mediaType == .video }
			let audioTrack = assetTracks.first { $0.mediaType == .audio }
			guard videoTrack != nil || audioTrack != nil else {
				throw CompositionBuilderError.assetHasNoUsableTrack(assetId)
			}

			let lane = i % 2 == 0 ? videoLaneA : videoLaneB
			let audioLane = i % 2 == 0 ? audioLaneA : audioLaneB
			let audioParams = i % 2 == 0 ? audioParamsA : audioParamsB

			let sourceDurationTicks = max(0, clip.sourceEndTicks - clip.sourceStartTicks)
			let sourceRange = EdlTime.cmTimeRange(
				startTicks: clip.sourceStartTicks,
				durationTicks: sourceDurationTicks,
				ticksPerSecond: tps
			)
			let insertAt = EdlTime.cmTime(ticks: placement.insertStartTicks, ticksPerSecond: tps)
			let targetDuration = EdlTime.cmTime(ticks: placement.insertDurationTicks, ticksPerSecond: tps)

			if let videoTrack {
				try lane.insertTimeRange(sourceRange, of: videoTrack, at: insertAt)
				if sourceRange.duration != targetDuration, sourceRange.duration.seconds > 0 {
					let insertedRange = CMTimeRange(start: insertAt, duration: sourceRange.duration)
					lane.scaleTimeRange(insertedRange, toDuration: targetDuration)
				}
				lane.preferredTransform = try await videoTrack.load(.preferredTransform)
				mainTrackIDs[clip.clipId] = lane.trackID
			}

			if let audioTrack, !clip.muted {
				try audioLane.insertTimeRange(sourceRange, of: audioTrack, at: insertAt)
				if sourceRange.duration != targetDuration, sourceRange.duration.seconds > 0 {
					let insertedRange = CMTimeRange(start: insertAt, duration: sourceRange.duration)
					audioLane.scaleTimeRange(insertedRange, toDuration: targetDuration)
				}
				let linearVolume = Float(dbToLinear(clip.volumeDb))
				let soloRange = placement.soloRange
				let soloTimeRange = EdlTime.cmTimeRange(
					startTicks: soloRange.start,
					durationTicks: max(0, soloRange.end - soloRange.start),
					ticksPerSecond: tps
				)
				if soloTimeRange.duration.seconds > 0 {
					audioParams.setVolume(linearVolume, at: soloTimeRange.start)
				}
			}
		}

		// Cross-fade the AUDIO too across each transition window, matching
		// the video blend — an abrupt audio cut under a smooth visual
		// dissolve reads as a bug, not a design choice.
		for window in windows {
			guard let outgoingClip = sortedMainClips[safe: window.outgoingIndex],
				  let incomingClip = sortedMainClips[safe: window.incomingIndex] else { continue }
			let windowRange = EdlTime.cmTimeRange(
				startTicks: window.startTicks,
				durationTicks: window.durationTicks,
				ticksPerSecond: tps
			)
			if !outgoingClip.muted {
				let outVol = Float(dbToLinear(outgoingClip.volumeDb))
				audioParamsFor(index: window.outgoingIndex, a: audioParamsA, b: audioParamsB)
					.setVolumeRamp(fromStartVolume: outVol, toEndVolume: 0, timeRange: windowRange)
			}
			if !incomingClip.muted {
				let inVol = Float(dbToLinear(incomingClip.volumeDb))
				audioParamsFor(index: window.incomingIndex, a: audioParamsA, b: audioParamsB)
					.setVolumeRamp(fromStartVolume: 0, toEndVolume: inVol, timeRange: windowRange)
			}
		}

		// Background-music / secondary audio tracks (`kind == "audio"`):
		// no transitions apply off the main track in v1, so a plain
		// sequential insert per clip suffices.
		var bgmMixParams: [AVMutableAudioMixInputParameters] = []
		for track in edl.tracks where track.kind == "audio" {
			guard let compTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
			let params = AVMutableAudioMixInputParameters(track: compTrack)
			for clip in track.clips where clip.kind == "audio" {
				guard let assetId = clip.assetId, !clip.muted else { continue }
				let avAsset = try loadAsset(assetId)
				let assetTracks = try await avAsset.load(.tracks)
				guard let audioTrack = assetTracks.first(where: { $0.mediaType == .audio }) else { continue }
				let sourceDurationTicks = max(0, clip.sourceEndTicks - clip.sourceStartTicks)
				let sourceRange = EdlTime.cmTimeRange(
					startTicks: clip.sourceStartTicks,
					durationTicks: sourceDurationTicks,
					ticksPerSecond: tps
				)
				let insertAt = EdlTime.cmTime(ticks: remapTick(clip.startTicks), ticksPerSecond: tps)
				try compTrack.insertTimeRange(sourceRange, of: audioTrack, at: insertAt)
				let targetDuration = EdlTime.cmTime(ticks: clip.durationTicks, ticksPerSecond: tps)
				if sourceRange.duration != targetDuration, sourceRange.duration.seconds > 0 {
					compTrack.scaleTimeRange(CMTimeRange(start: insertAt, duration: sourceRange.duration), toDuration: targetDuration)
				}
				params.setVolume(Float(dbToLinear(clip.volumeDb)), at: insertAt)
			}
			bgmMixParams.append(params)
		}

		// Overlay (PiP) VIDEO clips — round 19: one composition video lane per
		// overlay video track, frames composited by EdlTransitionCompositor
		// with the same SourcePlacement math as the main track. Audio rides
		// along unless the clip is muted. Timing goes through the SAME
		// remapTick the other non-main tracks use, so PiP stays in sync with
		// a transition-compressed main track.
		var overlayVideoTrackIDs: [String: CMPersistentTrackID] = [:]
		var overlayAudioParams: [AVMutableAudioMixInputParameters] = []
		for track in edl.tracks where track.kind == "overlay" && track.trackType == "video" {
			let videoClips = track.clips.filter { $0.kind == "video" && !$0.hidden }
			guard !videoClips.isEmpty else { continue }
			guard let lane = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
			var audioLane: AVMutableCompositionTrack?
			var audioParams: AVMutableAudioMixInputParameters?

			for clip in videoClips {
				guard let assetId = clip.assetId else { continue }
				let avAsset = try loadAsset(assetId)
				let assetTracks = try await avAsset.load(.tracks)
				guard let videoTrack = assetTracks.first(where: { $0.mediaType == .video }) else { continue }

				let sourceDurationTicks = max(0, clip.sourceEndTicks - clip.sourceStartTicks)
				let sourceRange = EdlTime.cmTimeRange(
					startTicks: clip.sourceStartTicks,
					durationTicks: sourceDurationTicks,
					ticksPerSecond: tps
				)
				let insertAt = EdlTime.cmTime(ticks: remapTick(clip.startTicks), ticksPerSecond: tps)
				let targetDuration = EdlTime.cmTime(ticks: clip.durationTicks, ticksPerSecond: tps)

				try lane.insertTimeRange(sourceRange, of: videoTrack, at: insertAt)
				if sourceRange.duration != targetDuration, sourceRange.duration.seconds > 0 {
					lane.scaleTimeRange(CMTimeRange(start: insertAt, duration: sourceRange.duration), toDuration: targetDuration)
				}
				overlayVideoTrackIDs[clip.clipId] = lane.trackID

				if !clip.muted, let audioTrack = assetTracks.first(where: { $0.mediaType == .audio }) {
					if audioLane == nil {
						audioLane = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
						if let audioLane { audioParams = AVMutableAudioMixInputParameters(track: audioLane) }
					}
					if let audioLane, let audioParams {
						try audioLane.insertTimeRange(sourceRange, of: audioTrack, at: insertAt)
						if sourceRange.duration != targetDuration, sourceRange.duration.seconds > 0 {
							audioLane.scaleTimeRange(CMTimeRange(start: insertAt, duration: sourceRange.duration), toDuration: targetDuration)
						}
						audioParams.setVolume(Float(dbToLinear(clip.volumeDb)), at: insertAt)
					}
				}
			}
			if let audioParams { overlayAudioParams.append(audioParams) }
		}

		let audioMix = AVMutableAudioMix()
		audioMix.inputParameters = audioRampInstructions + bgmMixParams + overlayAudioParams

		// PACER + COVERAGE lane (round 28, extended round 32).
		//
		// Two jobs, both about AVFoundation's own rules, and both needing to
		// run AFTER every track insert (the composition's duration is only
		// final here):
		//
		//  1. PACING — `AVAssetReaderVideoCompositionOutput` schedules an
		//     instruction only while its REQUIRED tracks have samples. A
		//     main-track IMAGE segment has no lane (a JPEG can't open as an
		//     AVURLAsset), so without filler under it the segment is never
		//     composed (a trailing photo truncated the export; sim 2026-08-23).
		//
		//  2. COVERAGE — a video composition whose instructions do not cover
		//     the composition's ENTIRE duration is rejected outright with
		//     AVErrorInvalidVideoComposition (-11841). Instructions come from
		//     MAIN-track placements only, but the composition's duration is
		//     the max across ALL tracks: one PiP overlay or audio clip
		//     extending past the last main clip left the tail uncovered and
		//     killed the whole export (founder's device, 2026-08-23). Same for
		//     any gap before the first main clip.
		//
		// Both are solved the same way: looped ~1s 64×64 black filler, at the
		// export frame rate, in a dedicated lane, required by the
		// instructions that have no real source. The compositor never reads
		// its frames — they only drive the frame clock; uncovered spans
		// render as canvas background.
		var stillPacerTrackID: CMPersistentTrackID?
		var backgroundOnlyRanges: [CMTimeRange] = []
		let imageRanges: [CMTimeRange] = sortedMainClips.compactMap { clip in
			guard clip.kind == "image", let placement = placementByClipId[clip.clipId] else { return nil }
			return EdlTime.cmTimeRange(
				startTicks: placement.insertStartTicks,
				durationTicks: placement.insertDurationTicks,
				ticksPerSecond: tps
			)
		}
		let compositionEnd = composition.duration
		if compositionEnd.isValid, compositionEnd.isNumeric, compositionEnd > .zero {
			// Uncovered = [0, compositionEnd] minus the main placements'
			// output ranges (which are contiguous and ascending by
			// construction — MainTrackPlacement lays them end to end).
			var cursor = CMTime.zero
			for placement in placements.sorted(by: { $0.insertStartTicks < $1.insertStartTicks }) {
				let segStart = EdlTime.cmTime(ticks: placement.insertStartTicks, ticksPerSecond: tps)
				let segEnd = EdlTime.cmTime(
					ticks: placement.insertStartTicks + placement.insertDurationTicks,
					ticksPerSecond: tps
				)
				if segStart > cursor {
					backgroundOnlyRanges.append(CMTimeRange(start: cursor, end: segStart))
				}
				cursor = CMTimeMaximum(cursor, segEnd)
			}
			if cursor < compositionEnd {
				backgroundOnlyRanges.append(CMTimeRange(start: cursor, end: compositionEnd))
			}
		}

		let pacerRanges = imageRanges + backgroundOnlyRanges
		if !pacerRanges.isEmpty {
			guard let pacerLane = composition.addMutableTrack(
				withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
				throw CompositionBuilderError.noMainTrack
			}
			// Filler at the OUTPUT frame rate: the reader emits still and
			// background frames at the filler's cadence, so a 30 fps filler
			// gave a 60 fps export only 30 still frames per second.
			let filler = try await Self.blackFillerAsset(
				frameDuration: EdlTime.frameDuration(fps: edl.output.fps)
			)
			let fillerTracks = try await filler.load(.tracks)
			guard let fillerTrack = fillerTracks.first(where: { $0.mediaType == .video }) else {
				throw CompositionBuilderError.noMainTrack
			}
			let fillerDuration = try await filler.load(.duration)
			for range in pacerRanges.sorted(by: { $0.start < $1.start }) {
				var cursor = range.start
				while cursor < range.end {
					let chunk = CMTimeMinimum(fillerDuration, CMTimeSubtract(range.end, cursor))
					guard chunk > .zero else { break }
					try pacerLane.insertTimeRange(
						CMTimeRange(start: .zero, duration: chunk),
						of: fillerTrack,
						at: cursor
					)
					cursor = CMTimeAdd(cursor, chunk)
				}
			}
			stillPacerTrackID = pacerLane.trackID
			print("[kneecap-export] pacer lane \(pacerLane.trackID): \(imageRanges.count) still segment(s), \(backgroundOnlyRanges.count) uncovered span(s); composition=\(compositionEnd.seconds)s")
		}

		// DROP LANES WITH NO MEDIA. Both main video lanes and both main audio
		// lanes are always created, so a project with only photos (or only
		// muted or silent clips) leaves every audio track empty. A reader
		// that mixes only empty audio tracks fails in startReading with
		// -11800 (underlying -12710), which the app showed as "reader failed:
		// The operation could not be completed". No lane ID is recorded
		// before a real insert, so no instruction refers to a removed lane.
		let emptyTracks = composition.tracks.filter { !Self.hasMedia($0) }
		for track in emptyTracks {
			composition.removeTrack(track)
		}
		let liveTrackIDs = Set(composition.tracks.map(\.trackID))
		audioMix.inputParameters = audioMix.inputParameters.filter { liveTrackIDs.contains($0.trackID) }
		print("[kneecap-export] composition tracks: \(composition.tracks(withMediaType: .video).count) video, \(composition.tracks(withMediaType: .audio).count) audio (\(emptyTracks.count) empty lane(s) removed)")

		// The WHOLE timeline, not just the main track (round 32): a PiP
		// overlay or audio clip may run past the last main clip, and the
		// preview plays that tail (editor-core's calculateTotalDuration spans
		// every track), so the export must too — trailing audio over the
		// canvas background, the common mobile-editor behavior. Using the main-track end
		// here truncated those exports and made the output-integrity re-probe
		// disagree with the file it had just written.
		let mainEndTicks = placements.last?.insertEndTicks ?? 0
		let compositionEndTicks =
			compositionEnd.isValid && compositionEnd.isNumeric
				? Int64((compositionEnd.seconds * Double(tps)).rounded())
				: 0
		let totalDurationTicks = max(mainEndTicks, compositionEndTicks)

		var remappedTracks: [EdlTrack] = []
		for track in edl.tracks {
			if track.kind == "main" {
				remappedTracks.append(track)
				continue
			}
			var remappedTrack = track
			remappedTrack.clips = track.clips.map { clip in
				var c = clip
				c.startTicks = remapTick(clip.startTicks)
				return c
			}
			remappedTracks.append(remappedTrack)
		}
		var remappedMeta = edl.meta
		remappedMeta.durationTicks = totalDurationTicks
		var remappedOverlays: [EdlOverlay] = []
		for overlay in edl.overlays {
			var o = overlay
			o.startTicks = remapTick(overlay.startTicks)
			remappedOverlays.append(o)
		}
		let remappedEdl = EdlDocument(
			schema: edl.schema,
			meta: remappedMeta,
			assets: edl.assets,
			tracks: remappedTracks,
			transitions: edl.transitions,
			overlays: remappedOverlays,
			output: edl.output
		)

		return BuiltComposition(
			composition: composition,
			totalDurationTicks: totalDurationTicks,
			mainPlacements: placements,
			mainTrackIDs: mainTrackIDs,
			transitionWindows: windows,
			overlayVideoTrackIDs: overlayVideoTrackIDs,
			stillPacerTrackID: stillPacerTrackID,
			backgroundOnlyRanges: backgroundOnlyRanges,
			audioMix: audioMix,
			remappedEdl: remappedEdl
		)
	}

	private static func audioParamsFor(
		index: Int,
		a: AVMutableAudioMixInputParameters,
		b: AVMutableAudioMixInputParameters
	) -> AVMutableAudioMixInputParameters {
		index % 2 == 0 ? a : b
	}

	static func dbToLinear(_ db: Double) -> Double {
		pow(10.0, db / 20.0)
	}

	/// True when the track holds at least one real (non-empty) segment.
	static func hasMedia(_ track: AVCompositionTrack) -> Bool {
		track.segments.contains { !$0.isEmpty }
	}

	/// A ~1s, 64×64 black H.264 clip synthesized once per process and frame
	/// rate, used ONLY as pacer filler under stills and uncovered spans (see
	/// the pacer block above). Its frames are never composited; they only
	/// set the frame clock, so it is written at the export frame duration.
	private static let fillerCacheLock = NSLock()
	nonisolated(unsafe) private static var cachedFillerURLs: [String: URL] = [:]

	private static func cachedFillerURL(key: String) -> URL? {
		fillerCacheLock.lock()
		defer { fillerCacheLock.unlock() }
		return cachedFillerURLs[key]
	}

	private static func storeFillerURL(_ url: URL, key: String) {
		fillerCacheLock.lock()
		defer { fillerCacheLock.unlock() }
		cachedFillerURLs[key] = url
	}

	static func blackFillerAsset(frameDuration requested: CMTime = CMTime(value: 1, timescale: 30)) async throws -> AVURLAsset {
		// Any frame duration from 1/240 s to 1 s; anything else falls back to 30 fps.
		let frameDuration: CMTime =
			requested.isValid && requested.isNumeric && requested.seconds >= 1.0 / 240 && requested.seconds <= 1
				? requested
				: CMTime(value: 1, timescale: 30)
		let frameCount = max(1, Int((1.0 / frameDuration.seconds).rounded(.up)))
		let key = "\(frameDuration.value)x\(frameDuration.timescale)"

		if let cached = cachedFillerURL(key: key), FileManager.default.fileExists(atPath: cached.path) {
			return AVURLAsset(url: cached)
		}
		let url = FileManager.default.temporaryDirectory
			.appendingPathComponent("kneecap-black-filler-\(ProcessInfo.processInfo.processIdentifier)-\(key).mp4")
		try? FileManager.default.removeItem(at: url)

		let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
		let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
			AVVideoCodecKey: AVVideoCodecType.h264,
			AVVideoWidthKey: 64,
			AVVideoHeightKey: 64,
		])
		input.expectsMediaDataInRealTime = false
		let adaptor = AVAssetWriterInputPixelBufferAdaptor(
			assetWriterInput: input,
			sourcePixelBufferAttributes: [
				kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
				kCVPixelBufferWidthKey as String: 64,
				kCVPixelBufferHeightKey as String: 64,
			]
		)
		guard writer.canAdd(input) else {
			throw CompositionBuilderError.noMainTrack
		}
		writer.add(input)
		guard writer.startWriting() else {
			throw writer.error ?? CompositionBuilderError.noMainTrack
		}
		writer.startSession(atSourceTime: .zero)

		var pixelBuffer: CVPixelBuffer?
		CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_32BGRA, nil, &pixelBuffer)
		guard let buffer = pixelBuffer else {
			throw CompositionBuilderError.noMainTrack
		}
		CVPixelBufferLockBaseAddress(buffer, [])
		if let base = CVPixelBufferGetBaseAddress(buffer) {
			memset(base, 0, CVPixelBufferGetDataSize(buffer))
		}
		CVPixelBufferUnlockBaseAddress(buffer, [])

		// About 1s of frames — real sample density matters: the reader's
		// composed-frame cadence follows source sample timing.
		for frame in 0..<frameCount {
			while !input.isReadyForMoreMediaData {
				try await Task.sleep(nanoseconds: 5_000_000)
			}
			let time = CMTimeMultiply(frameDuration, multiplier: Int32(frame))
			guard adaptor.append(buffer, withPresentationTime: time) else {
				writer.cancelWriting()
				throw writer.error ?? CompositionBuilderError.noMainTrack
			}
		}
		input.markAsFinished()
		await writer.finishWriting()
		if let error = writer.error { throw error }
		storeFillerURL(url, key: key)
		return AVURLAsset(url: url)
	}
}

private extension Array {
	subscript(safe index: Int) -> Element? {
		indices.contains(index) ? self[index] : nil
	}
}
