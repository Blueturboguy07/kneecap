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
            let coordinator = MediaPickerCoordinator(
                call: call,
                emitPickProgress: { [weak self] payload in
                    // The post-pick copy can be an iCloud ORIGINAL DOWNLOAD
                    // (minutes for a large video) — without these events the
                    // UI sits on a frozen 0% and reads as stuck (founder's
                    // iPhone, 2026-08-19). Same notifyListeners channel
                    // pattern as "proxyProgress".
                    DispatchQueue.main.async {
                        self?.notifyListeners("pickProgress", data: payload)
                    }
                },
                onFinished: { [weak self] in
                    self?.activePickerCoordinator = nil
                }
            )
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
        // This is a VIDEO transcoder (AVAssetReader/Writer). A still image
        // has no Duration and AVFoundation dies with -11828 "Cannot Open"
        // (founder's iPhone, 2026-08-19). The JS orchestration never calls
        // this for kind=="image" (the proxy IS the source there); reject
        // loudly rather than stream a cryptic AVFoundation error if a
        // future caller regresses.
        if let kind = handle["kind"] as? String, kind == "image" {
            call.reject("generateProxy is video-only; image assets use their source as the proxy", "UNSUPPORTED")
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

    // MARK: - generateThumbnails

    /// M4 item 5, as a directly callable method (the ios track originally
    /// only emitted `thumbnailUris` from `generateProxy`'s terminal event;
    /// the android track had this dedicated method. The bridge unification
    /// keeps BOTH, because they serve different callers — import-time free
    /// output vs. M7's timeline asking for a filmstrip at a given density.)
    ///
    /// A plain resolve-when-done promise, not the event-streaming shape:
    /// see `pluginMethods` in NativeBridgePlugin.swift.
    @objc func generateThumbnails(_ call: CAPPluginCall) {
        guard let handle = call.getObject("handle"),
              let uriString = handle["uri"] as? String,
              let assetId = handle["id"] as? String else {
            call.reject("generateThumbnails requires handle.{id,uri}", "IO_ERROR")
            return
        }
        let sourceURL = URL(fileURLWithPath: uriString)
        guard FileManager.default.fileExists(atPath: sourceURL.path) else {
            call.reject("no such file at handle.uri: \(uriString)", "IO_ERROR")
            return
        }

        let specDict = call.getObject("spec") ?? [:]
        let count = max(1, (specDict["count"] as? Int) ?? 10)
        let maxEdgePx = (specDict["maxEdgePx"] as? Int) ?? 240
        // `durationMicros` rides on the handle the JS side already probed
        // (`MediaHandle.durationMicros`) — integer micros, never float
        // seconds, per plan §2.2's unit discipline.
        let durationMicros = (handle["durationMicros"] as? Int) ?? 0

        Task {
            do {
                let thumbDir = try MediaSandbox.thumbnailDirectory(assetId: assetId)
                let urls = try await ThumbnailStripGenerator.generate(
                    sourceURL: sourceURL,
                    outputDirectory: thumbDir,
                    count: count,
                    maxDimension: CGFloat(maxEdgePx)
                )
                // Mirrors `ThumbnailStripGenerator.generate`'s own sampling
                // math exactly (cell MIDPOINTS: (i + 0.5)/n of the
                // duration, not left edges) so the timestamps this returns
                // describe the frames it actually wrote. Integer arithmetic
                // throughout — `(2i + 1) * duration / 2n` is the midpoint
                // formula with no floating-point hop.
                let n = urls.count
                let timestampsMicros: [Int] = (0..<n).map { i in
                    n == 0 ? 0 : (durationMicros * (2 * i + 1)) / (2 * n)
                }
                call.resolve([
                    "assetId": assetId,
                    "uris": urls.map { $0.path },
                    "timestampsMicros": timestampsMicros,
                ])
            } catch {
                call.reject("thumbnail generation failed: \(String(describing: error))", "IO_ERROR")
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
    private let emitPickProgress: ([String: Any]) -> Void
    private let onFinished: () -> Void

    init(
        call: CAPPluginCall,
        emitPickProgress: @escaping ([String: Any]) -> Void,
        onFinished: @escaping () -> Void
    ) {
        self.call = call
        self.emitPickProgress = emitPickProgress
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
            for (index, result) in results.enumerated() {
                let outcome = await Self.importOne(
                    result: result,
                    onFraction: { [emitPickProgress] fraction in
                        emitPickProgress([
                            "index": index,
                            "total": results.count,
                            "stage": "loading",
                            "fraction": fraction,
                        ])
                    }
                )
                switch outcome {
                case .imported(let handleDict):
                    emitPickProgress([
                        "index": index,
                        "total": results.count,
                        "stage": "loaded",
                        "fraction": 1,
                    ])
                    handles.append(handleDict)
                case .failed(let reason):
                    // A dropped item must be VISIBLE: with every item failing
                    // (e.g. iCloud originals with no network) the old silent
                    // nil-drop resolved `handles: []` — indistinguishable
                    // from a user cancel, and the app just sat there
                    // (founder's iPhone, 2026-08-19).
                    emitPickProgress([
                        "index": index,
                        "total": results.count,
                        "stage": "error",
                        "fraction": 1,
                        "error": reason,
                    ])
                }
            }
            call.resolve(["handles": handles])
            onFinished()
        }
    }

    enum ImportOutcome {
        case imported([String: Any])
        case failed(String)
    }

    /// Thread-safe holder so the KVO observation can be created after the
    /// load call returns its Progress, yet invalidated from the load's
    /// completion (which may run on any queue) before the Progress dies.
    private final class ObservationBox: @unchecked Sendable {
        private let lock = NSLock()
        private var _observation: NSKeyValueObservation?
        private var dead = false
        var observation: NSKeyValueObservation? {
            get { lock.lock(); defer { lock.unlock() }; return _observation }
            set {
                lock.lock()
                defer { lock.unlock() }
                if dead {
                    // The load completion already ran (fast local file) —
                    // the Progress may be moments from dealloc; kill the
                    // observation NOW rather than at box deinit.
                    newValue?.invalidate()
                    _observation = nil
                    return
                }
                _observation = newValue
            }
        }
        func invalidate() {
            lock.lock()
            defer { lock.unlock() }
            dead = true
            _observation?.invalidate()
            _observation = nil
        }
    }

    /// Loads one `PHPickerResult`'s file representation, copies it into
    /// sandboxed media custody, and probes it. Returns `.failed(reason)`
    /// (rather than failing the whole batch) for a single result this repo
    /// can't handle — so one bad pick in a multi-select doesn't lose the
    /// rest, and the failure is EMITTED as a pickProgress error event rather
    /// than silently dropped (the silent drop made an all-iCloud-failure
    /// batch indistinguishable from a user cancel — founder's iPhone,
    /// 2026-08-19).
    private static func importOne(
        result: PHPickerResult,
        onFraction: @escaping (Double) -> Void
    ) async -> ImportOutcome {
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
            return .failed("item has neither a movie nor an image representation")
        }

        let assetId = UUID().uuidString

        // `loadFileRepresentation`'s temp URL is only valid inside this
        // completion handler — the copy into sandbox custody MUST happen
        // synchronously here, not after resuming the continuation, or the OS
        // may have already reclaimed the temp file. For an iCloud-offloaded
        // original this call IS the download; its returned `Progress` is the
        // only feedback that exists, so it's observed and forwarded.
        enum LoadResult {
            case success(URL)
            case failure(String)
        }
        // The observation's lifetime must be OURS, invalidated before the
        // Progress deallocates — tying it to the Progress via an associated
        // object (the first version) releases it DURING the observee's
        // dealloc, a classic KVO teardown-ordering crash window right at
        // the pick→import boundary.
        let observationBox = ObservationBox()
        let outcome: LoadResult = await withCheckedContinuation { (continuation: CheckedContinuation<LoadResult, Never>) in
            let progress = provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { tempURL, error in
                observationBox.invalidate()
                if let error {
                    continuation.resume(returning: .failure(error.localizedDescription))
                    return
                }
                guard let tempURL else {
                    continuation.resume(returning: .failure("no file representation returned"))
                    return
                }
                let ext = tempURL.pathExtension.isEmpty
                    ? (kind == "video" ? "mov" : "jpg")
                    : tempURL.pathExtension
                do {
                    let copied = try MediaSandbox.copyIntoMediaCustody(
                        sourceURL: tempURL,
                        assetId: assetId,
                        fileExtension: ext
                    )
                    continuation.resume(returning: .success(copied))
                } catch {
                    continuation.resume(returning: .failure("copy into custody failed: \(error.localizedDescription)"))
                }
            }
            observationBox.observation = progress.observe(\.fractionCompleted, options: [.new]) { prog, _ in
                onFraction(prog.fractionCompleted)
            }
        }
        withExtendedLifetime(observationBox) {}

        let custodyURL: URL
        switch outcome {
        case .success(let url): custodyURL = url
        case .failure(let reason): return .failed(reason)
        }

        if kind == "image" {
            let attrs = try? FileManager.default.attributesOfItem(atPath: custodyURL.path)
            let sizeBytes = (attrs?[.size] as? Int) ?? 0
            return .imported([
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
            ])
        }

        guard let probed = try? await MediaProbe.probe(url: custodyURL) else {
            return .failed("probe failed — unsupported or corrupt media")
        }
        let attrs = try? FileManager.default.attributesOfItem(atPath: custodyURL.path)
        let sizeBytes = (attrs?[.size] as? Int) ?? 0

        var frameRate: Any = NSNull()
        if let num = probed.frameRateNumerator, let den = probed.frameRateDenominator {
            frameRate = ["numerator": num, "denominator": den]
        }

        return .imported([
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
        ])
    }
}
