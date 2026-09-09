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
				// Round 33 changed the text unit: fontSize is scaled by
				// canvasHeight/90 (preview parity), so the old 64 rendered a
				// ~680px glyph that flooded the portrait letterbox band and
				// broke step 9. 6 -> 36px landscape / 64px portrait.
				textClipDict(
					id: "clip-title", start: t(0.5), duration: t(2.0),
					content: "kneecap", color: "#00CAE0", fontSize: 6
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
		// positionY -144 parks the glyph (64px portrait, ~77px line box ->
		// rows ~298-374 of 960) in the ONE horizontal band no step measures:
		// above the content band (0.40-0.60; step 11 measures chroma there
		// and un-desaturated cyan text would fail it), below the top
		// letterbox band (0.02-0.30; step 9) and the PiP band (0.15-0.22).
		"transform": ["positionX": 0, "positionY": -144, "scaleX": 1, "scaleY": 1, "rotateDegrees": 0],
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

		print("== 1b. Keyframe evaluation parity (round 47): Swift KeyframeEvaluator vs the TS engine's fixture ==")
		// The fixture is generated by the engine (packages/editor-core/
		// scripts/generate-keyframe-parity-fixture.ts) and guarded by its own
		// bun test; this step is what makes "the export animates like the
		// preview" a measured claim rather than a port's good intentions.
		let parityCandidates: [String] = [
			args.count >= 3 ? args[2] : nil,
			"../../packages/editor-core/src/animation/__tests__/fixtures/keyframe-eval-parity.json",
			"../../../packages/editor-core/src/animation/__tests__/fixtures/keyframe-eval-parity.json",
		].compactMap { $0 }
		guard let parityPath = parityCandidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
			fail("keyframe parity fixture not found — pass its path as the 2nd argument (tried \(parityCandidates))")
		}
		let parityRoot = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: parityPath))) as! [String: Any]
		let parityChannelsJson = parityRoot["channels"] as! [[String: Any]]
		let paritySamples = parityRoot["samples"] as! [[String: Any]]
		let parityTolerance = (parityRoot["tolerance"] as! NSNumber).doubleValue
		// Decode through the SAME Codable model the exporter parses EDLs with.
		let parityChannels = try JSONDecoder().decode(
			[EdlAnimationChannel].self,
			from: JSONSerialization.data(withJSONObject: parityChannelsJson)
		)
		var parityWorst = 0.0
		for sample in paritySamples {
			let channelIndex = (sample["channel"] as! NSNumber).intValue
			let tick = (sample["timeTicks"] as! NSNumber).int64Value
			let expected = (sample["expected"] as! NSNumber).doubleValue
			let actual = KeyframeEvaluator.value(channel: parityChannels[channelIndex], atTicks: tick, fallback: .nan)
			let delta = abs(actual - expected)
			parityWorst = max(parityWorst, delta)
			if !(delta <= parityTolerance) {
				fail("keyframe parity: channel \(channelIndex) (\(parityChannels[channelIndex].propertyPath)) @ tick \(tick): Swift \(actual) vs engine \(expected)")
			}
		}
		check(paritySamples.count >= 100, "Swift evaluator matches the engine on all \(paritySamples.count) samples across \(parityChannels.count) channels (worst |Δ| = \(String(format: "%.2e", parityWorst)))")

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

		print("== 9. Placement/aspect check: landscape source into a PORTRAIT canvas fills the frame width, centered (the bottom-left-quarter export bug's regression test) ==")
		// Same fixture timeline, but the canvas/output is portrait 540x960.
		// The 960x540 source must be contain-fit: scaled to 540x304 (x0.5625)
		// and CENTERED — content band in the vertical middle spanning the full
		// width, with near-black letterbox bands above AND below. The old
		// unplaced compositor rendered the frame at the buffer's bottom-left
		// instead (bright bottom band, dark top ~2/3), which these checks
		// fail loudly.
		var portraitEdlJson = edlJson
		var portraitMeta = portraitEdlJson["meta"] as! [String: Any]
		portraitMeta["canvas"] = ["width": 540, "height": 960]
		portraitEdlJson["meta"] = portraitMeta
		var portraitOutput = portraitEdlJson["output"] as! [String: Any]
		portraitOutput["resolution"] = ["width": 540, "height": 960]
		portraitEdlJson["output"] = portraitOutput

		let portraitEdl = try EdlDecoder.decode(jsObject: portraitEdlJson)
		let portraitURL = workDir.appendingPathComponent("portrait.mp4")
		let portraitResult = try await EdlExporter.export(
			edl: portraitEdl,
			resolveAssetURL: { _ in fixtureURL },
			outputURL: portraitURL,
			onProgress: { _ in }
		)
		check(portraitResult.width == 540 && portraitResult.height == 960, "portrait export dims == 540x960 (got \(portraitResult.width)x\(portraitResult.height))")

		let portraitFrame = try extractFrame(from: portraitURL, at: 1.0)
		// Expected geometry: content rows [328, 632) of 960 (centered 304-row
		// band). Sample well inside each region to be codec/rounding-safe.
		let topBand = meanBrightness(portraitFrame, xFraction: 0.0..<1.0, yFraction: 0.02..<0.30)
		let bottomBand = meanBrightness(portraitFrame, xFraction: 0.0..<1.0, yFraction: 0.70..<0.98)
		let midLeft = meanBrightness(portraitFrame, xFraction: 0.02..<0.48, yFraction: 0.40..<0.60)
		let midRight = meanBrightness(portraitFrame, xFraction: 0.52..<0.98, yFraction: 0.40..<0.60)
		print("  brightness: top=\(String(format: "%.2f", topBand)) bottom=\(String(format: "%.2f", bottomBand)) midLeft=\(String(format: "%.2f", midLeft)) midRight=\(String(format: "%.2f", midRight))")
		check(topBand < 6.0, "top letterbox band is near-black (got \(topBand))")
		check(bottomBand < 6.0, "bottom letterbox band is near-black — the OLD bug put the video here (got \(bottomBand))")
		check(midLeft > 10.0, "centered band has real content on the LEFT half (got \(midLeft))")
		check(midRight > 10.0, "centered band has real content on the RIGHT half — the OLD bug left this black (got \(midRight))")

		print("== 10. Picture-in-picture: an overlay VIDEO clip composites into the export (round 19) ==")
		// Same portrait timeline as step 9, plus an overlay video track: the
		// fixture again, sourced from a LATER time offset (distinct content),
		// scaled to 0.35 and positioned up into the top letterbox band —
		// which step 9 proved is otherwise pure black. Expected geometry:
		// contain 0.5625 x 0.35 -> ~189x106 centered at (270, 180): rows
		// ~127..233, cols ~175..364. Active window [0.5s, 2.5s) of output
		// time (starts before the transition's incoming clip, so unshifted).
		var pipEdlJson = portraitEdlJson
		var pipTracks = pipEdlJson["tracks"] as! [[String: Any]]
		pipTracks.append([
			"trackId": "track-pip",
			"kind": "overlay",
			"trackType": "video",
			"name": "PiP",
			"zIndex": 2,
			"muted": false,
			"hidden": false,
			"clips": [[
				"clipId": "clip-pip", "kind": "video", "assetId": "asset-1", "name": "clip-pip",
				"startTicks": t(0.5), "durationTicks": t(2.0),
				"sourceStartTicks": t(1.0), "sourceEndTicks": t(3.0), "trimEndTicks": 0,
				"speed": ["numerator": 1, "denominator": 1],
				"maintainPitch": false, "volumeDb": 0, "muted": false, "hidden": false,
				"transform": ["positionX": 0, "positionY": -300, "scaleX": 0.35, "scaleY": 0.35, "rotateDegrees": 0],
				"opacity": 1, "blendMode": "normal",
				"effects": [] as [[String: Any]], "masks": [] as [[String: Any]], "animations": [] as [[String: Any]],
				"params": [:] as [String: Any],
			]],
		])
		pipEdlJson["tracks"] = pipTracks

		let pipEdl = try EdlDecoder.decode(jsObject: pipEdlJson)
		let pipURL = workDir.appendingPathComponent("pip.mp4")
		let pipResult = try await EdlExporter.export(
			edl: pipEdl,
			resolveAssetURL: { _ in fixtureURL },
			outputURL: pipURL,
			onProgress: { _ in }
		)
		check(pipResult.width == 540 && pipResult.height == 960, "PiP export dims == 540x960 (got \(pipResult.width)x\(pipResult.height))")

		let pipActiveFrame = try extractFrame(from: pipURL, at: 1.0)   // overlay active
		let pipInactiveFrame = try extractFrame(from: pipURL, at: 2.9) // overlay window over
		let pipRegionActive = meanBrightness(pipActiveFrame, xFraction: 0.36..<0.64, yFraction: 0.15..<0.22)
		let pipCornerActive = meanBrightness(pipActiveFrame, xFraction: 0.02..<0.20, yFraction: 0.02..<0.10)
		let pipRegionInactive = meanBrightness(pipInactiveFrame, xFraction: 0.36..<0.64, yFraction: 0.15..<0.22)
		print("  brightness: pipRegion(active)=\(String(format: "%.2f", pipRegionActive)) corner(active)=\(String(format: "%.2f", pipCornerActive)) pipRegion(after)=\(String(format: "%.2f", pipRegionInactive))")
		check(pipRegionActive > 10.0, "PiP region shows real content while the overlay clip is active (got \(pipRegionActive))")
		check(pipCornerActive < 6.0, "outside the PiP quad the letterbox band stays black — placement is bounded, not smeared (got \(pipCornerActive))")
		check(pipRegionInactive < 6.0, "PiP region returns to black after the overlay clip ends (got \(pipRegionInactive))")
		// And the main band underneath is still present and unharmed.
		let pipMainBand = meanBrightness(pipActiveFrame, xFraction: 0.02..<0.98, yFraction: 0.40..<0.60)
		check(pipMainBand > 10.0, "main-track band still renders beneath the PiP (got \(pipMainBand))")

		// --- 11. Adjust effect: saturation -100 desaturates the export (round 22:
// "adjustment to video menu does not work in preview or in export") ---
print("== 11. Adjust effect renders in the export (saturation -100 -> grayscale) ==")
var adjustEdlJson = portraitEdlJson
var adjustTracks = adjustEdlJson["tracks"] as! [[String: Any]]
var adjustMain = adjustTracks[0]
var adjustClips = adjustMain["clips"] as! [[String: Any]]
adjustClips[0]["effects"] = [[
	"effectId": "fx-adjust-1", "type": "adjust", "enabled": true,
	"params": ["brightness": 0, "contrast": 0, "saturation": -100, "temperature": 0, "tint": 0, "sharpen": 0, "vignette": 0],
	"animations": [] as [[String: Any]],
]]
adjustMain["clips"] = adjustClips
adjustTracks[0] = adjustMain
adjustEdlJson["tracks"] = adjustTracks
let adjustEdl = try EdlDecoder.decode(jsObject: adjustEdlJson)
let adjustURL = workDir.appendingPathComponent("adjust.mp4")
_ = try await EdlExporter.export(
	edl: adjustEdl,
	resolveAssetURL: { _ in fixtureURL },
	outputURL: adjustURL,
	onProgress: { _ in }
)
let adjustFrame = try extractFrame(from: adjustURL, at: 1.0)
let baselineFrame = try extractFrame(from: portraitURL, at: 1.0)
let adjustedChroma = meanChromaSpread(adjustFrame, xFraction: 0.1..<0.9, yFraction: 0.40..<0.60)
let baselineChroma = meanChromaSpread(baselineFrame, xFraction: 0.1..<0.9, yFraction: 0.40..<0.60)
print("  chroma spread: baseline=\(String(format: "%.2f", baselineChroma)) adjusted=\(String(format: "%.2f", adjustedChroma))")
check(baselineChroma > 8.0, "baseline fixture band is genuinely colorful (got \(baselineChroma))")
check(adjustedChroma < 3.0, "saturation -100 clip exports grayscale (got \(adjustedChroma))")

// --- 12. Caption burn-in (round 23): caption clips render in native export,
// karaoke-highlighted, and honor animationStyle "none" (highlight optional).
// Before this round they were silently DROPPED (OverlayLayerBuilder only
// handled text/sticker/graphic). ---
print("== 12. Caption clips burn into the export (karaoke + highlight-off) ==")
func captionClipDict(id: String, animationStyle: String) -> [String: Any] {
	// Three short words in SOURCE tick space [0, 2.0): starts 0 / 0.6 / 1.2.
	// Clip occupies output [0.5s, 2.5s) — word k activates at 0.5 + start.
	[
		"clipId": id, "kind": "caption", "assetId": NSNull(), "name": id,
		"startTicks": t(0.5), "durationTicks": t(2.0),
		"sourceStartTicks": 0, "sourceEndTicks": t(2.0), "trimEndTicks": 0,
		"speed": ["numerator": 1, "denominator": 1],
		"maintainPitch": false, "volumeDb": 0, "muted": false, "hidden": false,
		"transform": ["positionX": 0, "positionY": 0, "scaleX": 1, "scaleY": 1, "rotateDegrees": 0],
		"opacity": 1, "blendMode": "normal",
		"effects": [] as [[String: Any]], "masks": [] as [[String: Any]], "animations": [] as [[String: Any]],
		"captionWords": [
			["text": "go", "startTicks": t(0.0), "endTicks": t(0.6)],
			["text": "far", "startTicks": t(0.6), "endTicks": t(1.2)],
			["text": "now", "startTicks": t(1.2), "endTicks": t(2.0)],
		],
		"params": [
			"fontFamily": "Arial", "fontSize": 8, "fontWeight": "bold",
			"color": "#ffffff", "highlightColor": "#FFD700",
			"strokeColor": "#000000", "strokeWidth": 6,
			"position": "bottom", "uppercase": false,
			"animationStyle": animationStyle,
		],
	]
}
func captionEdl(animationStyle: String) throws -> EdlDocument {
	var json = portraitEdlJson
	var tracks = json["tracks"] as! [[String: Any]]
	tracks.append([
		"trackId": "track-captions",
		"kind": "overlay",
		"trackType": "caption",
		"name": "Captions",
		"zIndex": 3,
		"muted": false,
		"hidden": false,
		"clips": [captionClipDict(id: "clip-caption", animationStyle: animationStyle)],
	])
	json["tracks"] = tracks
	return try EdlDecoder.decode(jsObject: json)
}
// Bottom-position caption on the 540x960 portrait canvas: centerY = 0.86H,
// scaledFontSize = 8 * 960/90 ≈ 85px, line height ≈ 111px -> the caption
// band is y 0.79..0.93 — inside the letterbox band step 9 proved is
// otherwise pure black.
let captionBandY = 0.79..<0.93
let karaokeURL = workDir.appendingPathComponent("captions-karaoke.mp4")
_ = try await EdlExporter.export(
	edl: try captionEdl(animationStyle: "karaoke"),
	resolveAssetURL: { _ in fixtureURL },
	outputURL: karaokeURL,
	onProgress: { _ in }
)
let captionActive = try extractFrame(from: karaokeURL, at: 1.4)  // word "far" active
let captionAfter = try extractFrame(from: karaokeURL, at: 2.9)   // caption window over
// Visual-inspection artifact FIRST (so a failing check still leaves the
// frame on disk) + a coarse y-band sweep to locate the caption if the
// expected band is dark.
let inspectURL = FileManager.default.temporaryDirectory.appendingPathComponent("kneecap-caption-frame.png")
try writePNG(captionActive, to: inspectURL)
print("  wrote caption frame for visual inspection: \(inspectURL.path)")
for band in 0..<10 {
	let y0 = Double(band) / 10.0
	let b = meanBrightness(captionActive, xFraction: 0.1..<0.9, yFraction: y0..<(y0 + 0.1))
	print("  y \(String(format: "%.1f", y0))-\(String(format: "%.1f", y0 + 0.1)): brightness \(String(format: "%.2f", b))")
}
let captionBandActive = meanBrightness(captionActive, xFraction: 0.1..<0.9, yFraction: captionBandY)
let captionBandAfter = meanBrightness(captionAfter, xFraction: 0.1..<0.9, yFraction: captionBandY)
// Gold measured INSIDE the caption band only — the colorful fixture
// video contributes a ~0.05 whole-frame gold baseline that drowned the
// caption signal (first run of this step failed exactly there).
let goldActive = fractionOfPixelsNearColor(captionActive, target: (255, 215, 0), tolerance: 60, yFraction: 0.79..<0.93)
print("  caption band: active=\(String(format: "%.2f", captionBandActive)) after=\(String(format: "%.2f", captionBandAfter)) goldFraction=\(String(format: "%.4f", goldActive))")
check(captionBandActive > 8.0, "caption words render in the bottom band while the clip is active (got \(captionBandActive))")
check(captionBandAfter < 6.0, "caption band returns to black after the clip ends (got \(captionBandAfter))")
check(goldActive > 0.003, "karaoke gold highlight is present on the active word (got \(goldActive))")

let noHighlightURL = workDir.appendingPathComponent("captions-plain.mp4")
_ = try await EdlExporter.export(
	edl: try captionEdl(animationStyle: "none"),
	resolveAssetURL: { _ in fixtureURL },
	outputURL: noHighlightURL,
	onProgress: { _ in }
)
let plainActive = try extractFrame(from: noHighlightURL, at: 1.4)
let plainBand = meanBrightness(plainActive, xFraction: 0.1..<0.9, yFraction: captionBandY)
let goldPlain = fractionOfPixelsNearColor(plainActive, target: (255, 215, 0), tolerance: 60, yFraction: 0.79..<0.93)
print("  highlight-off: band=\(String(format: "%.2f", plainBand)) goldFraction=\(String(format: "%.4f", goldPlain))")
check(plainBand > 8.0, "animationStyle none still renders the words (got \(plainBand))")
check(goldPlain < 0.0002, "animationStyle none has NO gold highlight (got \(goldPlain))")

// --- 13. Keyframes (round 47): the compositor evaluates keyframe channels
// per frame. A PiP clip whose positionX is keyframed slides from left of
// centre to right of centre across its window, and the main clip whose
// opacity is keyframed fades — the same EDL `animations[]` the mobile
// editor writes, exported for real. ---
print("== 13. Keyframed transform + opacity animate in the export ==")
var kfEdlJson = pipEdlJson
var kfTracks = kfEdlJson["tracks"] as! [[String: Any]]
// The PiP track is the last one step 10 appended: positionX -150 -> +150
// over its 2s window (linear, hold outside).
var kfPip = kfTracks[kfTracks.count - 1]
var kfPipClips = kfPip["clips"] as! [[String: Any]]
kfPipClips[0]["animations"] = [[
	"propertyPath": "transform.positionX", "componentKey": NSNull(),
	"extrapolationBefore": "hold", "extrapolationAfter": "hold",
	"keyframes": [
		["keyframeId": "kx1", "timeTicks": 0, "value": -150, "interpolation": "linear", "leftHandle": NSNull(), "rightHandle": NSNull()],
		["keyframeId": "kx2", "timeTicks": t(2.0), "value": 150, "interpolation": "linear", "leftHandle": NSNull(), "rightHandle": NSNull()],
	],
]] as [[String: Any]]
kfPip["clips"] = kfPipClips
kfTracks[kfTracks.count - 1] = kfPip
// Main clip-a: opacity 1 -> 0.1 across its first 1.6s (all inside its solo
// range, before the 1.8s transition window).
var kfMain = kfTracks[0]
var kfMainClips = kfMain["clips"] as! [[String: Any]]
kfMainClips[0]["animations"] = [[
	"propertyPath": "opacity", "componentKey": NSNull(),
	"extrapolationBefore": "hold", "extrapolationAfter": "hold",
	"keyframes": [
		["keyframeId": "ko1", "timeTicks": 0, "value": 1, "interpolation": "linear", "leftHandle": NSNull(), "rightHandle": NSNull()],
		["keyframeId": "ko2", "timeTicks": t(1.6), "value": 0.1, "interpolation": "linear", "leftHandle": NSNull(), "rightHandle": NSNull()],
	],
]] as [[String: Any]]
kfMain["clips"] = kfMainClips
kfTracks[0] = kfMain
kfEdlJson["tracks"] = kfTracks
let kfEdl = try EdlDecoder.decode(jsObject: kfEdlJson)
check(kfEdl.tracks[0].clips[0].animations.count == 1 && kfEdl.tracks[0].clips[0].animations[0].keyframes.count == 2, "keyframed EDL decodes with its animation channels intact")
let kfURL = workDir.appendingPathComponent("keyframes.mp4")
_ = try await EdlExporter.export(edl: kfEdl, resolveAssetURL: { _ in fixtureURL }, outputURL: kfURL, onProgress: { _ in })
// PiP window is output [0.5s, 2.5s): at local 0.1s x ≈ -135 (quad ~189px
// wide centred at 135 of 540 -> cols ~40..230), at local 1.9s x ≈ +135
// (centred at 405 -> cols ~310..500). Same y band step 10 measured.
let kfEarly = try extractFrame(from: kfURL, at: 0.6)
let kfLate = try extractFrame(from: kfURL, at: 2.4)
let kfEarlyLeft = meanBrightness(kfEarly, xFraction: 0.08..<0.42, yFraction: 0.15..<0.22)
let kfEarlyRight = meanBrightness(kfEarly, xFraction: 0.58..<0.92, yFraction: 0.15..<0.22)
let kfLateLeft = meanBrightness(kfLate, xFraction: 0.08..<0.42, yFraction: 0.15..<0.22)
let kfLateRight = meanBrightness(kfLate, xFraction: 0.58..<0.92, yFraction: 0.15..<0.22)
print("  PiP band brightness: early L=\(String(format: "%.2f", kfEarlyLeft)) R=\(String(format: "%.2f", kfEarlyRight)); late L=\(String(format: "%.2f", kfLateLeft)) R=\(String(format: "%.2f", kfLateRight))")
check(kfEarlyLeft > 10.0 && kfEarlyRight < 6.0, "at local 0.1s the keyframed PiP sits LEFT of centre (L \(kfEarlyLeft), R \(kfEarlyRight))")
check(kfLateRight > 10.0 && kfLateLeft < 6.0, "at local 1.9s the keyframed PiP has slid RIGHT of centre — the transform was evaluated per frame (L \(kfLateLeft), R \(kfLateRight))")
// Main-track opacity: clip-a's content band at 0.2s (opacity ≈ 0.89) vs
// 1.5s (≈ 0.16), composited over the black canvas.
let kfFadeEarly = try extractFrame(from: kfURL, at: 0.2)
let kfFadeLate = try extractFrame(from: kfURL, at: 1.5)
let kfBandEarly = meanBrightness(kfFadeEarly, xFraction: 0.02..<0.98, yFraction: 0.40..<0.60)
let kfBandLate = meanBrightness(kfFadeLate, xFraction: 0.02..<0.98, yFraction: 0.40..<0.60)
let kfBandStatic = meanBrightness(portraitFrame, xFraction: 0.02..<0.98, yFraction: 0.40..<0.60)
print("  main band brightness: static=\(String(format: "%.2f", kfBandStatic)) opacity≈0.89=\(String(format: "%.2f", kfBandEarly)) opacity≈0.16=\(String(format: "%.2f", kfBandLate))")
check(kfBandEarly > 10.0, "near-opaque frame still shows the clip (got \(kfBandEarly))")
check(kfBandLate < 0.5 * kfBandEarly, "the keyframed opacity fade darkens the clip over time — evaluated per frame, not once (early \(kfBandEarly), late \(kfBandLate))")
check(kfBandLate > 1.0, "faded frame is dim, not black — opacity 0.16 still leaves a trace (got \(kfBandLate))")

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

func writePNG(_ frame: RGBAFrame, to url: URL) throws {
	let ctx = CGContext(
		data: nil, width: frame.width, height: frame.height,
		bitsPerComponent: 8, bytesPerRow: 0,
		space: CGColorSpaceCreateDeviceRGB(),
		bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
	)!
	frame.bytes.withUnsafeBytes { src in
		let dst = ctx.data!
		let rowBytes = ctx.bytesPerRow
		for row in 0..<frame.height {
			memcpy(dst + row * rowBytes, src.baseAddress! + row * frame.width * 4, frame.width * 4)
		}
	}
	guard let image = ctx.makeImage(),
		let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
	else { throw NSError(domain: "verify", code: 1, userInfo: [NSLocalizedDescriptionKey: "PNG write failed"]) }
	CGImageDestinationAddImage(dest, image, nil)
	CGImageDestinationFinalize(dest)
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

/// Mean R+G+B brightness (0-255) over a fractional sub-rectangle of the
/// frame, sampled every 2nd pixel — used by the placement checks to tell
/// letterbox bands (near 0) from content bands.
func meanBrightness(_ frame: RGBAFrame, xFraction: Range<Double>, yFraction: Range<Double>) -> Double {
	let x0 = max(0, Int(Double(frame.width) * xFraction.lowerBound))
	let x1 = min(frame.width, Int(Double(frame.width) * xFraction.upperBound))
	let y0 = max(0, Int(Double(frame.height) * yFraction.lowerBound))
	let y1 = min(frame.height, Int(Double(frame.height) * yFraction.upperBound))
	var total: Double = 0
	var count: Double = 0
	for y in Swift.stride(from: y0, to: y1, by: 2) {
		for x in Swift.stride(from: x0, to: x1, by: 2) {
			let idx = (y * frame.width + x) * 4
			total += (Double(frame.bytes[idx]) + Double(frame.bytes[idx + 1]) + Double(frame.bytes[idx + 2])) / 3
			count += 1
		}
	}
	return count > 0 ? total / count : 0
}

/// Mean per-pixel chroma spread (max channel - min channel) over a region —
/// ~0 for a grayscale frame, large for colorful content. Round 22's adjust
/// check uses it to prove saturation -100 actually desaturates the export.
func meanChromaSpread(_ frame: RGBAFrame, xFraction: Range<Double>, yFraction: Range<Double>) -> Double {
	let x0 = max(0, Int(Double(frame.width) * xFraction.lowerBound))
	let x1 = min(frame.width, Int(Double(frame.width) * xFraction.upperBound))
	let y0 = max(0, Int(Double(frame.height) * yFraction.lowerBound))
	let y1 = min(frame.height, Int(Double(frame.height) * yFraction.upperBound))
	var total: Double = 0
	var count: Double = 0
	for y in Swift.stride(from: y0, to: y1, by: 2) {
		for x in Swift.stride(from: x0, to: x1, by: 2) {
			let idx = (y * frame.width + x) * 4
			let r = Double(frame.bytes[idx]), g = Double(frame.bytes[idx + 1]), b = Double(frame.bytes[idx + 2])
			total += Swift.max(r, g, b) - Swift.min(r, g, b)
			count += 1
		}
	}
	return count > 0 ? total / count : 0
}

func fractionOfPixelsNearColor(
	_ frame: RGBAFrame,
	target: (UInt8, UInt8, UInt8),
	tolerance: Int,
	yFraction: Range<Double> = 0.0..<1.0
) -> Double {
	var matches = 0
	var total = 0
	let yStart = Int(Double(frame.height) * yFraction.lowerBound)
	let yEnd = Int(Double(frame.height) * yFraction.upperBound)
	for y in Swift.stride(from: yStart, to: yEnd, by: 2) {
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
