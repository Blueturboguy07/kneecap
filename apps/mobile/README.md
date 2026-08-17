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

## M4 (iOS track): native media custody + import + proxy pipeline

**What's REAL, and how it was verified.** `pickMedia`/`generateProxy` are no
longer stubs on iOS — `ios/App/App/NativeBridgePlugin+Media.swift` wires them
to a `PHPickerViewController` import flow and a real
`AVAssetReader`→CoreImage→`AVAssetWriter`/VideoToolbox proxy transcode
(short-GOP, downscaled) plus `AVAssetImageGenerator` thumbnail-strip
generation, all in `ios/App/App/NativeMedia/*.swift` (deliberately
Capacitor/UIKit-free — Foundation/AVFoundation/CoreImage only).

- **`apps/mobile/ios/verify-media-pipeline/`** compiles those SAME
  `NativeMedia/*.swift` files into a standalone macOS command-line
  executable and runs them against a real bundled fixture
  (`App/App/Fixtures/kneecap-test-clip.mp4` — a 960x540/4s/H.264+AAC clip
  generated with `ffmpeg`'s `testsrc2` filter, not a shipped copyrighted
  asset). This is real, not a mock: probe (dims/duration/codec/fps),
  downscale-transcode (960x540 → 480x270), and thumbnail generation (6
  frames) all genuinely ran and asserted on real output. The short-GOP claim
  was independently checked with `ffprobe`, not just self-reported by the
  Swift code: the source has **1** I-frame in its whole 120-frame length
  (long-GOP, as configured); the proxy has **8**, at a 13-15 frame interval
  matching the requested `shortGopInterval: 15`.
- **The full Capacitor iOS app** (with the new plugin + `NativeMedia` files
  wired into `App.xcodeproj/project.pbxproj`, plus the bundled fixture as an
  app resource) built clean for the simulator
  (`CODE_SIGNING_ALLOWED=NO`, `BUILD SUCCEEDED`), installed onto a freshly
  created "kneecap M4 QA" iPhone 17 / iOS 26.3 simulator, and launched
  without crashing (screenshotted — the M3 first-run screen renders). `nm`
  on the built `App.debug.dylib` confirms 187 real symbol hits for
  `generateProxy`/`pickMedia`/etc. — the new code is genuinely compiled and
  linked in, not just present on disk.
- **`toPlaybackUri()`** (new `NativeBridge` method) converts a native
  sandbox path to a webview-loadable URL via `Capacitor.convertFileSrc` —
  Capacitor's own built-in local file server, confirmed (by reading
  Capacitor's iOS source directly) to support HTTP Range requests, which is
  what plan M3's "Range-capable local media server" item actually resolves
  to on iOS. No custom `WKURLSchemeHandler` was written; none was needed.
- **`@kneecap/editor-core`'s `importMediaFromNative()`** (new,
  `packages/editor-core/src/media/native-import.ts`) is the pick → per-asset
  proxy-generate → `AddMediaAssetCommand` orchestration plan M4 item 6 asks
  for. 9 tests exercise it against a REAL `EditorCore` singleton (not a
  mock) with a fake `NativeMediaSource` — success, per-item proxy failure,
  per-item thrown-exception failure (doesn't abort the rest of a
  multi-select batch), and the empty-pick case.

**What is NOT verified — real gaps, not hidden ones.**
- **No interactive on-device round trip.** PHPickerViewController is a
  system UI with no automation harness in this environment (no XCUITest
  target, no idb) — tapping "Import," picking the bundled fixture from Photos,
  and watching a proxy actually appear was never driven end-to-end on the
  simulator. What WAS verified (above) is the compiled code path in
  isolation and the app's ability to launch with it linked in.
- **Rotation handling is implemented but unverified against a real rotated
  clip.** `ProxyTranscoder`/`MediaProbe` apply `AVAssetTrack.preferredTransform`
  directly (the standard fix, per multiple independent references), but no
  rotated fixture could be produced in this session (`ffmpeg`'s `rotate`
  metadata write didn't take on the installed ffmpeg 8.1.2) — the fixture is
  landscape/unrotated only, so this code path never actually ran against
  rotated input.
- **`MediaAsset.file` is a zero-byte placeholder** for natively-imported
  assets (see the doc comment on `stubFile()` in `native-import.ts`) —
  deliberate, to satisfy M4's "peak JS heap delta under 20MB" requirement,
  but it means any PRE-EXISTING preview/waveform code that reads real bytes
  off `mediaAsset.file` via mediabunny's `BlobSource` (scene-builder.ts,
  audio-manager.ts, media/audio.ts) will not work correctly for a
  native-imported asset yet. `mediaAsset.url` (the proxy's playback URI) is
  what actually works. Fully closing this is the `NativeMediaStore` /
  `BlobSource`→`UrlSource` swap plan §2.6 describes — a render-pipeline
  change M4 didn't touch.
- **Android has no equivalent yet.** This session's scope was the iOS
  track; `pickMedia`/`generateProxy` on Android still hit the M3 stub path.
- **`ios/App/App/NativeMedia/*.swift`'s bitrate/quality heuristics and audio
  passthrough** are reasonable-but-unbenchmarked — no comparison against
  the plan M1 scrub-latency targets was run (M1's own harness is a separate,
  throwaway spike this session didn't touch).
