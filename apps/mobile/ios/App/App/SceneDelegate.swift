import UIKit
import SwiftUI
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)

        // kneecap M3 item 6: native first-run + permissions primer, shown
        // once, before the WebView ever loads. See FirstRunView.swift.
        let hasCompletedFirstRun = UserDefaults.standard.bool(forKey: FirstRunView.completedDefaultsKey)
        if hasCompletedFirstRun {
            window?.rootViewController = CAPBridgeViewController()
        } else {
            window?.rootViewController = UIHostingController(
                rootView: FirstRunView(onFinish: { [weak self] in
                    self?.window?.rootViewController = CAPBridgeViewController()
                })
            )
        }

        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        // kneecap M1 spike — throwaway deep link (`kneecap-spike://open`)
        // that navigates the already-loaded WKWebView to spike.html, the
        // hidden diagnostics screen (docs/SPIKE-GUIDE.md has the exact
        // trigger commands). Purely additive: only intercepts our own
        // scheme and always still forwards to SceneDelegateProxy so
        // Capacitor's own URL-open plugin handling (e.g. OAuth deep links)
        // is untouched.
        if let url = URLContexts.first?.url, url.scheme == "kneecap-spike" {
            navigateToSpikeHarness()
        }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

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

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
