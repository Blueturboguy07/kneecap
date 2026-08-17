import Foundation
import Capacitor
import PhotosUI
import UniformTypeIdentifiers

/// kneecap M4 — the native half of `NativeBridge.pickMedia()` and
/// `NativeBridge.generateProxy()` (packages/native-bridge/src/capacitor-bridge.ts).
///
/// Delegates all the actual media-handling work to the platform-agnostic
/// `NativeMedia/*.swift` files (probe/transcode/thumbnails/sandbox custody)
/// so that logic stays independently testable via
/// `apps/mobile/ios/verify-media-pipeline` — this file's own job is just
/// PHPickerViewController presentation and Capacitor call/event plumbing.
extension NativeBridgePlugin {

    // MARK: - pickMedia

    @objc func pickMedia(_ call: CAPPluginCall) {
        let kinds = call.getArray("kinds", String.self) ?? ["video"]
        let allowMultiple = call.getBool("allowMultiple") ?? false

        var filters: [PHPickerFilter] = []
        if kinds.contains("video") { filters.append(.videos) }
        if kinds.contains("image") { filters.append(.images) }
        // "audio" is not representable via PHPicker (Photos library is
        // video/image only) — plan M8's device-audio-import is a separate,
        // document-picker-based flow. A kinds:["audio"]-only request with no
        // usable filter falls through to the videos+images default below
        // rather than presenting an empty picker.

        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.filter = filters.isEmpty ? .any(of: [.videos, .images]) : .any(of: filters)
        config.selectionLimit = allowMultiple ? 0 : 1

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let presenter = self.bridge?.viewController else {
                call.reject("no view controller available to present the picker from")
                return
            }
            let picker = PHPickerViewController(configuration: config)
            let coordinator = MediaPickerCoordinator(call: call) { [weak self] in
                self?.activePickerCoordinator = nil
            }
            self.activePickerCoordinator = coordinator
            picker.delegate = coordinator
            presenter.present(picker, animated: true)
        }
    }

    // MARK: - generateProxy

    @objc func generateProxy(_ call: CAPPluginCall) {
        guard let handle = call.getObject("handle"),
              let uriString = handle["uri"] as? String,
              let assetId = handle["id"] as? String else {
            call.reject("generateProxy requires handle.{id,uri}")
            return
        }
        let sourceURL = URL(fileURLWithPath: uriString)
        guard FileManager.default.fileExists(atPath: sourceURL.path) else {
            call.reject("no such file at handle.uri: \(uriString)")
            return
        }

        let specDict = call.getObject("spec") ?? [:]
        let targetShortEdge = (specDict["targetHeight"] as? Int) ?? 540
        let shortGop = (specDict["shortGop"] as? Bool) ?? true
        // "short-GOP" per plan Amendment 4 / M4 item 4: near-all-intra for
        // scrub-friendly random access. 15 frames @ ~30fps is a ~0.5s max
        // seek-to-nearest-keyframe cost; `false` falls back to a
        // conventional GOP (still far shorter than typical camera output's
        // 1-2s GOPs) rather than disabling the mechanism entirely.
        let gopInterval = shortGop ? 15 : 90

        // Resolves immediately — see the `pluginMethods` comment in
        // NativeBridgePlugin.swift for why. The real result streams via
        // "proxyProgress" events keyed by `assetId`.
        call.resolve(["accepted": true])

        Task { [weak self] in
            guard let self else { return }
            do {
                self.emitProxyProgress(assetId: assetId, stage: "transcoding", fraction: 0)

                let proxyURL = try MediaSandbox.proxyURL(assetId: assetId)
                let spec = ProxySpec(targetShortEdge: targetShortEdge, shortGopInterval: gopInterval)
                let result = try await ProxyTranscoder.transcode(
                    sourceURL: sourceURL,
                    outputURL: proxyURL,
                    spec: spec,
                    onProgress: { [weak self] fraction in
                        // `onProgress` fires on the transcoder's own
                        // dispatch queue, not necessarily main — Capacitor's
                        // `notifyListeners` is documented safe to call off
                        // main, but coalesce onto main anyway since this
                        // repo's other native->JS calls do.
                        DispatchQueue.main.async {
                            self?.emitProxyProgress(assetId: assetId, stage: "transcoding", fraction: fraction)
                        }
                    }
                )

                self.emitProxyProgress(assetId: assetId, stage: "transcoding", fraction: 0.95)
                let thumbDir = try MediaSandbox.thumbnailDirectory(assetId: assetId)
                let thumbURLs = try await ThumbnailStripGenerator.generate(
                    sourceURL: sourceURL,
                    outputDirectory: thumbDir,
                    count: 10
                )

                self.emitProxyProgress(
                    assetId: assetId,
                    stage: "done",
                    fraction: 1,
                    proxyUri: result.outputURL.path,
                    proxyWidth: result.width,
                    proxyHeight: result.height,
                    thumbnailUris: thumbURLs.map { $0.path }
                )
            } catch {
                self.emitProxyProgress(
                    assetId: assetId,
                    stage: "error",
                    fraction: 1,
                    error: String(describing: error)
                )
            }
        }
    }

    private func emitProxyProgress(
        assetId: String,
        stage: String,
        fraction: Double,
        proxyUri: String? = nil,
        proxyWidth: Int? = nil,
        proxyHeight: Int? = nil,
        thumbnailUris: [String]? = nil,
        error: String? = nil
    ) {
        var data: [String: Any] = ["assetId": assetId, "stage": stage, "fraction": fraction]
        if let proxyUri { data["proxyUri"] = proxyUri }
        if let proxyWidth { data["proxyWidth"] = proxyWidth }
        if let proxyHeight { data["proxyHeight"] = proxyHeight }
        if let thumbnailUris { data["thumbnailUris"] = thumbnailUris }
        if let error { data["error"] = error }
        notifyListeners("proxyProgress", data: data)
    }
}

/// Owns one `pickMedia` call's round trip: presentation -> selection ->
/// per-result copy-into-custody + probe -> resolve. A fresh instance per
/// call (rather than reusing one delegate across calls) so concurrent
/// `pickMedia` calls (not expected from the JS side today, but not
/// forbidden by the bridge contract either) can't cross-talk.
final class MediaPickerCoordinator: NSObject, PHPickerViewControllerDelegate {
    private let call: CAPPluginCall
    private let onFinished: () -> Void

    init(call: CAPPluginCall, onFinished: @escaping () -> Void) {
        self.call = call
        self.onFinished = onFinished
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)

        guard !results.isEmpty else {
            // User cancelled — matches the web-fallback bridge's "resolve []
            // on cancel" convention (packages/native-bridge/src/web-fallback.ts).
            call.resolve(["handles": []])
            onFinished()
            return
        }

        Task {
            var handles: [[String: Any]] = []
            for result in results {
                if let handleDict = await Self.importOne(result: result) {
                    handles.append(handleDict)
                }
            }
            call.resolve(["handles": handles])
            onFinished()
        }
    }

    /// Loads one `PHPickerResult`'s file representation, copies it into
    /// sandboxed media custody, and probes it. Returns `nil` (rather than
    /// failing the whole batch) for a single result this repo can't handle —
    /// e.g. an item with neither a movie nor an image representation — so
    /// one bad pick in a multi-select doesn't lose the rest.
    private static func importOne(result: PHPickerResult) async -> [String: Any]? {
        let provider = result.itemProvider
        let typeIdentifier: String
        let kind: String
        if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
            typeIdentifier = UTType.movie.identifier
            kind = "video"
        } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            typeIdentifier = UTType.image.identifier
            kind = "image"
        } else {
            return nil
        }

        let assetId = UUID().uuidString

        // `loadFileRepresentation`'s temp URL is only valid inside this
        // completion handler — the copy into sandbox custody MUST happen
        // synchronously here, not after resuming the continuation, or the OS
        // may have already reclaimed the temp file.
        let custodyURL: URL? = await withCheckedContinuation { (continuation: CheckedContinuation<URL?, Never>) in
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { tempURL, error in
                guard let tempURL, error == nil else {
                    continuation.resume(returning: nil)
                    return
                }
                let ext = tempURL.pathExtension.isEmpty
                    ? (kind == "video" ? "mov" : "jpg")
                    : tempURL.pathExtension
                let copied = try? MediaSandbox.copyIntoMediaCustody(
                    sourceURL: tempURL,
                    assetId: assetId,
                    fileExtension: ext
                )
                continuation.resume(returning: copied)
            }
        }

        guard let custodyURL else { return nil }

        if kind == "image" {
            let attrs = try? FileManager.default.attributesOfItem(atPath: custodyURL.path)
            let sizeBytes = (attrs?[.size] as? Int) ?? 0
            return [
                "id": assetId,
                "uri": custodyURL.path,
                "kind": "image",
                "fileName": custodyURL.lastPathComponent,
                "sizeBytes": sizeBytes,
                "durationMicros": 0,
                "width": 0,
                "height": 0,
                "rotationDegrees": 0,
                "hasAudio": false,
                "codec": custodyURL.pathExtension,
                "frameRate": NSNull(),
            ]
        }

        guard let probed = try? await MediaProbe.probe(url: custodyURL) else { return nil }
        let attrs = try? FileManager.default.attributesOfItem(atPath: custodyURL.path)
        let sizeBytes = (attrs?[.size] as? Int) ?? 0

        var frameRate: Any = NSNull()
        if let num = probed.frameRateNumerator, let den = probed.frameRateDenominator {
            frameRate = ["numerator": num, "denominator": den]
        }

        return [
            "id": assetId,
            "uri": custodyURL.path,
            "kind": probed.kind,
            "fileName": custodyURL.lastPathComponent,
            "sizeBytes": sizeBytes,
            "durationMicros": probed.durationMicros,
            "width": probed.width,
            "height": probed.height,
            "rotationDegrees": probed.rotationDegrees,
            "hasAudio": probed.hasAudio,
            "codec": probed.codec,
            "frameRate": frameRate,
        ]
    }
}
