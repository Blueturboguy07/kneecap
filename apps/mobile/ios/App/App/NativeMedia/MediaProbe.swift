import Foundation
import AVFoundation
import CoreMedia

/// kneecap M4 — native media probe.
///
/// Deliberately **platform-agnostic** (Foundation + AVFoundation + CoreMedia
/// only, no UIKit/Capacitor): this file compiles unmodified into both the
/// iOS app target (`MediaImportPlugin.swift` calls it) and the standalone
/// macOS verification harness at `apps/mobile/ios/verify-media-pipeline/`,
/// which runs the exact same code against a real fixture on the host Mac —
/// AVFoundation's asset-reading APIs are identical on both platforms, so
/// that harness is a genuine (not simulated) exercise of this logic.
///
/// Mirrors `packages/native-bridge/src/types.ts`'s `MediaHandle` shape:
/// integer `durationMicros` (never float seconds), `frameRate` as an
/// optional rational, `rotationDegrees` restricted to the four canonical
/// display-space rotations.
public struct ProbedMedia: Codable, Equatable {
	public var kind: String // "video" | "audio" — image import doesn't go through AVAsset probing.
	public var durationMicros: Int64
	public var width: Int
	public var height: Int
	public var rotationDegrees: Int // 0 | 90 | 180 | 270
	public var hasAudio: Bool
	public var codec: String
	public var frameRateNumerator: Int?
	public var frameRateDenominator: Int?

	public init(
		kind: String,
		durationMicros: Int64,
		width: Int,
		height: Int,
		rotationDegrees: Int,
		hasAudio: Bool,
		codec: String,
		frameRateNumerator: Int?,
		frameRateDenominator: Int?
	) {
		self.kind = kind
		self.durationMicros = durationMicros
		self.width = width
		self.height = height
		self.rotationDegrees = rotationDegrees
		self.hasAudio = hasAudio
		self.codec = codec
		self.frameRateNumerator = frameRateNumerator
		self.frameRateDenominator = frameRateDenominator
	}
}

public enum MediaProbeError: Error, CustomStringConvertible {
	case assetUnreadable(String)

	public var description: String {
		switch self {
		case .assetUnreadable(let msg):
			return "asset unreadable: \(msg)"
		}
	}
}

public enum MediaProbe {
	/// Probes a local media file with AVAsset's modern async property-loading
	/// API (`.load(...)`, iOS 15+ / macOS 12+) — safe unconditionally given
	/// this project's iOS 17 floor (plan §2.5), no legacy synchronous
	/// property fallback needed.
	public static func probe(url: URL) async throws -> ProbedMedia {
		let asset = AVURLAsset(url: url)

		let duration: CMTime
		let tracks: [AVAssetTrack]
		do {
			duration = try await asset.load(.duration)
			tracks = try await asset.load(.tracks)
		} catch {
			throw MediaProbeError.assetUnreadable(error.localizedDescription)
		}

		let videoTracks = tracks.filter { $0.mediaType == .video }
		let audioTracks = tracks.filter { $0.mediaType == .audio }
		let durationMicros = Int64(max(0, (duration.seconds * 1_000_000).rounded()))

		guard let videoTrack = videoTracks.first else {
			// Audio-only source (e.g. a voiceover recording routed through the
			// same probe path). No video track to reason about size/rotation/fps.
			return ProbedMedia(
				kind: "audio",
				durationMicros: durationMicros,
				width: 0,
				height: 0,
				rotationDegrees: 0,
				hasAudio: !audioTracks.isEmpty,
				codec: "unknown",
				frameRateNumerator: nil,
				frameRateDenominator: nil
			)
		}

		let naturalSize = try await videoTrack.load(.naturalSize)
		let transform = try await videoTrack.load(.preferredTransform)
		let nominalFrameRate = try await videoTrack.load(.nominalFrameRate)
		let minFrameDuration = try await videoTrack.load(.minFrameDuration)
		let formatDescriptions = try await videoTrack.load(.formatDescriptions)

		let displaySize = naturalSize.applying(transform)
		let width = Int(abs(displaySize.width).rounded())
		let height = Int(abs(displaySize.height).rounded())
		let rotation = rotationDegrees(fromTransform: transform)

		let codec: String
		if let desc = formatDescriptions.first {
			codec = fourCharCode(from: CMFormatDescriptionGetMediaSubType(desc))
		} else {
			codec = "unknown"
		}

		var frameRateNumerator: Int?
		var frameRateDenominator: Int?
		if minFrameDuration.isValid, minFrameDuration.value != 0, minFrameDuration.timescale != 0 {
			// minFrameDuration is the RECIPROCAL of frame rate: fps == timescale/value.
			frameRateNumerator = Int(minFrameDuration.timescale)
			frameRateDenominator = Int(minFrameDuration.value)
		} else if nominalFrameRate > 0 {
			(frameRateNumerator, frameRateDenominator) = rationalize(fps: Double(nominalFrameRate))
		}

		return ProbedMedia(
			kind: "video",
			durationMicros: durationMicros,
			width: width,
			height: height,
			rotationDegrees: rotation,
			hasAudio: !audioTracks.isEmpty,
			codec: codec,
			frameRateNumerator: frameRateNumerator,
			frameRateDenominator: frameRateDenominator
		)
	}

	/// `preferredTransform` encodes display rotation as a 2D affine matrix.
	/// Every real capture transform kneecap will see is a pure 0/90/180/270
	/// rotation (phone sensors don't mount at arbitrary angles), so matching
	/// the four canonical matrices is exhaustive in practice. Anything else
	/// conservatively reports 0 rather than guessing at a mirror/skew case.
	///
	/// NOT independently verified against a real rotated capture in this
	/// session — see the M4 handoff note. `MediaProbe` itself IS exercised
	/// end-to-end (including this function returning 0 for an unrotated
	/// clip) by `verify-media-pipeline` against the bundled fixture.
	static func rotationDegrees(fromTransform t: CGAffineTransform) -> Int {
		switch (t.a, t.b, t.c, t.d) {
		case (0, 1, -1, 0): return 90
		case (0, -1, 1, 0): return 270
		case (-1, 0, 0, -1): return 180
		default: return 0
		}
	}

	static func fourCharCode(from type: FourCharCode) -> String {
		let bytes: [UInt8] = [
			UInt8((type >> 24) & 0xff),
			UInt8((type >> 16) & 0xff),
			UInt8((type >> 8) & 0xff),
			UInt8(type & 0xff),
		]
		let scalars = bytes.compactMap { $0 > 0 ? UnicodeScalar($0) : nil }
		let str = String(String.UnicodeScalarView(scalars)).trimmingCharacters(in: .whitespaces)
		return str.isEmpty ? "unknown" : str
	}

	/// Mirrors `packages/editor-core/src/fps/utils.ts`'s `floatToFrameRate`
	/// heuristic so a native probe and the web-fallback DOM probe agree on
	/// the same clip's frame rate given only a float fps.
	static func rationalize(fps: Double) -> (Int, Int) {
		let standard: [(value: Double, num: Int, den: Int)] = [
			(24000.0 / 1001.0, 24000, 1001),
			(24, 24, 1),
			(25, 25, 1),
			(30000.0 / 1001.0, 30000, 1001),
			(30, 30, 1),
			(48, 48, 1),
			(50, 50, 1),
			(60000.0 / 1001.0, 60000, 1001),
			(60, 60, 1),
			(120, 120, 1),
		]
		for candidate in standard where abs(fps - candidate.value) <= 0.01 {
			return (candidate.num, candidate.den)
		}
		if fps.rounded() == fps, fps > 0 {
			return (Int(fps), 1)
		}
		let den = 1_000_000
		return (Int((fps * Double(den)).rounded()), den)
	}
}
