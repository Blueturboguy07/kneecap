# apps/mobile — kneecap M3 Capacitor shell

Plan M3: "The M2 bundle runs inside a real iOS app and a real Android app, on
device, loading entirely from bundled assets, with the `NativeBridge`
interface defined and stubbed."

## What this is (and isn't)

- **Capacitor 8 native shell**, iOS + Android, wired to `@kneecap/native-bridge`.
- `src/` is the **M3 shell harness** — a small vanilla TS+DOM page that
  proves the shell loads with zero network requests and that the
  `NativeBridge` seam round-trips. **It is not the CapCut UI** (that's
  M6-M8, and doesn't exist yet), and it is **not** the real M2-item-6 Vite
  SPA bundle of the editor engine either (that item was still open when M3
  landed — see the M3 handoff). The harness deliberately does not import
  `@kneecap/editor-core`, because doing so would be the first time this repo
  bundles the real `opencut-wasm` package through a real bundler (Vite) for
  the browser, which is unverified and belongs to M1, not M3.
- Native chrome: a real first-run/permissions-primer screen shown once,
  before the WebView loads (`ios/App/App/FirstRunView.swift`,
  `android/.../FirstRunActivity.java`). It requests **no runtime
  permission** — plan M4 item 1 chose `PHPickerViewController` on iOS and
  Photo Picker/SAF on Android specifically because neither needs one; see
  the doc comments on those two files.

## Toolchain notes worth knowing before touching this

- **iOS uses Swift Package Manager, not CocoaPods.** Capacitor 8's iOS
  template dropped the Podfile; plugin deps come from
  `ios/App/CapApp-SPM/Package.swift` (Capacitor-CLI-managed — don't hand-edit
  it). There is no `.xcworkspace` to open; build/open `ios/App/App.xcodeproj`
  directly.
- **Deployment floors are patched onto the Capacitor-generated defaults**,
  not the CLI's out-of-the-box numbers (plan §2.5): iOS
  `IPHONEOS_DEPLOYMENT_TARGET` bumped 15.0 → 17.0 in
  `ios/App/App.xcodeproj/project.pbxproj`; Android `minSdkVersion` bumped
  24 → 29 in `android/variables.gradle`. `bunx cap add ios|android` again
  (e.g. after deleting a platform to regenerate it) will reset both — reapply.
- **The bridge-import gate is real here.** `src/main.ts` never imports
  `@capacitor/*` directly — platform info comes from
  `(await getNativeBridge()).platform`. `scripts/invariants.sh`'s
  bridge-import gate and the `no-restricted-imports` ESLint rule both enforce
  this for every file under `src/`.

## Building

```sh
# from apps/mobile/
bun run build            # Vite -> www/ (the locally-bundled static app)
bunx cap sync ios        # copies www/ into ios/App/App/public
bunx cap sync android    # copies www/ into android/app/src/main/assets/public

# iOS — simulator, unsigned (matches CI; see ../../.github/workflows/mobile-ci.yml)
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build

# Android — debug APK
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

Both of the above were run and passed in the M3 session (`BUILD SUCCEEDED`;
`BUILD SUCCESSFUL`). The iOS build was additionally installed and launched on
a booted `iPhone 17` Simulator and screenshotted — the native first-run
screen renders correctly. The Android debug APK was verified by decompiling
`classes6.dex` and confirming `FirstRunActivity`, `MainActivity`, and
`NativeBridgePlugin#getDeviceInfo` are present; no emulator was available in
that session (the one local AVD's system image was missing on disk), so the
APK was not installed/launched on-device. Neither the iOS "Get Started" tap
nor the Android `NativeBridgePlugin.getDeviceInfo()` JS↔native round trip on
a live app has been exercised interactively yet — see the M3 handoff for the
full list of what is and isn't verified.

## NativeBridge: what's real vs. stubbed in M3

`@kneecap/native-bridge`'s `capabilities()` is genuinely wired end-to-end:
GPU/codec feature detection runs in the WebView's JS (shared with the web
fallback), blended with a real native call
(`NativeBridgePlugin.getDeviceInfo()`, implemented on both platforms) for
OS version / device model / RAM tier.

`pickMedia`, `generateProxy`, `exportProject`, and `transcribe` are stubbed
on the Capacitor implementation — each throws a typed `NativeBridgeError`
naming the milestone that implements it (M4, M4, M9, M10 respectively). This
matches plan M3's task list: "Define + **stub** `packages/native-bridge`."
