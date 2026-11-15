import UIKit
import SwiftUI
import WebKit
import Capacitor

/// Capacitor does NOT auto-discover app-local plugin classes on iOS — a
/// plugin that lives in the app target (not an SPM/pod plugin package) must
/// be handed to the bridge in `capacitorDidLoad`. Nothing did this, so on a
/// real device every `NativeBridge.*` call failed with
/// `"NativeBridge" plugin is not implemented on ios` the moment the first
/// tap reached the bridge (found live on the founder's iPhone, 2026-08-18;
/// Android has always done the equivalent `registerPlugin(...)` in
/// MainActivity.onCreate). Defined here in SceneDelegate.swift so no
/// project.pbxproj file-list surgery is needed.
class KneecapBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        // Black from the first frame, like LaunchScreen.storyboard and every
        // app screen. A WKWebView draws white until the bundle paints its
        // first frame (blind test 1.0.4: seconds of white on a cold launch);
        // a non-opaque web view shows this black instead. Capacitor calls
        // capacitorDidLoad from loadView, after it made the web view.
        webView?.isOpaque = false
        webView?.backgroundColor = .black
        webView?.scrollView.backgroundColor = .black
        #if targetEnvironment(simulator)
        // The simulator's WebGPU starts, but the first real frame fails with
        // a wgpu "Out of Memory" panic that leaves the wasm compositor
        // unusable (1.0.4 simulator test). The preview draws with Canvas 2D
        // there from the start (editor-core compositor/gpu.ts reads this
        // flag). Device builds never have this code.
        webView?.configuration.userContentController.addUserScript(
            WKUserScript(
                source: "window.__KNEECAP_NO_GPU__ = 'ios-simulator';",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        #endif
        bridge?.registerPluginInstance(NativeBridgePlugin())
        #if DEBUG
        // The M1 spike's diagnostics plugin is a developer tool: Debug builds only.
        bridge?.registerPluginInstance(SpikeDiagnosticsPlugin())
        #endif
        // Sign in with publik — see PublikGatePlugin.swift.
        bridge?.registerPluginInstance(PublikGatePlugin())
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.backgroundColor = .black

        // The WebView loads first. "Sign in with publik" (with
        // PUBLIK_GATE_MODE=required) is the first screen of a new install;
        // after it, the web app asks PublikGatePlugin.showFirstRun for the
        // native first-run screen (kneecap M3 item 6, FirstRunView.swift).
        window?.rootViewController = KneecapBridgeViewController()

        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        #if DEBUG
        // kneecap M1 spike — throwaway deep link (`kneecap-spike://open`)
        // that navigates the already-loaded WKWebView to spike.html, the
        // hidden diagnostics screen (docs/SPIKE-GUIDE.md has the exact
        // trigger commands). Debug builds only: the scheme is added to the
        // built Info.plist by the "Debug-only items" build phase, and
        // spike.html is only in a KNEECAP_DEBUG_TOOLS=1 web build. Always
        // still forwards to SceneDelegateProxy so Capacitor's own URL-open
        // plugin handling (e.g. OAuth deep links) is untouched.
        if let url = URLContexts.first?.url, url.scheme == "kneecap-spike" {
            navigateToSpikeHarness()
        }
        #endif
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    #if DEBUG
    private func navigateToSpikeHarness() {
        guard let bridgeViewController = window?.rootViewController as? CAPBridgeViewController,
              let webView = bridgeViewController.bridge?.webView else {
            // First-run screen hasn't handed off to the bridge yet, or the
            // bridge isn't ready — see docs/SPIKE-GUIDE.md's "open the app
            // and wait for it to finish loading first" instruction.
            return
        }
        webView.evaluateJavaScript("window.location.href = 'spike.html';")
    }
    #endif

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
