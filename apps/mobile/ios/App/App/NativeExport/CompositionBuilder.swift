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

		let audioMix = AVMutableAudioMix()
		audioMix.inputParameters = audioRampInstructions + bgmMixParams

		let totalDurationTicks = placements.last?.insertEndTicks ?? 0

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
}

private extension Array {
	subscript(safe index: Int) -> Element? {
		indices.contains(index) ? self[index] : nil
	}
}
