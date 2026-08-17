import Foundation
import AVFoundation

/// kneecap M4 — standalone verification harness.
///
/// NOT part of the iOS app target. Compiles the same
/// `apps/mobile/ios/App/App/NativeMedia/*.swift` files (they are
/// UIKit/Capacitor-free by design — see their header comments) into a plain
/// macOS command-line executable and runs them against the real bundled
/// fixture, on the host Mac, with real AVFoundation. This is what "verify in
/// the simulator with a real sample video" is grounded in for the parts an
/// agent session cannot drive interactively (PHPickerViewController is a
/// system UI with no available automation harness here — see the M4
/// handoff): the actual probe/transcode/thumbnail CODE, not a mock of it,
/// runs against a real H.264/AAC file and its real output is asserted on.
///
/// Run: `swiftc NativeMedia/*.swift verify-media-pipeline/main.swift -o /tmp/verify-media-pipeline && /tmp/verify-media-pipeline <fixture.mp4>`

func fail(_ message: String) -> Never {
	FileHandle.standardError.write("FAIL: \(message)\n".data(using: .utf8)!)
	exit(1)
}

func check(_ condition: Bool, _ message: String) {
	if !condition { fail(message) }
	print("  ok: \(message)")
}

let args = CommandLine.arguments
guard args.count >= 2 else {
	fail("usage: verify-media-pipeline <fixture.mp4>")
}
let fixtureURL = URL(fileURLWithPath: args[1])
guard FileManager.default.fileExists(atPath: fixtureURL.path) else {
	fail("fixture not found at \(fixtureURL.path)")
}

let workDir = FileManager.default.temporaryDirectory.appendingPathComponent("kneecap-verify-\(UUID().uuidString)")
try! FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: workDir) }

let semaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0

Task {
	do {
		print("== 1. MediaProbe against the bundled fixture ==")
		let probed = try await MediaProbe.probe(url: fixtureURL)
		print("  probed: \(probed)")
		check(probed.kind == "video", "kind == \"video\"")
		check(probed.width == 960, "width == 960 (got \(probed.width))")
		check(probed.height == 540, "height == 540 (got \(probed.height))")
		check(probed.rotationDegrees == 0, "rotationDegrees == 0 for an unrotated fixture (got \(probed.rotationDegrees))")
		check(probed.hasAudio, "hasAudio == true")
		check(probed.codec.lowercased().contains("avc") || probed.codec.lowercased().contains("h264"), "codec reports an H.264 fourcc (got \(probed.codec))")
		check(probed.durationMicros > 3_900_000 && probed.durationMicros < 4_100_000, "durationMicros ~= 4_000_000 (got \(probed.durationMicros))")
		if let num = probed.frameRateNumerator, let den = probed.frameRateDenominator {
			let fps = Double(num) / Double(den)
			check(abs(fps - 30) < 0.1, "frameRate ~= 30fps (got \(num)/\(den) = \(fps))")
		} else {
			fail("frameRate was nil")
		}

		print("== 2. ProxyTranscoder: downscale 960x540 -> short edge 270, short-GOP ==")
		var progressCalls: [Double] = []
		let proxyURL = workDir.appendingPathComponent("proxy.mp4")
		let spec = ProxySpec(targetShortEdge: 270, shortGopInterval: 15)
		let result = try await ProxyTranscoder.transcode(
			sourceURL: fixtureURL,
			outputURL: proxyURL,
			spec: spec,
			onProgress: { p in progressCalls.append(p) }
		)
		check(FileManager.default.fileExists(atPath: proxyURL.path), "proxy file exists on disk")
		let proxySize = (try? FileManager.default.attributesOfItem(atPath: proxyURL.path)[.size] as? Int) ?? 0
		check((proxySize ?? 0) > 1000, "proxy file is non-trivially sized (\(proxySize ?? 0) bytes)")
		check(result.width == 480 && result.height == 270, "proxy dims == 480x270 (short edge 270, even, from a 960x540/2 source; got \(result.width)x\(result.height))")
		check(!progressCalls.isEmpty, "onProgress fired at least once")
		check(progressCalls.last == 1.0, "final progress report == 1.0")

		print("  re-probing the PROXY itself to confirm it is independently playable/upright...")
		let reprobed = try await MediaProbe.probe(url: proxyURL)
		check(reprobed.kind == "video", "proxy re-probes as video")
		check(reprobed.width == 480 && reprobed.height == 480 || reprobed.width == 480, "proxy width == 480 (got \(reprobed.width))")
		check(reprobed.height == 270, "proxy height == 270 (got \(reprobed.height))")
		check(reprobed.durationMicros > 3_500_000, "proxy duration roughly matches source (got \(reprobed.durationMicros))")

		print("== 3. ThumbnailStripGenerator: 6 frames ==")
		let thumbDir = workDir.appendingPathComponent("thumbs")
		let thumbs = try await ThumbnailStripGenerator.generate(
			sourceURL: fixtureURL,
			outputDirectory: thumbDir,
			count: 6
		)
		check(thumbs.count == 6, "generated 6 thumbnail files (got \(thumbs.count))")
		for (i, url) in thumbs.enumerated() {
			let exists = FileManager.default.fileExists(atPath: url.path)
			check(exists, "thumb[\(i)] exists at \(url.lastPathComponent)")
			let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
			check((size ?? 0) > 200, "thumb[\(i)] is non-trivially sized (\(size ?? 0) bytes)")
			guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
				  let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
				  let w = props[kCGImagePropertyPixelWidth] as? Int,
				  let h = props[kCGImagePropertyPixelHeight] as? Int else {
				fail("thumb[\(i)] is not a decodable image")
			}
			check(w > 0 && h > 0 && max(w, h) <= 240, "thumb[\(i)] decodes as a real image within maxDimension (got \(w)x\(h))")
		}

		print("== 4. MediaSandbox: copy into custody + backup-exclusion ==")
		let assetId = UUID().uuidString
		let custodyURL = try MediaSandbox.copyIntoMediaCustody(sourceURL: fixtureURL, assetId: assetId, fileExtension: "mp4")
		check(FileManager.default.fileExists(atPath: custodyURL.path), "copied file exists in sandbox custody")
		let backupFlag = try? custodyURL.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
		check(backupFlag == true, "isExcludedFromBackupKey == true after excludeFromBackup (got \(String(describing: backupFlag)))")
		try? FileManager.default.removeItem(at: custodyURL)

		print("\nALL CHECKS PASSED")
		exitCode = 0
	} catch {
		FileHandle.standardError.write("FAIL: uncaught error: \(error)\n".data(using: .utf8)!)
		exitCode = 1
	}
	semaphore.signal()
}

semaphore.wait()
exit(exitCode)
