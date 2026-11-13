import Foundation
import Capacitor
import SafariServices
import SwiftUI
import UIKit

/// Sign in with publik: the iOS half of `packages/native-bridge/src/publik-host.ts`.
/// The gate itself (the screens, the 3-second wallet poll, usage counting) is
/// TypeScript: `apps/mobile/src/publik/publik.ts`. This plugin gives it:
///   - `launchInfo`: the app version, the device, and the launch settings
///     (environment, else `-NAME value` launch arguments) named in `settingNames`;
///   - `readFile` / `writeFile` / `removeFile`: `Application Support/publik/<name>`, mode 0600,
///     not backed up, for three names only (the credential, the install ID, the opt-out);
///   - `openBrowser` / `closeBrowser`: the sign-in page in an SFSafariViewController;
///   - `finishSelfTest`: prints the self-test line to stdout, then ends the app;
///   - the `foreground` event: the app became active, or the browser closed;
///   - `showFirstRun`: kneecap's first-run screen (FirstRunView.swift), once per install. The
///     web app calls it AFTER the gate, so "Sign in with publik" is the first screen of a new
///     install (PUBLIK_GATE_MODE=required).
/// Registered in `KneecapBridgeViewController.capacitorDidLoad` (SceneDelegate.swift);
/// `jsName` matches `registerPlugin("PublikGate")` on the TS side.
@objc(PublikGatePlugin)
public class PublikGatePlugin: CAPPlugin, CAPBridgedPlugin, SFSafariViewControllerDelegate {
    public let identifier = "PublikGatePlugin"
    public let jsName = "PublikGate"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "launchInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openBrowser", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeBrowser", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishSelfTest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showFirstRun", returnType: CAPPluginReturnPromise),
    ]

    /// The launch settings the gate reads. Nothing else is read.
    /// `SIMCTL_CHILD_PUBLIK_SELF_TEST=1 xcrun simctl launch ...` sets the environment;
    /// `xcrun simctl launch <device> dev.kneecap.app -PUBLIK_SELF_TEST 1` passes an argument.
    static let settingNames = ["PUBLIK_SELF_TEST", "PUBLIK_API_BASE_URL", "DO_NOT_TRACK", "PUBLIK_TELEMETRY", "PUBLIK_TELEMETRY_DEBUG"]

    static func launchSetting(_ name: String) -> String? {
        if let value = ProcessInfo.processInfo.environment[name], !value.isEmpty { return value }
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-\(name)"), i + 1 < args.count, !args[i + 1].isEmpty { return args[i + 1] }
        return nil
    }

    #if arch(arm64)
    static let arch = "arm64"
    #elseif arch(x86_64)
    static let arch = "x64"
    #else
    static let arch = ""
    #endif

    private var activeObserver: NSObjectProtocol?
    private weak var browser: SFSafariViewController?

    override public func load() {
        activeObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("foreground", data: [:])
        }
    }

    deinit {
        if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
    }

    @objc func launchInfo(_ call: CAPPluginCall) {
        var settings = JSObject()
        for name in Self.settingNames {
            if let value = Self.launchSetting(name) { settings[name] = value }
        }
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        DispatchQueue.main.async {
            call.resolve(["appVersion": version, "deviceName": UIDevice.current.name, "arch": Self.arch, "settings": settings])
        }
    }

    // MARK: files

    private static let allowedNames = try! NSRegularExpression(pattern: "^(apps/[a-z0-9-]+\\.json|telemetry\\.json|consent\\.json)$")

    private static var publikDir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("publik", isDirectory: true)
    }

    private static func fileURL(_ name: String?) -> URL? {
        guard let name, allowedNames.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil else { return nil }
        return publikDir.appendingPathComponent(name)
    }

    @objc func readFile(_ call: CAPPluginCall) {
        guard let url = Self.fileURL(call.getString("name")) else { return call.reject("publik: this file name is not allowed.") }
        if let text = try? String(contentsOf: url, encoding: .utf8) { call.resolve(["text": text]) } else { call.resolve([:]) }
    }

    @objc func writeFile(_ call: CAPPluginCall) {
        guard let url = Self.fileURL(call.getString("name")), let text = call.getString("text") else {
            return call.reject("publik: this file name is not allowed.")
        }
        let data = Data(text.utf8)
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            var root = Self.publikDir
            var values = URLResourceValues()
            values.isExcludedFromBackup = true // the install key belongs to this phone only
            try? root.setResourceValues(values)
            if call.getBool("exclusive", false) {
                let fd = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
                guard fd >= 0 else { return call.resolve(["written": false]) } // the file is there already
                let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
                handle.write(data)
                try? handle.close()
            } else {
                try data.write(to: url, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            }
            call.resolve(["written": true])
        } catch {
            call.resolve(["written": false])
        }
    }

    @objc func removeFile(_ call: CAPPluginCall) {
        guard let url = Self.fileURL(call.getString("name")) else { return call.reject("publik: this file name is not allowed.") }
        try? FileManager.default.removeItem(at: url)
        call.resolve(["removed": !FileManager.default.fileExists(atPath: url.path)])
    }

    // MARK: browser

    @objc func openBrowser(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw), ["https", "http"].contains(url.scheme?.lowercased() ?? "") else {
            return call.reject("publik: not a web address.")
        }
        DispatchQueue.main.async { [weak self] in
            guard let self, let presenter = self.bridge?.viewController else { return call.reject("publik: the app is not ready.") }
            self.browser?.dismiss(animated: false)
            let safari = SFSafariViewController(url: url)
            safari.delegate = self
            safari.dismissButtonStyle = .done
            self.browser = safari
            presenter.present(safari, animated: true)
            call.resolve()
        }
    }

    @objc func closeBrowser(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            if let browser = self?.browser, browser.presentingViewController != nil { browser.dismiss(animated: true) }
            self?.browser = nil
            call.resolve()
        }
    }

    public func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        browser = nil
        notifyListeners("foreground", data: [:])
    }

    // MARK: first-run screen

    @objc func showFirstRun(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            // Seen before, or nothing to present on: the app goes on (it waits for this call).
            guard let self, self.bridge?.viewController != nil,
                  !UserDefaults.standard.bool(forKey: FirstRunView.completedDefaultsKey) else { return call.resolve() }
            let controller = UIHostingController(rootView: FirstRunView(onFinish: {}))
            // FirstRunView saves "seen" itself when the person taps Get Started.
            controller.rootView = FirstRunView(onFinish: { [weak controller] in
                guard let controller else { return call.resolve() }
                controller.dismiss(animated: true) { call.resolve() }
            })
            controller.modalPresentationStyle = .fullScreen
            self.present(controller, attempt: 0)
        }
    }

    /// Presents over the bridge, after the sign-in browser (if any) has gone; it is closing when the gate passes.
    private func present(_ controller: UIHostingController<FirstRunView>, attempt: Int) {
        guard let root = bridge?.viewController else { controller.rootView.onFinish(); return }
        if root.presentedViewController != nil && attempt < 20 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.present(controller, attempt: attempt + 1) }
            return
        }
        var top = root
        while let next = top.presentedViewController { top = next }
        top.present(controller, animated: false)
    }

    // MARK: self-test

    @objc func finishSelfTest(_ call: CAPPluginCall) {
        let line = call.getString("line") ?? "publik self-test: failed: no result"
        FileHandle.standardOutput.write(Data((line + "\n").utf8)) // unbuffered: `simctl launch --console-pty` or `--stdout=<file>`
        NSLog("%@", line)
        call.resolve()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(0) }
    }
}
