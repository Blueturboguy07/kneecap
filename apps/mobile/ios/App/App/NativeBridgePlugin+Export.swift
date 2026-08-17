import Foundation
import Capacitor
import Photos

/// kneecap M9 — the native half of `NativeBridge.exportProject()`
/// (packages/native-bridge/src/capacitor-bridge.ts). All the actual mapping
/// (EDL -> AVMutableComposition -> hardware encode) lives in the
/// platform-agnostic `NativeExport/*.swift` files, independently testable
/// via `apps/mobile/ios/verify-export-pipeline` — this file's own job is
/// just decoding the call's `edl` payload, asset-URI resolution against
/// real M4 media custody, Capacitor call/event plumbing (same
/// resolve-immediately-then-stream-`notifyListeners`-events shape as
/// `NativeBridgePlugin+Media.swift`'s `generateProxy`), and the
/// Photos-library save (plan M9 item 8).
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

                let outputURL = try MediaSandbox.exportURL(exportId: exportId)
                let result = try await EdlExporter.export(
                    edl: edl,
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

                // Plan M9 item 8: "Save to Photos / Gallery, then the
                // system share sheet." Best-effort — a denied/undetermined
                // Photos permission does not fail the export itself (the
                // file is already a real, valid deliverable in sandbox
                // custody at `result.outputURL`); it only skips the
                // library copy. The share sheet itself is a UI-layer
                // concern (M6-M8), not this bridge method's job.
                await Self.saveToPhotosLibraryBestEffort(url: result.outputURL)

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

    private static func saveToPhotosLibraryBestEffort(url: URL) async {
        let status = await withCheckedContinuation { (continuation: CheckedContinuation<PHAuthorizationStatus, Never>) in
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { continuation.resume(returning: $0) }
        }
        guard status == .authorized || status == .limited else { return }
        _ = try? await PHPhotoLibrary.shared().performChanges {
            PHAssetChangeRequest.creationRequestForAssetOfVideo(atFileURL: url)
        }
    }
}

private extension PHAssetChangeRequest {
    /// `PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL:)`
    /// is the real API name; aliased here only so the call site above
    /// reads unambiguously as "of a video" at a glance. (Kept as a thin
    /// wrapper rather than inlining the long official name, purely for
    /// readability — no behavior difference.)
    static func creationRequestForAssetOfVideo(atFileURL url: URL) -> PHAssetChangeRequest? {
        PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
    }
}
