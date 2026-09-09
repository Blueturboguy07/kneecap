import AVFoundation
import CoreGraphics
import CoreImage
import ImageIO

/// kneecap M9 — assembles the `AVMutableVideoComposition` from a
/// `BuiltComposition` (plan M9 items 1-3): renders every main-track segment
/// through `EdlTransitionCompositor` (transitions + the one wired v1
/// effect), then layers text/sticker overlays on top via
/// `AVVideoCompositionCoreAnimationTool`.
/// A text/caption overlay image rendered by the PREVIEW's own drawing code
/// (`editor-core/export/overlay-frames.ts`), covering one span of the
/// output timeline. Full-frame and already at the export resolution, so
/// the compositor draws it 1:1 with no geometry of its own — which is the
/// whole point: there is no second implementation left to disagree.
public struct PrerenderedOverlayFrame {
	public var startTicks: Int64
	public var endTicks: Int64
	public var image: CIImage

	public init(startTicks: Int64, endTicks: Int64, image: CIImage) {
		self.startTicks = startTicks
		self.endTicks = endTicks
		self.image = image
	}
}

public enum VideoCompositionBuilderError: Error, CustomStringConvertible {
	case emptyTimeline
	public var description: String { "EDL produced an empty main-track timeline (no clips, or all zero-duration)" }
}

public enum VideoCompositionBuilder {
	/// `edl` here is EXPECTED to be `BuiltComposition.remappedEdl`, not the
	/// caller's original document — overlay-track clip timing has already
	/// been shifted to match the (transition-compressed) main-track output
	/// timeline; see `CompositionBuilder.swift`'s `remappedEdl` doc comment
	/// and `MainTrackPlacement.buildNominalToOutputRemap`. The main track
	/// itself is untouched by remapping (only non-main tracks are), so
	/// reading `effects`/`clipById` off it here is safe either way.
	public static func build(
		edl: EdlDocument,
		built: BuiltComposition,
		resolveAssetURL: ((EdlAsset) -> URL?)? = nil,
		overlayFrames: [PrerenderedOverlayFrame] = []
	) throws -> AVMutableVideoComposition {
		guard built.totalDurationTicks > 0, !built.mainPlacements.isEmpty else {
			throw VideoCompositionBuilderError.emptyTimeline
		}
		let tps = edl.meta.ticksPerSecond

		guard let mainTrack = edl.tracks.first(where: { $0.kind == "main" && $0.trackType == "video" }) else {
			throw VideoCompositionBuilderError.emptyTimeline
		}
		var clipById: [String: EdlClip] = [:]
		for c in mainTrack.clips { clipById[c.clipId] = c }
		var assetById: [String: EdlAsset] = [:]
		for a in edl.assets { assetById[a.assetId] = a }

		func enabledAdjust(_ clipId: String) -> AdjustSettings? {
			guard let clip = clipById[clipId] else { return nil }
			guard let fx = clip.effects.first(where: { $0.type == "adjust" && $0.enabled }) else { return nil }
			let value = { (key: String) -> Double in fx.params[key]?.asDouble ?? 0 }
			let settings = AdjustSettings(
				brightness: value("brightness"),
				contrast: value("contrast"),
				saturation: value("saturation"),
				temperature: value("temperature"),
				tint: value("tint"),
				sharpen: value("sharpen"),
				vignette: value("vignette")
			)
			return settings.isNeutral ? nil : settings
		}

		func enabledBrightness(_ clipId: String) -> Double? {
			guard let clip = clipById[clipId] else { return nil }
			guard let fx = clip.effects.first(where: { $0.type == "brightness" && $0.enabled }) else { return nil }
			let amount = fx.params["amount"]?.asDouble ?? 0
			return max(-1, min(1, amount))
		}

		// Round 47: keyframe times are clip-local; a main-track clip's local
		// zero is where the composition actually placed it (`insertStartTicks`
		// — earlier than nominal `startTicks` after a transition), not the
		// EDL's nominal start.
		var insertStartByClipId: [String: Int64] = [:]
		for placement in built.mainPlacements { insertStartByClipId[placement.clipId] = placement.insertStartTicks }

		/// Preview-parity source placement for a main-track clip: its EDL
		/// transform plus the asset's container rotation (the compositor gets
		/// RAW decoded buffers — `preferredTransform` does not apply there),
		/// plus its keyframe channels when it has any (round 47).
		func sourcePlacement(_ clipId: String) -> SourcePlacement {
			guard let clip = clipById[clipId] else { return .identity }
			let rotation = clip.assetId.flatMap { assetById[$0]?.rotationDegrees } ?? 0
			return SourcePlacement(
				transform: clip.transform,
				rotationDegrees: rotation,
				opacity: clip.opacity,
				animation: PlacementAnimation.make(clip: clip, clipStartTicks: insertStartByClipId[clipId] ?? clip.startTicks)
			)
		}

		// Canvas background behind every placed frame — flat EDL color, or
		// opaque black for any background type v1 cannot reproduce natively.
		let backgroundColor: CIColor = {
			guard edl.meta.background.type == "color",
				  let hex = edl.meta.background.color,
				  let parsed = Self.ciColor(fromHex: hex) else {
				return CIColor(red: 0, green: 0, blue: 0, alpha: 1)
			}
			return parsed
		}()

		// --- Overlay (PiP) layers: video via their composition lanes, images
		// as build-time-decoded stills; both placed by the compositor with
		// the main track's own SourcePlacement math. Ascending zIndex ==
		// composite order (higher on top), matching OverlayLayerBuilder. ---
		var pipLayers: [OverlayVideoLayer] = []
		for track in edl.tracks where track.kind == "overlay" && track.trackType == "video" {
			for clip in track.clips where !clip.hidden {
				guard let assetId = clip.assetId else { continue }
				let rotation = assetById[assetId]?.rotationDegrees ?? 0
				let placement = SourcePlacement(
					transform: clip.transform,
					rotationDegrees: rotation,
					opacity: clip.opacity,
					// Overlay clips in `edl` are already remapped to OUTPUT time
					// (this is `built.remappedEdl`), so their startTicks is local zero.
					animation: PlacementAnimation.make(clip: clip, clipStartTicks: clip.startTicks)
				)
				let range = EdlTime.cmTimeRange(
					startTicks: clip.startTicks,
					durationTicks: clip.durationTicks,
					ticksPerSecond: tps
				)
				let source: OverlayVideoLayer.Source
				if clip.kind == "video" {
					guard let trackID = built.overlayVideoTrackIDs[clip.clipId] else { continue }
					source = .track(trackID)
				} else if clip.kind == "image" {
					guard let edlAsset = assetById[assetId],
						  let url = resolveAssetURL?(edlAsset),
						  let still = Self.loadStillImage(url: url) else {
						print("[kneecap-export] image overlay clip \(clip.clipId): asset unreadable, skipped")
						continue
					}
					source = .still(still)
				} else {
					continue
				}
				pipLayers.append(OverlayVideoLayer(
					source: source,
					placement: placement,
					timeRange: range,
					zIndex: track.zIndex ?? 0
				))
			}
		}
		pipLayers.sort { $0.zIndex < $1.zIndex }

		func pipLayersIntersecting(_ range: CMTimeRange) -> [OverlayVideoLayer] {
			pipLayers.filter { $0.timeRange.intersection(range).duration.seconds > 0 }
		}

		// --- Text/sticker/caption billboards (round 23): pre-rasterized and
		// composited per-frame by the custom compositor, exactly like PiP.
		// The old AVVideoCompositionCoreAnimationTool path was DEAD CODE —
		// AVFoundation ignores the animation tool when
		// `customVideoCompositorClass` is set, so CALayer overlays never
		// rendered in any export (see OverlayLayerBuilder's header). ---
		let billboardRenderSize = CGSize(
			width: edl.output.resolution.width,
			height: edl.output.resolution.height
		)
		// Prerendered (preview-drawn) overlays win when supplied; the native
		// CoreText rasterizer stays as the fallback for callers that don't
		// send them (the standalone verify harness, older shells).
		let billboards: [OverlayBillboard] =
			overlayFrames.isEmpty
				? OverlayLayerBuilder.buildBillboards(edl: edl, renderSize: billboardRenderSize)
				: overlayFrames.map { frame in
					OverlayBillboard(
						states: [OverlayBillboardState(startSeconds: 0, image: frame.image)],
						// Full frame, 1:1 — the image IS the output-resolution
						// overlay layer, so no placement math applies.
						rect: CGRect(origin: .zero, size: billboardRenderSize),
						opacity: 1,
						timeRange: EdlTime.cmTimeRange(
							startTicks: frame.startTicks,
							durationTicks: frame.endTicks - frame.startTicks,
							ticksPerSecond: tps
						),
						zIndex: Int.max
					)
				}

		func billboardsIntersecting(_ range: CMTimeRange) -> [OverlayBillboard] {
			billboards.filter { $0.timeRange.intersection(range).duration.seconds > 0 }
		}

		// --- Main-track IMAGE clips (round 28): no composition lane exists
		// for them (CompositionBuilder skips stills — a JPEG can't open as
		// an AVURLAsset), so their segments render from a build-time-decoded
		// CIImage, the same way PiP image overlays already work. Decoded
		// lazily, once per clip. An unreadable image logs and renders as
		// canvas background instead of failing the export. ---
		var mainClipById: [String: EdlClip] = [:]
		for track in edl.tracks where track.kind == "main" {
			for clip in track.clips { mainClipById[clip.clipId] = clip }
		}
		var mainStillCache: [String: CIImage?] = [:]
		func mainStill(_ clipId: String) -> CIImage? {
			if let cached = mainStillCache[clipId] { return cached }
			var still: CIImage? = nil
			if let clip = mainClipById[clipId], clip.kind == "image",
			   let assetId = clip.assetId, let edlAsset = assetById[assetId],
			   let url = resolveAssetURL?(edlAsset) {
				still = Self.loadStillImage(url: url)
			}
			if still == nil {
				print("[kneecap-export] main-track image clip \(clipId): asset unreadable, rendering background")
			}
			mainStillCache[clipId] = still
			return still
		}

		// --- Build the sorted, contiguous instruction segments ---
		struct Segment {
			var startTicks: Int64
			var endTicks: Int64
			var instruction: EdlVideoCompositionInstruction
		}
		var segments: [Segment] = []

		for placement in built.mainPlacements {
			let solo = placement.soloRange
			guard solo.end > solo.start else { continue }
			let trackID = built.mainTrackIDs[placement.clipId]
			let still = trackID == nil ? mainStill(placement.clipId) : nil
			let range = EdlTime.cmTimeRange(startTicks: solo.start, durationTicks: solo.end - solo.start, ticksPerSecond: tps)
			let instruction = EdlVideoCompositionInstruction(
				timeRange: range,
				primaryTrackID: trackID ?? kCMPersistentTrackID_Invalid,
				primaryStill: still,
				pacerTrackID:
					still != nil
						? (built.stillPacerTrackID ?? kCMPersistentTrackID_Invalid)
						: kCMPersistentTrackID_Invalid,
				primaryBrightness: enabledBrightness(placement.clipId),
				primaryAdjust: enabledAdjust(placement.clipId),
				primaryPlacement: sourcePlacement(placement.clipId),
				backgroundColor: backgroundColor,
				overlayVideoLayers: pipLayersIntersecting(range),
				overlayBillboards: billboardsIntersecting(range),
				ticksPerSecond: tps
			)
			segments.append(Segment(startTicks: solo.start, endTicks: solo.end, instruction: instruction))
		}

		let sortedClipIds = built.mainPlacements.map(\.clipId)
		for window in built.transitionWindows {
			guard window.outgoingIndex < sortedClipIds.count, window.incomingIndex < sortedClipIds.count else { continue }
			let outgoingId = sortedClipIds[window.outgoingIndex]
			let incomingId = sortedClipIds[window.incomingIndex]
			// Either side of a transition may be a still (image clip): its
			// track ID stays invalid and the frame comes from primaryStill/
			// secondaryStill instead — the blend path is source-agnostic.
			let primaryTrackID = built.mainTrackIDs[outgoingId]
			let secondaryTrackID = built.mainTrackIDs[incomingId]
			let primaryStill = primaryTrackID == nil ? mainStill(outgoingId) : nil
			let secondaryStill = secondaryTrackID == nil ? mainStill(incomingId) : nil
			let range = EdlTime.cmTimeRange(startTicks: window.startTicks, durationTicks: window.durationTicks, ticksPerSecond: tps)
			let instruction = EdlVideoCompositionInstruction(
				timeRange: range,
				primaryTrackID: primaryTrackID ?? kCMPersistentTrackID_Invalid,
				secondaryTrackID: secondaryTrackID ?? kCMPersistentTrackID_Invalid,
				primaryStill: primaryStill,
				secondaryStill: secondaryStill,
				pacerTrackID:
					primaryStill != nil || secondaryStill != nil
						? (built.stillPacerTrackID ?? kCMPersistentTrackID_Invalid)
						: kCMPersistentTrackID_Invalid,
				transitionWindowStart: range.start,
				transitionWindowDuration: range.duration,
				transitionKind: window.kind,
				primaryBrightness: enabledBrightness(outgoingId),
				secondaryBrightness: enabledBrightness(incomingId),
				primaryAdjust: enabledAdjust(outgoingId),
				secondaryAdjust: enabledAdjust(incomingId),
				primaryPlacement: sourcePlacement(outgoingId),
				secondaryPlacement: sourcePlacement(incomingId),
				backgroundColor: backgroundColor,
				overlayVideoLayers: pipLayersIntersecting(range),
				overlayBillboards: billboardsIntersecting(range),
				ticksPerSecond: tps
			)
			segments.append(Segment(startTicks: window.startTicks, endTicks: window.endTicks, instruction: instruction))
		}

		// Background-only instructions for spans with no main clip under them
		// (round 32): a video composition whose instructions don't cover its
		// FULL duration is rejected with AVErrorInvalidVideoComposition
		// (-11841) — which is exactly what a PiP overlay or audio clip
		// running past the last main clip produced on the founder's device.
		// These render the canvas background and are paced by the filler lane
		// (see BuiltComposition.backgroundOnlyRanges / stillPacerTrackID).
		for range in built.backgroundOnlyRanges {
			guard range.duration > .zero else { continue }
			let instruction = EdlVideoCompositionInstruction(
				timeRange: range,
				primaryTrackID: kCMPersistentTrackID_Invalid,
				pacerTrackID: built.stillPacerTrackID ?? kCMPersistentTrackID_Invalid,
				backgroundColor: backgroundColor,
				overlayVideoLayers: pipLayersIntersecting(range),
				overlayBillboards: billboardsIntersecting(range),
				ticksPerSecond: tps
			)
			let startTicks = Int64((range.start.seconds * Double(tps)).rounded())
			let endTicks = Int64((range.end.seconds * Double(tps)).rounded())
			segments.append(Segment(startTicks: startTicks, endTicks: endTicks, instruction: instruction))
		}

		segments.sort { $0.startTicks < $1.startTicks }

		let composition = AVMutableVideoComposition()
		composition.customVideoCompositorClass = EdlTransitionCompositor.self
		composition.instructions = segments.map(\.instruction)
		composition.frameDuration = EdlTime.frameDuration(fps: edl.output.fps)
		composition.renderSize = billboardRenderSize
		// NOTE deliberately NO `composition.animationTool` here: it is
		// ignored alongside `customVideoCompositorClass` (Apple-documented),
		// which is exactly how the old overlay path silently never rendered.
		// Overlays ride the instructions as `overlayBillboards` instead.

		return composition
	}

	/// Decode an image asset once, at build time, for a `.still` PiP layer.
	/// Downsampled to at most 2160px on the long side — plenty for any v1
	/// render size, and it bounds memory for a huge camera photo.
	static func loadStillImage(url: URL) -> CIImage? {
		guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
		let options: [CFString: Any] = [
			kCGImageSourceCreateThumbnailFromImageAlways: true,
			kCGImageSourceCreateThumbnailWithTransform: true, // bakes EXIF orientation
			kCGImageSourceThumbnailMaxPixelSize: 2160,
		]
		guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
		return CIImage(cgImage: cgImage)
	}

	/// Parses `#RGB` / `#RRGGBB` (the EDL's flat-color background format)
	/// into an opaque CIColor. Returns nil for anything unparseable so the
	/// caller can fall back to black rather than guessing.
	static func ciColor(fromHex hex: String) -> CIColor? {
		var value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
		if value.hasPrefix("#") { value.removeFirst() }
		if value.count == 3 {
			value = value.map { "\($0)\($0)" }.joined()
		}
		guard value.count == 6, let rgb = UInt32(value, radix: 16) else { return nil }
		return CIColor(
			red: CGFloat((rgb >> 16) & 0xff) / 255,
			green: CGFloat((rgb >> 8) & 0xff) / 255,
			blue: CGFloat(rgb & 0xff) / 255,
			alpha: 1
		)
	}
}
