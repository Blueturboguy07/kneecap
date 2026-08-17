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
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
