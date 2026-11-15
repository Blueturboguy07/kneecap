import Foundation
import Capacitor
import Photos
import CoreImage
import ImageIO
import UIKit

/// kneecap M9 — the native half of `NativeBridge.exportProject()`
/// (packages/native-bridge/src/capacitor-bridge.ts). All the actual mapping
/// (EDL -> AVMutableComposition -> hardware encode) lives in the
/// platform-agnostic `NativeExport/*.swift` files, independently testable
/// via `apps/mobile/ios/verify-export-pipeline` — this file's own job is
/// just decoding the call's `edl` payload, asset-URI resolution against
/// real M4 media custody, Capacitor call/event plumbing (same
/// resolve-immediately-then-stream-`notifyListeners`-events shape as
/// `NativeBridgePlugin+Media.swift`'s `generateProxy`), and the export
/// sheet's result block (1.0.5, blind test round 2): `saveToPhotos` (plan
/// M9 item 8) and `shareFile`. 1.0.6: no method opens the Photos app. No
/// public API does that, and the private Photos URL scheme breaks App
/// Store guideline 2.5.1 (`check-ios-app.sh` fails a build that has it).
extension NativeBridgePlugin {

    @objc func exportProject(_ call: CAPPluginCall) {
        guard let exportId = call.getString("exportId") else {
            call.reject("exportProject requires exportId")
            return
        }
        guard let edlDict = call.getObject("edl") else {
            call.reject("exportProject requires edl")
            return
        }

        let edl: EdlDocument
        do {
            edl = try EdlDecoder.decode(jsObject: edlDict)
        } catch {
            call.reject("could not decode EDL: \(String(describing: error))")
            return
        }

        var assetById: [String: EdlAsset] = [:]
        for a in edl.assets { assetById[a.assetId] = a }

        // PRERENDERED OVERLAYS (round 37): text/caption images produced by
        // the PREVIEW's own drawing code
        // (editor-core/export/overlay-frames.ts), each covering an output
        // span. When present, the exporter composites these instead of
        // re-rasterizing text and captions in CoreText — one implementation,
        // so preview and export cannot drift. Decoding failures degrade to
        // the native path rather than failing the export.
        var overlayFrames: [PrerenderedOverlayFrame] = []
        for entry in call.getArray("overlayFrames") ?? [] {
            guard let dict = entry as? [String: Any],
                  let base64 = dict["pngBase64"] as? String,
                  let startTicks = (dict["startTicks"] as? NSNumber)?.int64Value,
                  let endTicks = (dict["endTicks"] as? NSNumber)?.int64Value,
                  endTicks > startTicks,
                  let data = Data(base64Encoded: base64),
                  let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                print("[kneecap-export] overlay frame could not be decoded — skipped")
                continue
            }
            overlayFrames.append(
                PrerenderedOverlayFrame(
                    startTicks: startTicks,
                    endTicks: endTicks,
                    image: CIImage(cgImage: image)
                )
            )
        }
        if !overlayFrames.isEmpty {
            print("[kneecap-export] using \(overlayFrames.count) prerendered overlay frame(s) from the preview renderer")
        }

        let handle = EdlExportHandle()
        activeExportHandles[exportId] = handle

        // Resolves immediately — see the `pluginMethods` comment in
        // NativeBridgePlugin.swift. The real result streams via
        // "exportProgress" events keyed by `exportId`.
        call.resolve(["accepted": true])

        Task { [weak self] in
            guard let self else { return }
            defer { self.activeExportHandles.removeValue(forKey: exportId) }
            do {
                self.emitExportProgress(exportId: exportId, stage: "preparing", fraction: 0)

                // Reclaim space BEFORE writing a new export: the container
                // keeps a full copy of every export alongside the one in
                // Photos, and an unbounded pile of them fills the device.
                MediaSandbox.pruneOldExports()
                print("[kneecap-storage] custody usage: \(MediaSandbox.usageReport())")

                let outputURL = try MediaSandbox.exportURL(exportId: exportId)
                let result = try await EdlExporter.export(
                    edl: edl,
                    overlayFrames: overlayFrames,
                    resolveAssetURL: { asset in
                        // `EdlAsset.sourceUri` is a plain sandbox filesystem
                        // path for a natively-imported asset (M4's real
                        // `pickMedia`/`generateProxy` custody — see
                        // `packages/native-bridge/src/types.ts`'s
                        // `MediaHandle.uri` doc comment: "an app-sandbox
                        // path ... NEVER a blob: URL"). A `kneecap-media://`
                        // placeholder scheme (as used by hand-authored test
                        // EDLs, never by the real producer) has no real
                        // file behind it and resolves to `nil`, which
                        // `CompositionBuilder` surfaces as a clear
                        // `assetNotResolvable` error rather than crashing.
                        guard let uri = asset.sourceUri, !uri.hasPrefix("kneecap-media://") else { return nil }
                        return URL(fileURLWithPath: uri)
                    },
                    outputURL: outputURL,
                    handle: handle,
                    onProgress: { [weak self] fraction in
                        DispatchQueue.main.async {
                            self?.emitExportProgress(exportId: exportId, stage: "encoding", fraction: fraction)
                        }
                    }
                )

                self.emitExportProgress(exportId: exportId, stage: "muxing", fraction: 0.99)

                // DONE FIRST: the file is already a real, valid deliverable
                // at result.outputURL. An old order awaited the Photos save
                // BEFORE emitting done, and the Photos permission prompt made
                // export completion hang indefinitely (caught by the headless
                // #/autotest export phase, 2026-08-20: encode+mux+integrity
                // all finished, "done" never arrived). The Photos save is NOT
                // done here any more (1.0.5): the export sheet calls
                // `saveToPhotos` after "done", shows "Saving to Photos…" while
                // the permission prompt and the save run, and then shows the
                // real result. One save per export, never a silent one.
                self.emitExportProgress(
                    exportId: exportId,
                    stage: "done",
                    fraction: 1,
                    outputUri: result.outputURL.path
                )
            } catch {
                self.emitExportProgress(
                    exportId: exportId,
                    stage: "error",
                    fraction: 1,
                    error: String(describing: error)
                )
            }
        }
    }

    @objc func exportCancel(_ call: CAPPluginCall) {
        guard let exportId = call.getString("exportId") else {
            call.reject("exportCancel requires exportId")
            return
        }
        activeExportHandles[exportId]?.cancel()
        call.resolve(["accepted": true])
    }

    private func emitExportProgress(
        exportId: String,
        stage: String,
        fraction: Double,
        outputUri: String? = nil,
        error: String? = nil
    ) {
        var data: [String: Any] = ["exportId": exportId, "stage": stage, "fraction": fraction]
        if let outputUri { data["outputUri"] = outputUri }
        if let error { data["error"] = error }
        notifyListeners("exportProgress", data: data)
    }

    // MARK: - The export sheet's result block (1.0.5)

    /// Saves one finished export to the Photos library and answers
    /// `{saved: true}`, or `{saved: false, reason: "denied" | "failed"}`.
    /// Asks for add-only Photos access first when it was never asked
    /// (the prompt shows while the sheet says "Saving to Photos…"), and
    /// resolves only when the save is really done. A pre-granted
    /// `photos-add` (the simulator test) skips the prompt.
    @objc func saveToPhotos(_ call: CAPPluginCall) {
        guard let fileURL = exportedFileURL(call, method: "saveToPhotos") else { return }
        Task {
            let outcome = await Self.saveVideoToPhotos(url: fileURL)
            switch outcome {
            case .saved:
                call.resolve(["saved": true])
            case .denied:
                call.resolve(["saved": false, "reason": "denied"])
            case .failed(let detail):
                print("[kneecap-export] save to Photos failed: \(detail)")
                call.resolve(["saved": false, "reason": "failed"])
            }
        }
    }

    /// Opens the system share sheet for one finished export. Resolves once
    /// the sheet is on screen (not when the person closes it).
    @objc func shareFile(_ call: CAPPluginCall) {
        guard let fileURL = exportedFileURL(call, method: "shareFile") else { return }
        DispatchQueue.main.async { [weak self] in
            guard var presenter = self?.bridge?.viewController else {
                call.reject("no view controller available to present Share from", "IO_ERROR")
                return
            }
            // Present from the top-most screen: a controller that already
            // presents something ignores a second `present`, and the call
            // would never resolve.
            while let presented = presenter.presentedViewController, !presented.isBeingDismissed {
                presenter = presented
            }
            let sheet = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
            // iPad shows the share sheet as a popover, which needs an anchor:
            // the centre of the presenting view, with no arrow.
            if let popover = sheet.popoverPresentationController {
                let bounds = presenter.view.bounds
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(x: bounds.midX, y: bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            presenter.present(sheet, animated: true) {
                call.resolve(["shown": true])
            }
        }
    }

    /// The export file a result-block call names, or nil after rejecting the
    /// call. Takes a raw path or a `file://` URL, and ONLY a file in the
    /// exports directory: these calls exist for the video the export sheet
    /// just made, not for any path the web view sends.
    private func exportedFileURL(_ call: CAPPluginCall, method: String) -> URL? {
        guard let raw = call.getString("uri"), !raw.isEmpty else {
            call.reject("\(method) requires uri", "IO_ERROR")
            return nil
        }
        let named: URL
        if raw.hasPrefix("file://"), let parsed = URL(string: raw), parsed.isFileURL {
            named = parsed
        } else {
            named = URL(fileURLWithPath: raw)
        }
        guard let exportsDirectory = try? MediaSandbox.exportsDirectory() else {
            call.reject("\(method): no exports directory", "IO_ERROR")
            return nil
        }
        let filePath = named.standardizedFileURL.resolvingSymlinksInPath().path
        let directoryPath = exportsDirectory.standardizedFileURL.resolvingSymlinksInPath().path
        guard filePath.hasPrefix(directoryPath + "/") else {
            call.reject("\(method) only takes a finished export", "UNSUPPORTED")
            return nil
        }
        guard FileManager.default.fileExists(atPath: filePath) else {
            call.reject("\(method): the exported video is no longer on this device", "IO_ERROR")
            return nil
        }
        return URL(fileURLWithPath: filePath)
    }

    enum PhotosSaveOutcome {
        case saved
        case denied
        case failed(String)
    }

    /// Plan M9 item 8, "Save to Photos / Gallery". Add-only access is all
    /// this needs (NSPhotoLibraryAddUsageDescription in Info.plist).
    static func saveVideoToPhotos(url: URL) async -> PhotosSaveOutcome {
        var status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        if status == .notDetermined {
            status = await withCheckedContinuation { (continuation: CheckedContinuation<PHAuthorizationStatus, Never>) in
                PHPhotoLibrary.requestAuthorization(for: .addOnly) { continuation.resume(returning: $0) }
            }
        }
        guard status == .authorized || status == .limited else { return .denied }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                _ = PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
            }
            return .saved
        } catch {
            return .failed(String(describing: error))
        }
    }
}
