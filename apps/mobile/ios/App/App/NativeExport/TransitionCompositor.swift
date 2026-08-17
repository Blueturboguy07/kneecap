import AVFoundation
import CoreImage

/// kneecap M9 — the custom `AVVideoCompositing` implementation (plan M9
/// item 2, and plan §5 risk #4: "Build the transition compositor FIRST in
/// M9, not last"). Apple's own extension point for exactly this
/// (`AVCustomEdit` sample code — see corpus `07-ios-webview.md` §8), used
/// here for two things:
///   1. Cross-fading between two overlapping main-track clips during a
///      transition window (`EdlVideoCompositionInstruction.secondaryTrackID
///      != kCMPersistentTrackID_Invalid`).
///   2. A minimal per-clip effect pass — v1 wires exactly one effect type,
///      `"brightness"` (matching the one effect present in the frozen EDL
///      v1 golden fixture, `edl/__tests__/golden-edl-v1.json`'s `clip-b`).
///      Any other `EdlEffect.type` is recognized but left a no-op — see
///      `EdlVideoCompositionInstruction`'s doc comment for why that's a
///      documented limitation, not a silent bug.
///
/// Text/sticker overlays are NOT this compositor's job — they're composited
/// afterward via `AVVideoCompositionCoreAnimationTool`
/// (`OverlayLayerBuilder.swift`), which Apple's docs confirm layers on top
/// of whatever `customVideoCompositorClass` produces.
public final class EdlVideoCompositionInstruction: NSObject, AVVideoCompositionInstructionProtocol {
	public var timeRange: CMTimeRange
	public var enablePostProcessing: Bool = false
	public var containsTupledInstructions: Bool = false
	/// Blending two DIFFERENT source frames at different composition times
	/// within a transition window produces different output — the dissolve
	/// progress genuinely varies with `compositionTime` — so `true` for a
	/// dual-source (transition) instruction; a single-source passthrough
	/// (optionally brightness-adjusted, itself time-invariant per frame) is
	/// `false`, letting the media pipeline skip redundant re-composition.
	public var containsTweening: Bool
	public var requiredSourceTrackIDs: [NSValue]?
	public var passthroughTrackID: CMPersistentTrackID = kCMPersistentTrackID_Invalid

	public let primaryTrackID: CMPersistentTrackID
	public let secondaryTrackID: CMPersistentTrackID
	/// `nil` for a plain single-source instruction. When set (both together,
	/// always), describes the cross-fade window this instruction's
	/// `timeRange` falls entirely inside, already converted to `CMTime` at
	/// `meta.ticksPerSecond` by `VideoCompositionBuilder` (via `EdlTime`) —
	/// this class never re-derives a timescale from raw tick counts itself,
	/// so there is exactly one seconds-conversion per window, done once,
	/// upstream.
	public let transitionWindowStart: CMTime?
	public let transitionWindowDuration: CMTime?
	public let transitionKind: String?
	/// Brightness adjustment (`CIColorControls.inputBrightness` units,
	/// roughly -1...1) for the PRIMARY source, if its clip carries an
	/// enabled `"brightness"` effect. `nil` means "no adjustment" (the
	/// common case) — kept optional rather than defaulting to 0 so the
	/// compositor can skip the CIFilter pass entirely for un-effected
	/// frames, which is the overwhelming majority of any real timeline.
	public let primaryBrightness: Double?
	public let secondaryBrightness: Double?

	init(
		timeRange: CMTimeRange,
		primaryTrackID: CMPersistentTrackID,
		secondaryTrackID: CMPersistentTrackID = kCMPersistentTrackID_Invalid,
		transitionWindowStart: CMTime? = nil,
		transitionWindowDuration: CMTime? = nil,
		transitionKind: String? = nil,
		primaryBrightness: Double? = nil,
		secondaryBrightness: Double? = nil
	) {
		self.timeRange = timeRange
		self.primaryTrackID = primaryTrackID
		self.secondaryTrackID = secondaryTrackID
		self.transitionWindowStart = transitionWindowStart
		self.transitionWindowDuration = transitionWindowDuration
		self.transitionKind = transitionKind
		self.primaryBrightness = primaryBrightness
		self.secondaryBrightness = secondaryBrightness
		self.containsTweening = secondaryTrackID != kCMPersistentTrackID_Invalid
		// `requiredSourceTrackIDs` is typed `[NSValue]?`, but AVFoundation's
		// OWN validation (`-[AVVideoComposition
		// isValidForTracks:assetDuration:timeRange:validationDelegate:]`)
		// calls `-intValue` on each element internally — which only
		// `NSNumber` (a subclass of `NSValue`) responds to. Confirmed by a
		// real crash in this repo's own `verify-export-pipeline` harness
		// against `NSValue(nonretainedObject:)`-wrapped values ("-
		// [NSConcreteValue intValue]: unrecognized selector"): the correct
		// construction is a bare `NSNumber`, upcast to `NSValue` for the
		// array's declared element type via inheritance, not a second
		// `NSValue` layer wrapping one.
		self.requiredSourceTrackIDs = [primaryTrackID, secondaryTrackID]
			.filter { $0 != kCMPersistentTrackID_Invalid }
			.map { NSNumber(value: $0) as NSValue }
		super.init()
	}
}

public enum TransitionCompositorError: Error {
	case missingPrimarySourceFrame
	case missingOutputPixelBuffer
}

public final class EdlTransitionCompositor: NSObject, AVVideoCompositing {
	public var sourcePixelBufferAttributes: [String: any Sendable]? = [
		kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
	]
	public var requiredPixelBufferAttributesForRenderContext: [String: any Sendable] = [
		kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
	]

	private let ciContext = CIContext()
	private var renderContextQueue = DispatchQueue(label: "app.kneecap.export.compositor.context")
	private var renderContext: AVVideoCompositionRenderContext?

	public func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {
		renderContextQueue.sync { renderContext = newRenderContext }
	}

	public func startRequest(_ asyncVideoCompositionRequest: AVAsynchronousVideoCompositionRequest) {
		autoreleasepool {
			guard let instruction = asyncVideoCompositionRequest.videoCompositionInstruction as? EdlVideoCompositionInstruction else {
				asyncVideoCompositionRequest.finish(with: NSError(
					domain: "app.kneecap.export",
					code: -1,
					userInfo: [NSLocalizedDescriptionKey: "unexpected instruction type"]
				))
				return
			}
			guard let primaryBuffer = asyncVideoCompositionRequest.sourceFrame(byTrackID: instruction.primaryTrackID) else {
				asyncVideoCompositionRequest.finish(with: NSError(
					domain: "app.kneecap.export",
					code: -2,
					userInfo: [NSLocalizedDescriptionKey: "no primary source frame at track \(instruction.primaryTrackID)"]
				))
				return
			}

			var image = CIImage(cvPixelBuffer: primaryBuffer)
			if let brightness = instruction.primaryBrightness {
				image = image.applyingFilter("CIColorControls", parameters: ["inputBrightness": brightness])
			}

			if instruction.secondaryTrackID != kCMPersistentTrackID_Invalid,
			   let secondaryBuffer = asyncVideoCompositionRequest.sourceFrame(byTrackID: instruction.secondaryTrackID) {
				var secondaryImage = CIImage(cvPixelBuffer: secondaryBuffer)
				if let brightness = instruction.secondaryBrightness {
					secondaryImage = secondaryImage.applyingFilter("CIColorControls", parameters: ["inputBrightness": brightness])
				}
				let progress = Self.progress(
					at: asyncVideoCompositionRequest.compositionTime,
					windowStart: instruction.transitionWindowStart ?? .zero,
					windowDuration: instruction.transitionWindowDuration ?? .zero
				)
				image = Self.blend(
					from: image,
					to: secondaryImage,
					progress: progress,
					kind: instruction.transitionKind ?? "cross_fade"
				)
			}

			guard let outputBuffer = renderContext?.newPixelBuffer() else {
				asyncVideoCompositionRequest.finish(with: TransitionCompositorError.missingOutputPixelBuffer)
				return
			}
			ciContext.render(image, to: outputBuffer)
			asyncVideoCompositionRequest.finish(withComposedVideoFrame: outputBuffer)
		}
	}

	public func cancelAllPendingVideoCompositionRequests() {
		// Stateless per-request (no in-flight request state retained beyond
		// the call stack of `startRequest`), so there's nothing to tear
		// down — required by the protocol, documented as a deliberate no-op.
	}

	/// The precise, tick-based progress calculation `VideoCompositionBuilder`
	/// actually wires up: `compositionTime` and the window bounds are all
	/// converted through the SAME `ticksPerSecond` timescale
	/// (`EdlTime.swift`), so this never round-trips through a
	/// timescale-ambiguous `Double` the way the fallback above would.
	static func progress(at time: CMTime, windowStart: CMTime, windowDuration: CMTime) -> Double {
		guard windowDuration.seconds > 0 else { return 1 }
		let elapsed = time.seconds - windowStart.seconds
		return min(1, max(0, elapsed / windowDuration.seconds))
	}

	/// `CIDissolveTransition` is Apple's own built-in Core Image dissolve —
	/// i.e. a cross-fade — used directly rather than hand-rolled alpha
	/// compositing (plan §5 risk #4: "restrict v1 to transitions expressible
	/// as alpha/transform ramps over an overlap window" — a dissolve IS
	/// exactly that ramp, and `CIDissolveTransition` is the canonical
	/// Core Image primitive for it). Any `kind` other than a recognized
	/// cross-fade alias falls back to the same dissolve rather than
	/// aborting the export — an unrecognized transition KIND is a producer
	/// concern (the picker UI shouldn't offer it), not a reason for the
	/// exporter to fail an otherwise-valid EDL; see plan §2.3 rule 3, "any
	/// effect that cannot pass [golden-frame parity] is cut from v1" — that
	/// cutting happens at the UI/producer layer, this is the export layer's
	/// defensive fallback.
	static func blend(from: CIImage, to: CIImage, progress: Double, kind: String) -> CIImage {
		let filter = CIFilter(name: "CIDissolveTransition")
		filter?.setValue(from, forKey: kCIInputImageKey)
		filter?.setValue(to, forKey: "inputTargetImage")
		filter?.setValue(progress, forKey: "inputTime")
		guard let output = filter?.outputImage else {
			// Should not happen (CIDissolveTransition is always available),
			// but never crash an export over a filter-graph failure —
			// degrade to a hard cut at the midpoint instead.
			return progress < 0.5 ? from : to
		}
		// CIDissolveTransition's output extent is the union/intersection of
		// its two inputs' extents depending on their alpha; crop back to
		// `from`'s extent (both sources are always frames of identical
		// render-context size in this pipeline) so the composed frame has
		// no stray transparent border.
		return output.cropped(to: from.extent)
	}
}
