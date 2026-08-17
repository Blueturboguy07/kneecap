import SwiftUI

/// kneecap M3 — native first-run screen (plan M3 item 6: "Native chrome that
/// also satisfies store policy: native splash, native first-run/permissions
/// flow"). This is real native UI, shown BEFORE the WebView ever loads —
/// SceneDelegate.swift routes here on first launch instead of straight to
/// `CAPBridgeViewController`. It is what M3 means by "the app has visible
/// native surface."
///
/// Deliberately requests NO runtime permission here. Plan M4 item 1 chose
/// `PHPickerViewController` specifically because "it runs out-of-process" and
/// "requires no usage-description" — calling
/// `PHPhotoLibrary.requestAuthorization` from this screen would force a
/// broad-grant prompt the chosen import path was designed to avoid entirely.
/// This is a primer (explains what's ahead and that everything stays local),
/// not a permission gate. Info.plist still carries `NSCameraUsageDescription`
/// / `NSMicrophoneUsageDescription` / `NSPhotoLibraryAddUsageDescription` for
/// the M4/M8/M9 features that DO need them — declaring those keys is inert
/// until the corresponding API is actually called.
struct FirstRunView: View {
    let onFinish: () -> Void

    var body: some View {
        ZStack {
            Color(red: 0x0A / 255, green: 0x0A / 255, blue: 0x0A / 255)
                .ignoresSafeArea()

            VStack(spacing: 24) {
                Spacer()

                Text("kneecap")
                    .font(.system(size: 34, weight: .bold))
                    .foregroundColor(.white)

                VStack(alignment: .leading, spacing: 16) {
                    permissionRow(
                        title: "Photos & Videos",
                        detail: "To import clips from your library onto the timeline. Everything stays on this device."
                    )
                    permissionRow(
                        title: "Offline by design",
                        detail: "Editing, effects, and export all run locally — kneecap never uploads your media."
                    )
                }
                .padding(20)
                .background(Color(red: 0x1E / 255, green: 0x1E / 255, blue: 0x1E / 255))
                .cornerRadius(12)
                .padding(.horizontal, 24)

                Spacer()

                Button(action: handleGetStarted) {
                    Text("Get Started")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .background(Color(red: 0x4E / 255, green: 0x4A / 255, blue: 0xFF / 255))
                        .cornerRadius(12)
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 32)
            }
        }
    }

    private func permissionRow(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(.white)
            Text(detail)
                .font(.system(size: 13))
                .foregroundColor(Color(red: 0x8B / 255, green: 0x8A / 255, blue: 0x90 / 255))
        }
    }

    private func handleGetStarted() {
        UserDefaults.standard.set(true, forKey: FirstRunView.completedDefaultsKey)
        onFinish()
    }

    static let completedDefaultsKey = "kneecap.hasCompletedFirstRun"
}
