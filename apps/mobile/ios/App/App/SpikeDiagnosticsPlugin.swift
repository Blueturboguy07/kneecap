import Foundation
import Capacitor
import AVFoundation
import CoreImage
import UIKit

/// kneecap M1 spike — a SEPARATE, throwaway native plugin from
/// `NativeBridgePlugin.swift`. See `packages/native-bridge/src/
/// spike-diagnostics.ts`'s header for why this is not folded into the
/// production `NativeBridge`: this is a hand-rolled fixture exporter for a
/// throwaway harness, not the real M9 export pipeline, and conflating the
/// two would be a real correctness hazard for whoever reads M1's results.
///
/// Two methods:
///   - `getMemoryFootprint`: plan M1 item 6 / test 6's peak-RSS watermark.
///     Uses `mach_task_basic_info`'s `resident_size` — the standard,
///     widely-documented way an iOS app reads its own memory footprint (the
///     same figure Xcode's own memory gauge and `os_proc_available_memory`
///     neighbourhood report from). This is what the webview process
///     *shares* the app's memory budget with (Capacitor is a single-process
///     WKWebView host on iOS, unlike Android's separate WebView renderer
///     process model) — see plan risk-register #2's WKWebView jetsam
///     framing for why this number matters.
///   - `exportSpikeSequence`: plan M1 item 3. Generates two ~2s solid-color
///     clips ON-DEVICE via `AVAssetWriter` (deliberately not a bundled
///     asset — see this file's export function for why), then builds a real
///     crossfade via `AVMutableVideoComposition` opacity ramps plus a text
///     overlay via `AVVideoCompositionCoreAnimationTool`, and exports with
///     `AVAssetExportSession`.
@objc(SpikeDiagnosticsPlugin)
public class SpikeDiagnosticsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpikeDiagnosticsPlugin"
    public let jsName = "SpikeDiagnostics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getMemoryFootprint", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportSpikeSequence", returnType: CAPPluginReturnPromise)
    ]

    @objc func getMemoryFootprint(_ call: CAPPluginCall) {
        call.resolve(["residentBytes": SpikeDiagnosticsPlugin.currentResidentBytes()])
    }

    /// Apple's own documented pattern (widely cited from WWDC "Reducing
    /// Your App's Memory Footprint" onward) for reading a process's current
    /// resident memory from within itself.
    static func currentResidentBytes() -> Int {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let result: kern_return_t = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return Int(info.resident_size)
    }

    @objc func exportSpikeSequence(_ call: CAPPluginCall) {
        let start = Date()
        let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent(
            "kneecap-spike-\(UUID().uuidString)", isDirectory: true
        )
        do {
            try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        } catch {
            call.resolve(SpikeDiagnosticsPlugin.errorResult("Failed to create temp dir: \(error.localizedDescription)"))
            return
        }

        Task {
            do {
                // Two solid-color, ~2s, 640x360 clips generated on-device.
                // Deliberately NOT bundled Xcode resources: App.xcodeproj
                // uses the classic explicit PBXFileReference/PBXBuildFile
                // list (verified directly — no fileSystemSynchronizedGroups
                // in project.pbxproj), which is fragile to hand-edit for a
                // throwaway spike fixture. Generating on-device sidesteps
                // that entirely and needs no project-file change beyond
                // this one new .swift file. Modest resolution keeps this
                // fast even on the Simulator's software-path encode.
                let clipA = try await SpikeDiagnosticsPlugin.writeSolidColorClip(
                    color: UIColor(red: 0.8, green: 0.15, blue: 0.15, alpha: 1),
                    duration: 2.0,
                    to: tmpDir.appendingPathComponent("clip-a.mov")
                )
                let clipB = try await SpikeDiagnosticsPlugin.writeSolidColorClip(
                    color: UIColor(red: 0.15, green: 0.25, blue: 0.85, alpha: 1),
                    duration: 2.0,
                    to: tmpDir.appendingPathComponent("clip-b.mov")
                )

                let outputURL = tmpDir.appendingPathComponent("spike-export.mov")
                let exportResult = try await SpikeDiagnosticsPlugin.crossfadeExport(
                    clipA: clipA,
                    clipB: clipB,
                    crossfadeDuration: 0.5,
                    outputURL: outputURL
                )

                let wallClockMs = Date().timeIntervalSince(start) * 1000

                await MainActor.run {
                    call.resolve([
                        "ran": true,
                        "wallClockMs": wallClockMs,
                        "outputDurationMs": exportResult.durationSeconds * 1000,
                        "outputSizeBytes": exportResult.fileSizeBytes,
                        "crossfadeApplied": true,
                        "textOverlayApplied": true,
                        "note": NSNull(),
                        "error": NSNull()
                    ])
                }
            } catch {
                await MainActor.run {
                    call.resolve(SpikeDiagnosticsPlugin.errorResult(error.localizedDescription))
                }
            }
            try? FileManager.default.removeItem(at: tmpDir)
        }
    }

    private static func errorResult(_ message: String) -> [String: Any] {
        [
            "ran": false,
            "wallClockMs": NSNull(),
            "outputDurationMs": NSNull(),
            "outputSizeBytes": NSNull(),
            "crossfadeApplied": NSNull(),
            "textOverlayApplied": NSNull(),
            "note": NSNull(),
            "error": message
        ]
    }

    // MARK: - On-device synthetic clip generation

    private static func writeSolidColorClip(color: UIColor, duration: Double, to url: URL) async throws -> URL {
        let width = 640
        let height = 360
        let fps: Int32 = 30
        let frameCount = Int(duration * Double(fps))

        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let outputSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: outputSettings)
        input.expectsMediaDataInRealTime = false

        let pixelBufferAttributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height
        ]
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: pixelBufferAttributes
        )
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)

        guard let pixelBufferPool = adaptor.pixelBufferPool else {
            throw SpikeExportError.generic("No pixel buffer pool available for synthetic clip generation.")
        }

        for frameIndex in 0..<frameCount {
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(nanoseconds: 2_000_000)
            }
            var pixelBufferOut: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pixelBufferPool, &pixelBufferOut)
            guard let pixelBuffer = pixelBufferOut else { continue }

            CVPixelBufferLockBaseAddress(pixelBuffer, [])
            if let base = CVPixelBufferGetBaseAddress(pixelBuffer) {
                let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
                var redComponent: CGFloat = 0
                var greenComponent: CGFloat = 0
                var blueComponent: CGFloat = 0
                var alphaComponent: CGFloat = 0
                color.getRed(&redComponent, green: &greenComponent, blue: &blueComponent, alpha: &alphaComponent)
                let b = UInt8(blueComponent * 255)
                let g = UInt8(greenComponent * 255)
                let r = UInt8(redComponent * 255)
                let a: UInt8 = 255
                let pixel: [UInt8] = [b, g, r, a]
                let rowPtr = base.assumingMemoryBound(to: UInt8.self)
                for row in 0..<height {
                    for col in 0..<width {
                        let offset = row * bytesPerRow + col * 4
                        rowPtr[offset] = pixel[0]
                        rowPtr[offset + 1] = pixel[1]
                        rowPtr[offset + 2] = pixel[2]
                        rowPtr[offset + 3] = pixel[3]
                    }
                }
            }
            CVPixelBufferUnlockBaseAddress(pixelBuffer, [])

            let presentationTime = CMTime(value: Int64(frameIndex), timescale: fps)
            adaptor.append(pixelBuffer, withPresentationTime: presentationTime)
        }

        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed {
            throw SpikeExportError.generic("Synthetic clip writer failed: \(writer.error?.localizedDescription ?? "unknown")")
        }
        return url
    }

    // MARK: - Crossfade + text-overlay export

    struct ExportResult {
        let durationSeconds: Double
        let fileSizeBytes: Int
    }

    private static func crossfadeExport(
        clipA: URL,
        clipB: URL,
        crossfadeDuration: Double,
        outputURL: URL
    ) async throws -> ExportResult {
        let assetA = AVURLAsset(url: clipA)
        let assetB = AVURLAsset(url: clipB)

        let durationA = try await assetA.load(.duration)
        let durationB = try await assetB.load(.duration)
        guard let trackA = try await assetA.loadTracks(withMediaType: .video).first,
              let trackB = try await assetB.loadTracks(withMediaType: .video).first else {
            throw SpikeExportError.generic("Synthetic clips have no video track.")
        }
        let naturalSize = try await trackA.load(.naturalSize)

        let composition = AVMutableComposition()
        guard let compTrackA = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
              let compTrackB = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw SpikeExportError.generic("Failed to add composition tracks.")
        }

        // Clip A plays [0, durationA]; clip B starts `crossfadeDuration`
        // early so the two overlap for exactly the crossfade window — the
        // standard AVFoundation crossfade recipe (overlapping tracks +
        // opacity ramps on each layer instruction).
        try compTrackA.insertTimeRange(CMTimeRange(start: .zero, duration: durationA), of: trackA, at: .zero)
        let clipBStart = CMTimeSubtract(durationA, CMTime(seconds: crossfadeDuration, preferredTimescale: 600))
        try compTrackB.insertTimeRange(CMTimeRange(start: .zero, duration: durationB), of: trackB, at: clipBStart)

        let totalDuration = CMTimeAdd(clipBStart, durationB)

        let instructionA = AVMutableVideoCompositionLayerInstruction(assetTrack: compTrackA)
        let fadeStart = clipBStart
        let fadeEnd = durationA
        instructionA.setOpacityRamp(fromStartOpacity: 1.0, toEndOpacity: 0.0, timeRange: CMTimeRange(start: fadeStart, end: fadeEnd))

        let instructionB = AVMutableVideoCompositionLayerInstruction(assetTrack: compTrackB)
        instructionB.setOpacityRamp(fromStartOpacity: 0.0, toEndOpacity: 1.0, timeRange: CMTimeRange(start: fadeStart, end: fadeEnd))

        let mainInstruction = AVMutableVideoCompositionInstruction()
        mainInstruction.timeRange = CMTimeRange(start: .zero, duration: totalDuration)
        mainInstruction.layerInstructions = [instructionB, instructionA]

        let videoComposition = AVMutableVideoComposition()
        videoComposition.renderSize = naturalSize
        videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
        videoComposition.instructions = [mainInstruction]

        // Text overlay via AVVideoCompositionCoreAnimationTool — plan M1
        // item 3's "text-overlay" half of the fixture EDL.
        let overlayLayer = CATextLayer()
        overlayLayer.string = "kneecap M1 spike"
        overlayLayer.fontSize = 28
        overlayLayer.alignmentMode = .center
        overlayLayer.foregroundColor = UIColor.white.cgColor
        overlayLayer.frame = CGRect(x: 0, y: naturalSize.height / 2 - 20, width: naturalSize.width, height: 40)
        overlayLayer.contentsScale = UIScreen.main.scale

        let videoLayer = CALayer()
        videoLayer.frame = CGRect(origin: .zero, size: naturalSize)
        let parentLayer = CALayer()
        parentLayer.frame = CGRect(origin: .zero, size: naturalSize)
        parentLayer.addSublayer(videoLayer)
        parentLayer.addSublayer(overlayLayer)

        videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(
            postProcessingAsVideoLayer: videoLayer,
            in: parentLayer
        )

        guard let exportSession = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
            throw SpikeExportError.generic("Could not create AVAssetExportSession.")
        }
        exportSession.outputURL = outputURL
        exportSession.outputFileType = .mov
        exportSession.videoComposition = videoComposition

        await exportSession.export()

        guard exportSession.status == .completed else {
            let message = exportSession.error?.localizedDescription ?? "unknown export error"
            throw SpikeExportError.generic("Export failed: \(message)")
        }

        // Confirm the file plays (plan M1 item 3: "confirm the file plays")
        // — verified by loading duration + isPlayable from the OUTPUT file,
        // not assumed from a successful export status alone.
        let outputAsset = AVURLAsset(url: outputURL)
        let isPlayable = try await outputAsset.load(.isPlayable)
        let outputDuration = try await outputAsset.load(.duration)
        guard isPlayable else {
            throw SpikeExportError.generic("Exported file reports isPlayable == false.")
        }

        let attributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
        let fileSize = (attributes[.size] as? Int) ?? 0

        return ExportResult(durationSeconds: CMTimeGetSeconds(outputDuration), fileSizeBytes: fileSize)
    }
}

enum SpikeExportError: LocalizedError {
    case generic(String)
    var errorDescription: String? {
        switch self {
        case .generic(let message): return message
        }
    }
}
