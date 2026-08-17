import AVFoundation
import CoreGraphics
import CoreText
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// kneecap M9 — text/sticker overlays via Core Animation layers (plan M9
/// item 3), composited through `AVVideoCompositionCoreAnimationTool`.
///
/// Platform-agnostic in the same spirit as the rest of `NativeExport/` —
/// `CATextLayer`/`CALayer` and `AVVideoCompositionCoreAnimationTool` are all
/// available on macOS too, so this compiles and genuinely runs (not stubs
/// out) inside `verify-export-pipeline`. The one platform fork
/// (`#if canImport(UIKit)`) is only for `UIColor` vs `NSColor` parsing a hex
/// string into a `CGColor` — everything else is shared.
public enum OverlayLayerBuilder {
	/// v1 scope, matching `EdlClip.kind`: `"text"` renders real typeset
	/// text via `CATextLayer`. `"sticker"`/`"graphic"` render as a text-like
	/// glyph layer sourced from `params.content` (an emoji or short string)
	/// — DOCUMENTED LIMITATION: there is no bundled sticker-art asset
	/// pipeline yet (that's M7/M8's job per the plan's UI milestones), so a
	/// real bitmap sticker cannot be rendered here. A clip of kind
	/// `"sticker"` with no usable `params.content` string is skipped
	/// (logged, not thrown) rather than failing the whole export.
	public static func buildOverlayLayers(
		edl: EdlDocument,
		renderSize: CGSize
	) -> [CALayer] {
		let tps = edl.meta.ticksPerSecond
		var layers: [CALayer] = []

		let overlayTracks = edl.tracks.filter { $0.kind == "overlay" }
		// Z-order: EDL's own normative comment (`types.ts` on `EdlTrack`)
		// says overlay tracks paint with `overlay[0]` on TOP — sort
		// ascending by `zIndex` so higher-zIndex layers are added to the
		// CALayer tree LAST (CALayer paints later-added sublayers on top,
		// matching "on top" = higher zIndex = last).
		let sortedTracks = overlayTracks.sorted { ($0.zIndex ?? 0) < ($1.zIndex ?? 0) }

		for track in sortedTracks {
			for clip in track.clips where clip.kind == "text" || clip.kind == "sticker" || clip.kind == "graphic" {
				guard let layer = buildClipLayer(clip: clip, renderSize: renderSize, ticksPerSecond: tps) else { continue }
				layers.append(layer)
			}
		}
		return layers
	}

	private static func buildClipLayer(clip: EdlClip, renderSize: CGSize, ticksPerSecond: Int64) -> CALayer? {
		let content = clip.params["content"]?.asString ?? (clip.kind == "text" ? "" : nil)
		guard let content, !content.isEmpty || clip.kind == "text" else { return nil }

		let fontSize = clip.params["fontSize"]?.asDouble ?? 48
		let colorHex = clip.params["color"]?.asString ?? "#FFFFFF"
		let textAlign = clip.params["textAlign"]?.asString ?? "center"

		let textLayer = CATextLayer()
		textLayer.string = content
		textLayer.fontSize = CGFloat(fontSize)
		textLayer.foregroundColor = cgColor(fromHex: colorHex)
		textLayer.alignmentMode = caTextAlignment(textAlign)
		textLayer.isWrapped = true
		textLayer.contentsScale = 2.0 // crisp text without a live-display scale factor to query offscreen

		// Generous fixed box around the requested position — v1 doesn't
		// model auto-sizing/line-wrap-to-content from the EDL (that's a
		// preview-renderer layout concern, out of scope for the export
		// mapper, which only needs to reproduce WHERE the preview placed
		// the text, not re-derive its layout from scratch).
		let boxWidth = renderSize.width * 0.9
		let boxHeight = CGFloat(fontSize) * 2.2
		let centerX = renderSize.width / 2 + CGFloat(clip.transform.positionX)
		let centerY = renderSize.height / 2 + CGFloat(clip.transform.positionY)
		textLayer.frame = CGRect(
			x: centerX - boxWidth / 2,
			y: centerY - boxHeight / 2,
			width: boxWidth,
			height: boxHeight
		)

		// AVVideoCompositionCoreAnimationTool composites in a Core-Animation
		// coordinate space where the render layer's origin matches the
		// VIDEO frame's origin (bottom-left in AVFoundation's convention for
		// the outer layer, but sublayers added directly with a `frame` in
		// the layer's own flipped-or-not context follow whatever
		// `isGeometryFlipped` the wrapping code sets — `VideoCompositionBuilder`
		// sets `isGeometryFlipped = false` on the parent video layer and
		// treats (0,0) as top-left to match the EDL's own `transform`
		// convention (`services/renderer` positions overlays with +Y
		// downward, screen convention) — see that file's comment for the
		// flip it applies.

		// Visibility window as layer-level opacity gating: the whole layer
		// is invisible outside [startTicks, startTicks+durationTicks).
		// `beginTime`/timing here is expressed in the PARENT layer's local
		// time, which `VideoCompositionCoreAnimationTool` drives from the
		// composition's own timeline starting at 0 — exactly the ticks
		// space already in scope, converted once via `EdlTime`.
		let clipStart = EdlTime.cmTime(ticks: clip.startTicks, ticksPerSecond: ticksPerSecond).seconds
		let clipEnd = EdlTime.cmTime(ticks: clip.startTicks + clip.durationTicks, ticksPerSecond: ticksPerSecond).seconds

		textLayer.opacity = 0
		let visibility = CAKeyframeAnimation(keyPath: "opacity")
		var keyTimes: [NSNumber] = [0, NSNumber(value: nextUp(clipStart)), NSNumber(value: clipStart), NSNumber(value: clipEnd), NSNumber(value: nextUp(clipEnd))]
		var values: [Float] = [0, 0, Float(clip.opacity), Float(clip.opacity), 0]

		// Fold in an `"opacity"` animation channel, if the clip carries one
		// (v1 only implements this one property path for CALayer-driven
		// overlays — matches the EDL v1 golden fixture's `clip-title`,
		// which animates exactly `opacity`). Keyframe times are
		// CLIP-RELATIVE per `EdlAnimationChannel`'s doc comment, so they're
		// offset by `clipStart` before merging into the layer's absolute
		// (composition-relative) keyframe list.
		if let opacityChannel = clip.animations.first(where: { $0.propertyPath == "opacity" }), !opacityChannel.keyframes.isEmpty {
			keyTimes = []
			values = []
			for kf in opacityChannel.keyframes.sorted(by: { $0.timeTicks < $1.timeTicks }) {
				let t = clipStart + EdlTime.cmTime(ticks: kf.timeTicks, ticksPerSecond: ticksPerSecond).seconds
				keyTimes.append(NSNumber(value: t))
				values.append(Float(kf.value.asDouble ?? clip.opacity))
			}
			// Still gate to exactly zero outside the clip's own window.
			keyTimes.insert(0, at: 0)
			values.insert(0, at: 0)
			keyTimes.append(NSNumber(value: nextUp(clipEnd)))
			values.append(0)
		}

		visibility.keyTimes = keyTimes
		visibility.values = values
		visibility.duration = CFTimeInterval(max(clipEnd, keyTimes.last?.doubleValue ?? clipEnd) + 0.01)
		visibility.calculationMode = .linear
		visibility.beginTime = AVCoreAnimationBeginTimeAtZero
		visibility.isRemovedOnCompletion = false
		visibility.fillMode = .forwards
		textLayer.add(visibility, forKey: "edlOpacity")

		return textLayer
	}

	private static func nextUp(_ v: Double) -> Double { v + 0.0001 }

	private static func caTextAlignment(_ align: String) -> CATextLayerAlignmentMode {
		switch align {
		case "left": return .left
		case "right": return .right
		case "justify": return .justified
		default: return .center
		}
	}

	/// `"#RRGGBB"` or `"#RRGGBBAA"` hex parsing, no `UIColor(hex:)`
	/// convenience dependency. Falls back to opaque white on a malformed
	/// string rather than throwing — a broken color for one overlay clip
	/// should degrade visibly, not abort the whole export.
	static func cgColor(fromHex hex: String) -> CGColor {
		var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
		if s.hasPrefix("#") { s.removeFirst() }
		guard s.count == 6 || s.count == 8, let value = UInt64(s, radix: 16) else {
			return CGColor(red: 1, green: 1, blue: 1, alpha: 1)
		}
		let hasAlpha = s.count == 8
		let r = Double((value >> (hasAlpha ? 24 : 16)) & 0xff) / 255.0
		let g = Double((value >> (hasAlpha ? 16 : 8)) & 0xff) / 255.0
		let b = Double((value >> (hasAlpha ? 8 : 0)) & 0xff) / 255.0
		let a = hasAlpha ? Double(value & 0xff) / 255.0 : 1.0
		return CGColor(red: r, green: g, blue: b, alpha: a)
	}
}
