import Foundation
import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// kneecap M4 item 5: "Thumbnail strip generation natively (filmstrip frames
/// at zoom-appropriate density), served from the local server — do NOT
/// decode filmstrip frames in JS."
///
/// Platform-agnostic for the same reason as `MediaProbe.swift` — see its
/// header comment.
public enum ThumbnailStripError: Error, CustomStringConvertible {
	case imageGenerationFailed(String)
	case jpegEncodeFailed

	public var description: String {
		switch self {
		case .imageGenerationFailed(let m): return "thumbnail frame generation failed: \(m)"
		case .jpegEncodeFailed: return "JPEG encode failed"
		}
	}
}

public enum ThumbnailStripGenerator {
	/// Generates `count` evenly-spaced JPEG frames (sampled at each cell's
	/// midpoint, not its left edge, so the first/last thumbnails aren't the
	/// asset's very first/last frame) into `outputDirectory`, upright
	/// (`appliesPreferredTrackTransform = true` bakes in the same rotation
	/// `ProxyTranscoder` applies) and capped at `maxDimension` on the long
	/// edge — filmstrip cells, not full frames.
	@discardableResult
	public static func generate(
		sourceURL: URL,
		outputDirectory: URL,
		count: Int,
		maxDimension: CGFloat = 240
	) async throws -> [URL] {
		let asset = AVURLAsset(url: sourceURL)
		let duration = try await asset.load(.duration)
		let seconds = max(duration.seconds, 0.01)

		try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

		let generator = AVAssetImageGenerator(asset: asset)
		generator.appliesPreferredTrackTransform = true
		generator.maximumSize = CGSize(width: maxDimension, height: maxDimension)
		generator.requestedTimeToleranceBefore = .zero
		generator.requestedTimeToleranceAfter = .zero

		let n = max(1, count)
		var urls: [URL] = []
		for i in 0..<n {
			let t = seconds * (Double(i) + 0.5) / Double(n)
			let time = CMTime(seconds: t, preferredTimescale: 600)
			let cgImage = try await requestImage(generator: generator, at: time)
			let outURL = outputDirectory.appendingPathComponent(String(format: "thumb-%03d.jpg", i))
			try writeJPEG(cgImage: cgImage, to: outURL)
			urls.append(outURL)
		}
		return urls
	}

	private static func requestImage(generator: AVAssetImageGenerator, at time: CMTime) async throws -> CGImage {
		try await withCheckedThrowingContinuation { continuation in
			generator.generateCGImageAsynchronously(for: time) { cgImage, _, error in
				if let cgImage {
					continuation.resume(returning: cgImage)
				} else {
					continuation.resume(throwing: ThumbnailStripError.imageGenerationFailed(
						error?.localizedDescription ?? "unknown"
					))
				}
			}
		}
	}

	private static func writeJPEG(cgImage: CGImage, to url: URL) throws {
		guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
			throw ThumbnailStripError.jpegEncodeFailed
		}
		CGImageDestinationAddImage(dest, cgImage, [kCGImageDestinationLossyCompressionQuality as String: 0.7] as CFDictionary)
		guard CGImageDestinationFinalize(dest) else {
			throw ThumbnailStripError.jpegEncodeFailed
		}
	}
}
