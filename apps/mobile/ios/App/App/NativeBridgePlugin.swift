import Foundation
import Capacitor
import UIKit

/// kneecap M3 — the native half of `NativeBridge.capabilities()`
/// (packages/native-bridge/src/capacitor-bridge.ts). This is the ONE bridge
/// method that is genuinely wired end-to-end in M3: everything else on the
/// TS side throws NOT_IMPLEMENTED pending M4/M9/M10. This plugin's whole job
/// is to prove the JS<->native round trip actually works.
///
/// M10 STATUS: no `transcribe` method has been added to this class yet, on
/// purpose — see `WhisperTranscriber.swift`'s header comment in this same
/// directory for the real (unwired) transcription code and exactly why
/// adding a method here first would break this file's CI-verified compile.
/// The Android side of M10 differs here: Java's `native` method
/// declarations compile without a `.so` present, so
/// `NativeBridgePlugin.java` DOES have a real `transcribe` method already
/// (see that file) — Swift + a missing xcframework has no equivalent safe
/// half-step.
///
/// Registration: Capacitor discovers local (non-npm) plugins that conform to
/// `CAPBridgedPlugin` via Objective-C runtime reflection — no explicit
/// registration call needed here (unlike Android's `registerPlugin(...)` in
/// MainActivity). `jsName` below ("NativeBridge") must match the string
/// `registerPlugin<NativeBridgePluginSpec>("NativeBridge")` uses on the TS
/// side (packages/native-bridge/src/capacitor-bridge.ts).
@objc(NativeBridgePlugin)
public class NativeBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeBridgePlugin"
    public let jsName = "NativeBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getDeviceInfo", returnType: CAPPluginReturnPromise),
        // kneecap M4 — see NativeBridgePlugin+Media.swift for the
        // implementations. `pickMedia` is a normal promise call (resolves
        // once, with the picked+probed handles). `generateProxy` resolves
        // immediately with an acknowledgement and streams its real result
        // via `notifyListeners("proxyProgress", ...)` events instead —
        // Capacitor promise calls can only resolve once, but
        // `NativeBridge.generateProxy()`'s TS contract is an
        // AsyncGenerator<ProxyProgress>, so progress has to ride the
        // separate (well-established, e.g. @capacitor/app's
        // "appStateChange") event-listener mechanism, not the call's own
        // promise.
        CAPPluginMethod(name: "pickMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generateProxy", returnType: CAPPluginReturnPromise),
        // Unlike `generateProxy`, this one is a plain resolve-when-done
        // call — a handful of JPEGs is fast enough that streaming progress
        // isn't worth the complexity (see `ThumbnailStripSpec` in
        // packages/native-bridge/src/types.ts). Added when the ios and
        // android tracks' bridges were unified: Android exposed this
        // dedicated method while iOS only emitted thumbnail paths as a
        // side effect of `generateProxy`; both now exist on both platforms
        // rather than one being an Android-only trap for M7's timeline.
        CAPPluginMethod(name: "generateThumbnails", returnType: CAPPluginReturnPromise),
        // kneecap M9 — see NativeBridgePlugin+Export.swift. Same
        // resolve-immediately-then-stream-events shape as `generateProxy`
        // above (`exportProgress` events keyed by a client-generated
        // `exportId`, since — unlike `generateProxy`'s `assetId` — an
        // export has no other natural per-call domain identifier to filter
        // events on).
        CAPPluginMethod(name: "exportProject", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportCancel", returnType: CAPPluginReturnPromise),
    ]

    /// Retains the `PHPickerViewControllerDelegate` for the duration of an
    /// in-flight `pickMedia` call — `PHPickerViewController.delegate` is
    /// `weak`, so nothing else holds this. See
    /// `NativeBridgePlugin+Media.swift`.
    var activePickerCoordinator: AnyObject?

    /// kneecap M9 — one `EdlExportHandle` per in-flight `exportProject`
    /// call, keyed by the client-generated `exportId`, so a later
    /// `exportCancel(exportId)` call can find and cancel the right one.
    /// Removed from the dictionary once that export reaches a terminal
    /// stage (done/error/cancelled) — see `NativeBridgePlugin+Export.swift`.
    var activeExportHandles: [String: EdlExportHandle] = [:]

    /// The classic `uname()` trick for a real device identifier
    /// ("iPhone15,2") instead of `UIDevice.current.model`'s generic "iPhone".
    /// Falls back to the generic model name in the Simulator, where
    /// `machine` reports the host Mac's architecture instead.
    private func deviceIdentifier() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let machineMirror = Mirror(reflecting: systemInfo.machine)
        let identifier = machineMirror.children.reduce("") { partial, element in
            guard let value = element.value as? Int8, value != 0 else { return partial }
            return partial + String(UnicodeScalar(UInt8(value)))
        }
        if identifier.isEmpty || identifier.hasPrefix("x86_64") || identifier.hasPrefix("arm64") {
            return UIDevice.current.model
        }
        return identifier
    }

    @objc func getDeviceInfo(_ call: CAPPluginCall) {
        let physicalMemoryBytes = ProcessInfo.processInfo.physicalMemory
        let ramTierMb = Int(physicalMemoryBytes / (1024 * 1024))
        call.resolve([
            "osVersion": UIDevice.current.systemVersion,
            "deviceModel": deviceIdentifier(),
            "ramTierMb": ramTierMb
        ])
    }
}
