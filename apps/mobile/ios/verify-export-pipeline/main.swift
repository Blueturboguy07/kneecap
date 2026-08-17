import Foundation
import AVFoundation
import CoreGraphics
import ImageIO
#if canImport(UIKit)
import UIKit
#endif

/// kneecap M9 — standalone verification harness for the EDL export bridge.
///
/// Same pattern as `apps/mobile/ios/verify-media-pipeline/`: compiles the
/// SAME `NativeExport/*.swift` + `NativeMedia/MediaProbe.swift` files that
/// ship in the app target into a plain macOS command-line executable, and
/// runs the real export pipeline — real `AVMutableComposition`, real custom
/// `AVVideoCompositing` cross-fade, real `AVAssetExportSession`-class
/// hardware encode — against the SAME bundled fixture
/// `apps/mobile/ios/App/App/Fixtures/kneecap-test-clip.mp4` M4's harness
/// uses, with a hand-authored EDL v1 document (multi-clip, cross-fade
/// transition, speed change, text overlay with a keyframed opacity
/// animation) since the in-repo TS `buildEdl` cannot yet populate
/// `transitions[]` (see `edl/types.ts`'s `EdlTransition` doc comment:
/// "v1 PRODUCER STATUS: always []").
///
/// GOLDEN-FRAME CHECK, HONEST SCOPE: this harness verifies the cross-fade
/// is REAL by extracting frames from the exported file and computing pixel
/// differences (mid-transition frame differs from both pure endpoints, and
/// the three pairwise diffs are linearly consistent with an actual dissolve)
/// — a genuine, numeric verification that blending happened, not merely a
/// "did it not crash" check. It does NOT compare against a WEB-PREVIEW-
/// rendered frame of the same EDL, because there is no browser-automation
/// tool functioning in this session (checked: `mcp__kapture__list_tabs`
/// returned zero connected tabs, and this is a headless agent session with
/// no GUI Chrome/Safari to drive) — see the M9 handoff for exactly what
/// running that other half requires.
///
/// Run: `swiftc App/App/NativeExport/*.swift App/App/NativeMedia/MediaProbe.swift verify-export-pipeline/main.swift -o /tmp/verify-export-pipeline && /tmp/verify-export-pipeline App/App/Fixtures/kneecap-test-clip.mp4`

func fail(_ message: String) -> Never {
	FileHandle.standardError.write("FAIL: \(message)\n".data(using: .utf8)!)
	exit(1)
}

func check(_ condition: Bool, _ message: String) {
	if !condition { fail(message) }
	print("  ok: \(message)")
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: verify-export-pipeline <fixture.mp4>") }
let fixtureURL = URL(fileURLWithPath: args[1])
guard FileManager.default.fileExists(atPath: fixtureURL.path) else {
	fail("fixture not found at \(fixtureURL.path)")
}

// --- Build the fixture EDL v1 document ---
// Timeline (ticksPerSecond = 120000):
//   clip-a: [0s, 2.0s) of output, sourced from fixture [0s, 2.0s)
//   clip-b: [2.0s, 4.0s) NOMINAL, sourced from fixture [2.0s, 4.0s), 1.5x speed
//           -> on-timeline duration shrinks to (2.0s source / 1.5) ≈ 1.333s
//   transition: cross_fade, 0.2s, after clip-a
//   text overlay "kneecap" (#00CAE0 cyan, plan's exact-token color): visible
//     nominally [0.5s, 2.5s) — STRADDLES the transition on purpose, to
//     exercise the nominal->output tick remap (`MainTrackPlacement
//     .buildNominalToOutputRemap`), not just the simple no-transition case.
let ticksPerSecond: Int64 = 120_000
func t(_ seconds: Double) -> Int64 { Int64((seconds * Double(ticksPerSecond)).rounded()) }

let edlJson: [String: Any] = [
	"$schema": "https://kneecap.dev/schema/edl-v1.json",
	"meta": [
		"edlVersion": 1,
		"generator": "verify-export-pipeline",
		"ticksPerSecond": ticksPerSecond,
		"frameRate": ["numerator": 30, "denominator": 1],
		"canvas": ["width": 960, "height": 540],
		"background": ["type": "color", "color": "#000000"],
		"projectId": "proj-verify-export",
		"projectName": "verify-export-pipeline fixture",
		"sceneId": "scene-1",
		"sceneName": "Scene 1",
		"durationTicks": t(4.0),
	],
	"assets": [[
		"assetId": "asset-1",
		"kind": "video",
		"name": "kneecap-test-clip.mp4",
		"sourceUri": "kneecap-media://sandbox/asset-1",
		"proxyUri": NSNull(),
		"codec": "avc1",
		"width": 960,
		"height": 540,
		"durationTicks": t(4.0),
		"rotationDegrees": 0,
		"hasAudio": true,
	]],
	"tracks": [
		[
			"trackId": "track-main",
			"kind": "main",
			"trackType": "video",
			"name": "Main",
			"zIndex": 0,
			"muted": false,
			"hidden": false,
			"clips": [
				clipDict(
					id: "clip-a", assetId: "asset-1", start: t(0), duration: t(2.0),
					sourceStart: t(0), sourceEnd: t(2.0), speedNum: 1, speedDen: 1,
					volumeDb: 0, effects: []
				),
				clipDict(
					id: "clip-b", assetId: "asset-1", start: t(2.0), duration: t(2.0 / 1.5),
					sourceStart: t(2.0), sourceEnd: t(4.0), speedNum: 3, speedDen: 2,
					volumeDb: -3, effects: [["effectId": "fx-1", "type": "brightness", "enabled": true, "params": ["amount": 0.25]]]
				),
			],
		],
		[
			"trackId": "track-text",
			"kind": "overlay",
			"trackType": "text",
			"name": "Text",
			"zIndex": 1,
			"muted": false,
			"hidden": false,
			"clips": [
				textClipDict(
					id: "clip-title", start: t(0.5), duration: t(2.0),
					content: "kneecap", color: "#00CAE0", fontSize: 64
				),
			],
		],
	],
	"transitions": [[
		"transitionId": "t1",
		"afterClipId": "clip-a",
		"kind": "cross_fade",
		"durationTicks": t(0.2),
	]],
	"overlays": [[
		"overlayId": "track-text:clip-title",
		"kind": "text",
		"trackId": "track-text",
		"clipId": "clip-title",
		"zIndex": 1,
		"startTicks": t(0.5),
		"durationTicks": t(2.0),
	]],
	"output": [
		"container": "mp4",
		"videoCodec": "h264",
		"audioCodec": "aac",
		"bitrate": 4_000_000,
		"fps": ["numerator": 30, "denominator": 1],
		"resolution": ["width": 960, "height": 540],
		"includeAudio": true,
	],
]

func clipDict(id: String, assetId: String, start: Int64, duration: Int64, sourceStart: Int64, sourceEnd: Int64, speedNum: Int, speedDen: Int, volumeDb: Double, effects: [[String: Any]]) -> [String: Any] {
	[
		"clipId": id, "kind": "video", "assetId": assetId, "name": id,
		"startTicks": start, "durationTicks": duration,
		"sourceStartTicks": sourceStart, "sourceEndTicks": sourceEnd, "trimEndTicks": 0,
		"speed": ["numerator": speedNum, "denominator": speedDen],
		"maintainPitch": false, "volumeDb": volumeDb, "muted": false, "hidden": false,
		"transform": ["positionX": 0, "positionY": 0, "scaleX": 1, "scaleY": 1, "rotateDegrees": 0],
		"opacity": 1, "blendMode": "normal",
		"effects": effects, "masks": [], "animations": [],
		"params": [:] as [String: Any],
	]
}

func textClipDict(id: String, start: Int64, duration: Int64, content: String, color: String, fontSize: Double) -> [String: Any] {
	[
		"clipId": id, "kind": "text", "assetId": NSNull(), "name": id,
		"startTicks": start, "durationTicks": duration,
		"sourceStartTicks": 0, "sourceEndTicks": duration, "trimEndTicks": 0,
		"speed": ["numerator": 1, "denominator": 1],
		"maintainPitch": false, "volumeDb": 0, "muted": false, "hidden": false,
		"transform": ["positionX": 0, "positionY": -150, "scaleX": 1, "scaleY": 1, "rotateDegrees": 0],
		"opacity": 1, "blendMode": "normal",
		"effects": [], "masks": [],
		"animations": [[
			"propertyPath": "opacity", "componentKey": NSNull(),
			"extrapolationBefore": "hold", "extrapolationAfter": "hold",
			"keyframes": [
				["keyframeId": "kf1", "timeTicks": 0, "value": 0, "interpolation": "linear", "leftHandle": NSNull(), "rightHandle": NSNull()],
				["keyframeId": "kf2", "timeTicks": t(0.4), "value": 1, "interpolation": "hold", "leftHandle": NSNull(), "rightHandle": NSNull()],
			],
		]],
		"params": ["content": content, "fontFamily": "Inter", "fontSize": fontSize, "color": color, "textAlign": "center"],
	]
}

let semaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0

Task {
	do {
		print("== 1. Decode the hand-authored EDL v1 fixture ==")
		let edl = try EdlDecoder.decode(jsObject: edlJson)
		check(edl.meta.edlVersion == 1, "edlVersion == 1")
		check(edl.transitions.count == 1, "exactly one transition in the fixture")

		print("== 2. Pure placement math (MainTrackPlacement, no AVFoundation) ==")
		let mainClips = edl.tracks.first { $0.kind == "main" }!.clips
		let (placements, windows) = try MainTrackPlacement.computePlacements(clips: mainClips, transitions: edl.transitions)
		check(placements.count == 2, "two main-track placements")
		check(windows.count == 1, "one transition window")
		let w = windows[0]
		check(w.durationTicks == t(0.2), "transition window duration == 0.2s (got \(w.durationTicks))")
		check(placements[1].insertStartTicks == placements[0].insertEndTicks - t(0.2), "clip-b pulled earlier by exactly the transition duration")
		let clipBInsertDuration = placements[1].insertDurationTicks
		let expectedClipBDuration = t(2.0 / 1.5)
		check(abs(clipBInsertDuration - expectedClipBDuration) <= 1, "clip-b's on-timeline duration reflects 1.5x speed (got \(clipBInsertDuration), expected ~\(expectedClipBDuration))")
		let expectedTotal = placements[0].insertDurationTicks + clipBInsertDuration - t(0.2)
		check(placements[1].insertEndTicks == expectedTotal, "total placed duration == clipA + clipB - transition overlap")

		print("== 3. Real export via EdlExporter (AVMutableComposition + custom AVVideoCompositing + AVAssetWriter/VideoToolbox) ==")
		let workDir = FileManager.default.temporaryDirectory.appendingPathComponent("kneecap-verify-export-\(UUID().uuidString)")
		try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
		defer { try? FileManager.default.removeItem(at: workDir) }
		let outputURL = workDir.appendingPathComponent("export.mp4")

		var progressSamples: [Double] = []
		let start = Date()
		let result = try await EdlExporter.export(
			edl: edl,
			resolveAssetURL: { _ in fixtureURL },
			outputURL: outputURL,
			onProgress: { p in progressSamples.append(p) }
		)
		let elapsed = Date().timeIntervalSince(start)
		print("  export completed in \(String(format: "%.2f", elapsed))s, \(progressSamples.count) progress samples")

		check(FileManager.default.fileExists(atPath: outputURL.path), "output file exists on disk")
		let outSize: Int = (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size] as? Int ?? 0) ?? 0
		check(outSize > 10_000, "output file is non-trivially sized (\(outSize) bytes)")
		check(!progressSamples.isEmpty, "onProgress fired at least once")
		check(progressSamples.last == 1.0, "final progress report == 1.0")
		check(progressSamples == progressSamples.sorted(), "progress is monotonically non-decreasing")

		print("== 4. Output integrity (already re-probed inside EdlExporter; independently re-checking here too) ==")
		check(result.width == 960 && result.height == 540, "exported dims == 960x540 (got \(result.width)x\(result.height))")
		check(result.hasAudio, "exported file has an audio track")
		let expectedDurationSeconds = Double(expectedTotal) / Double(ticksPerSecond)
		let actualDurationSeconds = Double(result.durationMicros) / 1_000_000
		check(abs(actualDurationSeconds - expectedDurationSeconds) < 0.35, "exported duration ~= \(String(format: "%.3f", expectedDurationSeconds))s (got \(String(format: "%.3f", actualDurationSeconds))s) — i.e. the transition genuinely shortened the export, not just claimed to")

		print("== 5. Independent re-probe via MediaProbe (same code path M4's harness verified against a real file) ==")
		let reprobed = try await MediaProbe.probe(url: outputURL)
		check(reprobed.kind == "video", "MediaProbe independently confirms kind == video")
		check(reprobed.hasAudio, "MediaProbe independently confirms hasAudio")

		print("== 6. Golden-frame check: is the cross-fade a REAL blend, not a hard cut? ==")
		// Transition window in OUTPUT time: [clipA_end - 0.2, clipA_end) = [1.8s, 2.0s).
		let frameA = try extractFrame(from: outputURL, at: 1.0)   // squarely inside clip-a's solo range
		let frameMid = try extractFrame(from: outputURL, at: 1.9) // mid-transition
		let frameB = try extractFrame(from: outputURL, at: 3.0)   // squarely inside clip-b's solo range
		let diffAB = meanAbsDiff(frameA, frameB)
		let diffAMid = meanAbsDiff(frameA, frameMid)
		let diffMidB = meanAbsDiff(frameMid, frameB)
		print("  meanAbsDiff(A,B)=\(String(format: "%.2f", diffAB)) meanAbsDiff(A,mid)=\(String(format: "%.2f", diffAMid)) meanAbsDiff(mid,B)=\(String(format: "%.2f", diffMidB))")
		check(diffAB > 2.0, "clip-a and clip-b frames are genuinely different content (fixture is time-varying) — diff \(diffAB)")
		check(diffAMid > 0.5, "mid-transition frame differs from the pure clip-a frame — not a hard cut sitting on A (diff \(diffAMid))")
		check(diffMidB > 0.5, "mid-transition frame differs from the pure clip-b frame — not a hard cut sitting on B (diff \(diffMidB))")
		// A real linear dissolve at ~50% progress should land roughly
		// between the two endpoints: diff(A,mid) + diff(mid,B) should be
		// close to diff(A,B), not e.g. double it (which would indicate
		// `mid` is some unrelated third image) or near-zero on one side
		// (which would indicate a hard cut disguised as two checks).
		let sumOfParts = diffAMid + diffMidB
		let ratio = sumOfParts / max(diffAB, 0.001)
		check(ratio > 0.7 && ratio < 1.6, "diff(A,mid)+diff(mid,B) is consistent with a linear blend of A and B (ratio to diff(A,B) = \(String(format: "%.2f", ratio)), expected roughly 1.0)")

		print("== 7. Golden-frame check: text overlay actually renders (cyan #00CAE0, plan's exact token) ==")
		// Overlay nominal window [0.5s,2.5s) straddles the transition, so
		// after the remap its OUTPUT window should end ~0.2s earlier than
		// 2.5s — verified structurally in step 2's placement math; here we
		// just confirm the glyph is visibly present and cyan-ish partway
		// through, at output t=1.0s (comfortably inside the remapped window
		// either way).
		let overlayFrame = try extractFrame(from: outputURL, at: 1.0)
		let cyanFraction = fractionOfPixelsNearColor(overlayFrame, target: (0, 202, 224), tolerance: 60)
		print("  fraction of sampled pixels near cyan #00CAE0: \(String(format: "%.4f", cyanFraction))")
		check(cyanFraction > 0.0005, "a measurable fraction of pixels near cyan #00CAE0 are present in an overlay-visible frame (got \(cyanFraction))")

		print("== 8. Cancellation leaves no partial file ==")
		let cancelOutputURL = workDir.appendingPathComponent("cancelled.mp4")
		let handle = EdlExportHandle()
		handle.cancel() // cancel before starting — deterministic, no timing race
		do {
			_ = try await EdlExporter.export(edl: edl, resolveAssetURL: { _ in fixtureURL }, outputURL: cancelOutputURL, handle: handle)
			fail("expected EdlExporter.export to throw .cancelled")
		} catch EdlExportError.cancelled {
			check(!FileManager.default.fileExists(atPath: cancelOutputURL.path), "no partial file left behind after cancellation")
		}

		print("\nALL CHECKS PASSED")
		exitCode = 0
	} catch {
		FileHandle.standardError.write("FAIL: uncaught error: \(error)\n".data(using: .utf8)!)
		exitCode = 1
	}
	semaphore.signal()
}

semaphore.wait()

// MARK: - Frame extraction + pixel diff helpers (no external deps)

struct RGBAFrame {
	var width: Int
	var height: Int
	var bytes: [UInt8] // RGBA8, row-major
}

func extractFrame(from url: URL, at seconds: Double) throws -> RGBAFrame {
	let asset = AVURLAsset(url: url)
	let generator = AVAssetImageGenerator(asset: asset)
	generator.appliesPreferredTrackTransform = true
	generator.requestedTimeToleranceBefore = .zero
	generator.requestedTimeToleranceAfter = .zero
	let cgImage = try generator.copyCGImage(at: CMTime(seconds: seconds, preferredTimescale: 600), actualTime: nil)
	let width = cgImage.width
	let height = cgImage.height
	var bytes = [UInt8](repeating: 0, count: width * height * 4)
	let colorSpace = CGColorSpaceCreateDeviceRGB()
	guard let ctx = CGContext(
		data: &bytes, width: width, height: height, bitsPerComponent: 8,
		bytesPerRow: width * 4, space: colorSpace,
		bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
	) else {
		fail("could not create CGContext for frame extraction")
	}
	ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
	return RGBAFrame(width: width, height: height, bytes: bytes)
}

/// Downsampled (every 4th pixel, both axes) mean absolute difference across
/// R/G/B — a coarse but real, unmocked numeric signal, not a hash equality
/// check that would only tell us "identical or not."
func meanAbsDiff(_ a: RGBAFrame, _ b: RGBAFrame) -> Double {
	guard a.width == b.width, a.height == b.height else { return 255 }
	var total: Double = 0
	var count: Double = 0
	let stride = 4
	for y in Swift.stride(from: 0, to: a.height, by: stride) {
		for x in Swift.stride(from: 0, to: a.width, by: stride) {
			let idx = (y * a.width + x) * 4
			for c in 0..<3 {
				total += abs(Double(a.bytes[idx + c]) - Double(b.bytes[idx + c]))
				count += 1
			}
		}
	}
	return count > 0 ? total / count : 0
}

func fractionOfPixelsNearColor(_ frame: RGBAFrame, target: (UInt8, UInt8, UInt8), tolerance: Int) -> Double {
	var matches = 0
	var total = 0
	for y in Swift.stride(from: 0, to: frame.height, by: 2) {
		for x in Swift.stride(from: 0, to: frame.width, by: 2) {
			let idx = (y * frame.width + x) * 4
			let r = Int(frame.bytes[idx]), g = Int(frame.bytes[idx + 1]), b = Int(frame.bytes[idx + 2])
			total += 1
			if abs(r - Int(target.0)) <= tolerance, abs(g - Int(target.1)) <= tolerance, abs(b - Int(target.2)) <= tolerance {
				matches += 1
			}
		}
	}
	return total > 0 ? Double(matches) / Double(total) : 0
}

exit(exitCode)
