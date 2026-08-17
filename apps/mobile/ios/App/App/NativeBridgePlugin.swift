import Foundation
import Capacitor
import UIKit

/// kneecap M3 — the native half of `NativeBridge.capabilities()`
/// (packages/native-bridge/src/capacitor-bridge.ts). This is the ONE bridge
/// method that is genuinely wired end-to-end in M3: everything else on the
/// TS side throws NOT_IMPLEMENTED pending M4/M9/M10. This plugin's whole job
/// is to prove the JS<->native round trip actually works.
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
    ]

    /// Retains the `PHPickerViewControllerDelegate` for the duration of an
    /// in-flight `pickMedia` call — `PHPickerViewController.delegate` is
    /// `weak`, so nothing else holds this. See
    /// `NativeBridgePlugin+Media.swift`.
    var activePickerCoordinator: AnyObject?

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
