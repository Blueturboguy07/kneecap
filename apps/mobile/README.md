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
bun run build            # Vite -> www/ (the locally-bundled static app). No developer tools.
bun run build:debug-tools  # the same, plus #/diagnostics, #/autotest, spike.html and the spike clips
PUBLIK_GATE_MODE=optional bun run build   # the gate mode (see "Sign in with publik")
bash scripts/check-web-bundle.sh www required   # the store check CI runs on every bundle
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

## Sign in with publik

`src/main.ts` calls `runPublik()` in `src/publik/gate-ui.ts`, which runs
`startPublik()` in `src/publik/publik.ts`. The phone side is
`@kneecap/native-bridge/publik-host` plus `PublikGatePlugin` (iOS
`ios/App/App/PublikGatePlugin.swift`, Android
`android/.../PublikGatePlugin.kt`).

**Gate mode: ONE build setting, `PUBLIK_GATE_MODE`** (read by
`vite.config.ts` at `bun run build`; any other value fails the build):

| Value | What the person sees |
|---|---|
| `required` (default) | **Sign in with publik** is the first screen of a new install, before the native first-run screen. There is no way past it. Usage counting starts after the sign-in. |
| `optional` | The editor opens with no wall. **Sign in with publik** is a row in Settings. Usage counting starts only after a sign-in. A phone that never signed in sends nothing to publik. |

CI builds both (`ios-sim-app` / `android-debug-apk` = required,
`ios-sim-app-optional` / `android-debug-apk-optional` = optional).
`release.yml` reads the repo variable `PUBLIK_GATE_MODE` (default required).

Start order, both modes: the WebView loads, the gate runs (required mode
only), then `showFirstRun()` asks the native side to show the first-run
screen (`FirstRunView.swift` / `FirstRunActivity.java`, once per install),
then the editor opens. The editor waits at most 1.5 s for `showFirstRun()`
(`src/main.ts`), so a first-run screen that does not answer cannot block it.
When the gate passes while the sign-in page is still open, `closeBrowser()`
brings the app back in front (iOS: dismiss; Android: MainActivity with
`CLEAR_TOP | SINGLE_TOP`).

- **Sign in with publik** opens the sign-in page in the in-app browser
  (SFSafariViewController / a Custom Tab). The app checks the wallet every
  3 seconds for up to 10 minutes while it is in front, and again at once when
  it comes back to the front. In required mode there is no other way past
  the screen.
- **Settings** (the "Settings" button on the home screen,
  `src/app/settings-screen.tsx`):
  - **Sign in with publik** (optional mode, signed out).
  - **Sign out** ("Signing out…"): keeps the key in memory, deletes the key
    file first, stops usage counting, then asks publik to revoke the key
    (`POST /api/v1/installs/revoke`; best effort, at most 3 s). It finishes
    without a network. In required mode the gate shows again.
  - **Delete account**: the same order for the publik data on this phone
    (the key and the install ID; the usage opt-out stays), then opens
    `https://publikhq.com/settings/profile#delete-account-title` in the
    in-app browser, where the person confirms.
  - **Count app use**: the usage-counting switch (`consent.json`). It is
    off and locked when `DO_NOT_TRACK` or `PUBLIK_TELEMETRY=0` is set.
  - **Licenses** (`src/app/licenses-screen.tsx`): the third-party software
    in the app and its license texts, from
    `public/licenses/third-party-licenses.json`. After a dependency change,
    run `python3 apps/mobile/scripts/generate-licenses.py` (it reads the
    installed `node_modules`) and commit the JSON. soundtouchjs is LGPL-2.1:
    its entry has the full text and the source link.
- `USES_AI = false`: kneecap calls no model, so there is no plan screen and
  no own-key choice.
- Offline: the first sign-in needs the network. After that, a phone that
  signed in opens the app when publik does not answer
  (`OFFLINE_AFTER_SIGN_IN`). If publik later says the phone is signed out,
  the gate shows again.
- "Not reachable" also means an answer that is not publik's: a body that is
  not JSON (a captive portal or a proxy page), 408, 429, 5xx, a 2xx that is
  not a wallet, and a 401 without publik's JSON error. Only publik's own
  JSON 401 deletes the key; then the gate gets at most 2 new keys and shows
  publik's message with Retry. A failed file write shows the not-reachable
  screen with Retry; `claimed_at` writes are best effort.
- Usage counting: `app_opened` after a sign-in, then `active_session` every
  30 minutes while the app is in front, with the install key. The timer
  stops in the background and starts again in front (no new `app_opened`).
  `DO_NOT_TRACK=1`, `PUBLIK_TELEMETRY=0` or `consent.json` with
  `"usage": false` (the Settings switch) turns it off.
- The app token (`pat_`) comes from `PUBLIK_APP_TOKEN` at `bun run build`
  (`vite.config.ts`); CI passes the repo secret of that name. A store build
  (`bun run build`, not `build:debug-tools`) without a `pat_` token fails;
  `PUBLIK_ALLOW_NO_TOKEN=1` allows it (CI sets it only for a fork's pull
  request, which gets no secrets). `scripts/check-web-bundle.sh` also fails
  when no `pat_` token is in `www/assets` (it never prints the value), and
  `release.yml` fails first when the secret is empty.

Launch settings (iOS: environment or `-NAME value` launch arguments;
Android: intent extras). The app reads only these. They are test hooks:

- Android reads them only in a debuggable build (`FLAG_DEBUGGABLE`, the CI
  debug APK). A release build ignores them. `FirstRunActivity` passes on
  only these 5 names, and only in a debuggable build. `MainActivity` is not
  exported in `src/main` (only `src/debug` exports it, for the spike deep
  link).
- iOS reads `PUBLIK_API_BASE_URL` only in a Debug build or a build with the
  Swift condition `PUBLIK_TEST_HOOKS`. Only those builds get
  `NSAllowsLocalNetworking` (the "Debug-only items" build phase); a Release
  build with it fails.
- The web side (`testBaseUrl()` in `publik.ts`) accepts a
  `PUBLIK_API_BASE_URL` only on this computer or the local network
  (localhost, 127.x, ::1, 10.0.2.2, `*.local`), unless the bundle was built
  with `PUBLIK_TEST_HOOKS=1`. Never ship a `PUBLIK_TEST_HOOKS` build.

```sh
# Self-test of the built app: prints one line, then exits.
SIMCTL_CHILD_PUBLIK_SELF_TEST=1 xcrun simctl launch --console-pty booted dev.kneecap.app
adb shell am start -n dev.kneecap.app/.FirstRunActivity --es PUBLIK_SELF_TEST 1 && adb logcat -s publik
# -> publik self-test: ok kneecap 1.0.1

# Test hook: send every publik call to another server.
SIMCTL_CHILD_PUBLIK_API_BASE_URL=http://127.0.0.1:8787/api/v1 xcrun simctl launch booted dev.kneecap.app
adb shell am start -n dev.kneecap.app/.FirstRunActivity --es PUBLIK_API_BASE_URL http://10.0.2.2:8787/api/v1
```

Unit tests: `bun test apps/mobile/test` (from the repo root). They cover both
gate modes, the Settings actions, answers that are not publik's, a key file
that cannot be saved, and the usage timer in the background.

## Store build items

- **Privacy manifest**: `ios/App/App/PrivacyInfo.xcprivacy`. No tracking.
  Collected data: Device ID, Product Interaction, User ID, Email Address and
  Name (all from Sign in with publik and usage counting). Required-reason
  APIs: UserDefaults (CA92.1) and file timestamps (C617.1). The comment in
  the file says where each one is used. Keep the App Store Connect privacy
  answers the same as this file.
- **Developer tools are in debug builds only**: web (`KNEECAP_DEBUG_TOOLS`,
  `vite.config.ts`), iOS (`#if DEBUG`, plus the "Debug-only items" build
  phase, which adds the `kneecap-spike://` scheme and
  `NSAllowsLocalNetworking` in Debug and fails a Release build that has a
  developer tool or `NSAllowsLocalNetworking`), Android (`src/debug`: the
  spike clips, `SpikeDiagnosticsPlugin.java`, the deep link; the
  `checkReleaseWebBundle` Gradle task fails a release build when
  `spike.html` or the debug chunks are in `assets/public`).
- **Gate-mode marker**: `src/main.ts` puts `publik-gate-mode:<mode>` in the
  bundle. `scripts/check-web-bundle.sh www <required|optional>` fails when
  the marker is missing or is the other mode, so CI proves each build's
  mode. A missing or unknown mode argument is an error.
- **Fonts**: the font picker's list (`public/fonts/font-atlas.json` and its
  preview images) has no TikTok Sans: TikTok and CapCut are one company
  (guidelines 4.1 and 5.2). Only Inter and Albert Sans ship as font files.
- **Licenses**: Settings > Licenses (see above).
- **No camera or microphone permission**: the app never asks for them.
  Android's `NativeBridgePlugin.kt` has a camera-capture path that no screen
  calls; add `CAMERA` back to the manifest before a screen uses it.
- **iPhone only** (`TARGETED_DEVICE_FAMILY = 1`), `arm64` in
  `UIRequiredDeviceCapabilities`, `ITSAppUsesNonExemptEncryption = false`
  (the app has no encryption of its own; HTTPS is exempt).
- **App icon and splash**: one source file, `brand/icon.svg` (a solid
  `<rect id="background">` and the mark in `<g id="mark">`). To change the
  icon, edit or replace that file, then run
  `python3 scripts/generate-brand-assets.py` (needs `rsvg-convert` and
  Pillow) and commit the PNGs it writes. The iOS App Store icon has no alpha
  channel.
- CI checks all of these: `scripts/check-web-bundle.sh`,
  `scripts/check-ios-app.sh`, `scripts/check-android-apk.sh`.

## NativeBridge: what's real vs. stubbed (M3 + M4)

`@kneecap/native-bridge`'s `capabilities()` is genuinely wired end-to-end:
GPU/codec feature detection runs in the WebView's JS (shared with the web
fallback), blended with a real native call
(`NativeBridgePlugin.getDeviceInfo()`, implemented on both platforms) for
OS version / device model / RAM tier.

`pickMedia`, `generateProxy`, `generateThumbnails`, and `exportProject` are
no longer stubbed on EITHER platform as of M4/M9 (see the two
platform-specific sections below — they were built by separate tracks and
merged). `transcribe` is still stubbed on the Capacitor implementation — it
throws a typed `NativeBridgeError` naming the milestone that implements it
(M10). This matches plan M3's task list: "Define + **stub**
`packages/native-bridge`," with each stub retired as its milestone actually
lands.

> **Merge note (2026-08-17).** The iOS and Android tracks independently
> evolved the JS<->native wire contract and were unified when they merged;
> `packages/native-bridge/src/capacitor-bridge.ts`'s header comment is the
> authoritative record of what changed and why. In short: export is keyed by
> an `exportId` on both platforms now (Android's `cancelExport()` became
> `exportCancel({exportId})`), and `generateThumbnails()` exists on both
> (iOS gained the dedicated plugin method it had been missing, while
> keeping the `thumbnailUris` it already emitted from `generateProxy`).
> Anywhere the two platform sections below still read as "this session did
> not touch the other platform," that is the ORIGINAL track's honest
> statement at the time, not a claim about the merged tree.

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
  executable and runs them against a real fixture from the source tree
  (`App/App/Fixtures/kneecap-test-clip.mp4`, not copied into the app — a 960x540/4s/H.264+AAC clip
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

## M9 (iOS track): the EDL → AVFoundation export bridge

**What's REAL, and how it was verified.** `NativeBridge.exportProject()` is
no longer stubbed on iOS. `apps/mobile/ios/App/App/NativeExport/*.swift`
(Foundation/AVFoundation/CoreImage/CoreText only — Capacitor/UIKit-free,
same discipline as `NativeMedia/*.swift`) implements the full plan M9
pipeline:

- `EdlModel.swift` — a `Decodable` mirror of `edl/types.ts`, field-for-field.
- `MainTrackPlacement.swift` — **pure `Int64` tick math, no AVFoundation** —
  the transition-placement algorithm (a transition "eats into" both
  neighboring clips' existing footage rather than requiring extra source
  frames; see its header comment for the full reasoning, since — like the
  Android side per plan §5 risk #4 — no existing precedent covers this
  exact bridge shape) plus the nominal→output tick remap that keeps
  overlay/secondary-audio timing in sync once a transition has compressed
  the main track.
- `CompositionBuilder.swift` — EDL → `AVMutableComposition`: multi-track,
  trim/split via `CMTimeRange` inserts, speed via `scaleTimeRange`,
  cross-fading the AUDIO under a transition too (not just the video).
- `TransitionCompositor.swift` — a real custom `AVVideoCompositing`
  implementation (Apple's `AVCustomEdit`-pattern extension point), built
  FIRST per plan §5 risk #4. Cross-fade via Core Image's own
  `CIDissolveTransition` filter; a minimal effect pass (`"brightness"` via
  `CIColorControls`, the one effect type in the frozen EDL v1 golden
  fixture) proves the extension point without over-building v1's effect
  surface.
- `OverlayLayerBuilder.swift` — text/sticker overlays via `CATextLayer`,
  composited through `AVVideoCompositionCoreAnimationTool`, including a
  keyframed opacity animation channel.
- `VideoCompositionBuilder.swift` — assembles the sorted, contiguous
  `AVMutableVideoComposition` instruction list from placements + transition
  windows.
- `EdlExporter.swift` — `AVAssetReader` (reading already-composited frames
  via `AVAssetReaderVideoCompositionOutput`) → `AVAssetWriter`
  (VideoToolbox hardware encode), streamed to disk, with progress,
  cooperative cancellation (`EdlExportHandle`), and a post-export integrity
  re-probe (via the SAME `MediaProbe.probe()` M4's harness verified).

**`apps/mobile/ios/verify-export-pipeline/`** compiles those same files
into a standalone macOS executable (same pattern as
`verify-media-pipeline`) and runs a REAL export against the bundled
fixture, using a hand-authored EDL v1 fixture (the in-repo `buildEdl` can't
populate `transitions[]` yet — see `EdlTransition`'s doc comment in
`edl/types.ts`, "v1 PRODUCER STATUS: always `[]`" — so this harness
constructs one directly, exercising fields `buildEdl` doesn't produce yet).
All checks passed, including — not just "did it not crash":

- The transition placement math (pure, step 2) matches hand-derived
  expected ticks exactly.
- The real export produced a 960×540 MP4 with audio, whose duration
  (3.171s) matches the transition-compressed expectation (3.133s ± 0.35s
  slack for GOP/encoder rounding) — i.e. the transition genuinely
  shortened the export, not just claimed to.
- **Golden-frame numeric proof the cross-fade is a real blend, not a
  disguised hard cut**: frames extracted at a pure-clip-A instant, a
  pure-clip-B instant, and mid-transition were pixel-diffed. `diff(A,B) =
  76.6` (genuinely different content — the fixture is time-varying),
  `diff(A,mid) = 56.5`, `diff(mid,B) = 23.7`, and `diff(A,mid) +
  diff(mid,B)` lands within 5% of `diff(A,B)` — exactly the additive
  relationship a linear dissolve produces, and NOT what either a hard cut
  or an unrelated third frame would produce.
- **The text overlay genuinely renders in the exact plan-mandated cyan**
  (`#00CAE0`) — 16.9% of sampled pixels in an overlay-visible frame land
  within tolerance of that color.
- Cancellation (`handle.cancel()` before `export()` starts) throws
  `.cancelled` and leaves **no partial file** on disk.

One real bug this harness caught and fixed before any of the above passed:
the first version deadlocked (confirmed via `sample` — every CoreMedia
thread parked on `pthread_cond_wait`, zero CPU activity) because video and
audio `AVAssetReaderOutput`s on the same `AVAssetReader` were drained
SEQUENTIALLY, which `ProxyTranscoder.swift`'s plain track-output pattern
tolerates but `AVAssetReaderVideoCompositionOutput`'s internal composition
pipeline does not — fixed by draining both concurrently via a
`withThrowingTaskGroup`. See `EdlExporter.swift`'s doc comment on
`runPhase`.

**The full Capacitor iOS app** (with `NativeExport/*.swift` +
`NativeBridgePlugin+Export.swift` wired into
`App.xcodeproj/project.pbxproj`) built clean for the simulator
(`CODE_SIGNING_ALLOWED=NO`, `BUILD SUCCEEDED`). `nm` on the built
`App.debug.dylib` confirms real symbol hits for `EdlExporter.export`,
`OverlayLayerBuilder`, and the `@objc` `exportProject`/`exportCancel`
Objective-C thunks Capacitor's runtime-reflection plugin discovery needs —
genuinely compiled and linked, not just present on disk. Installed onto the
same "kneecap M4 QA" simulator and launched without crashing (screenshotted
— the M3 first-run screen renders; no crash in the system log).

**TS side**: `packages/native-bridge/src/capacitor-bridge.ts`'s
`exportProject()` calls through to the native plugin exactly like
`generateProxy` (subscribe-before-trigger event routing, this time keyed by
a freshly minted `exportId` rather than an existing domain id, since an
export has none). Cancellation is wired to the STANDARD
`AsyncGenerator.return()` protocol — a caller that walks away from the
`for await` loop before a terminal stage triggers a `finally` block that
calls the native `exportCancel`, so no second public method was added to
the `NativeBridge` interface. `capabilities().supportsNativeExport` now
reports `platform === "ios"` (was unconditionally `false`). Full repo
`scripts/invariants.sh` reran green after these changes (287 pass / 3
pre-existing fail, same baseline as before this session).

**What is NOT verified — real gaps, not hidden ones.**
- **No UI trigger exists yet.** Same gap as M4: M6-M8's mobile-ui host
  doesn't exist, so nothing in the shipped app actually calls
  `exportProject()` from a real "Export" button yet — it's wired and
  independently verified, but has no caller.
- **The golden-frame harness compares native-export frames against each
  other, not against a web-preview-rendered frame of the same EDL.** Plan
  M9 asks for both halves. The native half is real (see above). The
  web-preview half requires a browser-automation tool actually connected to
  a running instance — checked in this session
  (`mcp__kapture__list_tabs` returned zero connected tabs; this is a
  headless agent session with no GUI browser to drive) and confirmed
  unavailable. Closing this requires either running this track from a
  session with a real Chrome/Safari connection, or building a headless
  (non-browser) renderer for `services/renderer`'s scene-builder→WASM
  compositor pipeline — the latter is a nontrivial undertaking (the
  compositor is WebGPU/WebGL2, not something Node can run without a real
  browser context) outside this session's scope.
- **Only cross-fade is implemented as a transition kind.** Plan M9 item 2
  scopes "the v1 wipe/slide set" in addition; `TransitionCompositor.blend()`
  currently falls back to a dissolve for any `kind` it doesn't specifically
  recognize (documented in its own comment) rather than aborting the
  export, but no wipe/slide shader was written.
- **Filters beyond one hardcoded case (`"brightness"`) are not applied.**
  `EdlClip.effects` entries of any other `type` are silently no-op'd by the
  compositor (by design — see `EdlVideoCompositionInstruction`'s doc
  comment — but still a real scope gap against plan M9's "custom
  `AVVideoCompositing` implementation for filters").
- **Sticker rendering is text/emoji-glyph only.** There is no bundled
  sticker-art asset pipeline yet (that's M7/M8's job); a `"sticker"`/`
  "graphic"` clip renders via the same `CATextLayer` path as text, using
  `params.content` as a glyph string, or is skipped if that's absent.
- **No 12-clip/3-track stress fixture, no 4K export, no 60s-backgrounding
  test, no 10-minute audio-drift test.** Plan M9's exit criteria list all
  four; this session verified the mechanism (multi-track, transitions,
  speed, text, cancellation) on a small, fast fixture, not at the scale or
  duration the exit criteria specify.
- **Android had no equivalent at the time this was written.** The iOS
  track's scope was iOS only. Android's own M9 exporter (Media3
  Transformer — see the Android section below) landed on a separate track
  and both are present after the merge.
- **The Photos-library save (plan M9 item 8) is implemented
  (`NativeBridgePlugin+Export.swift`'s `saveToPhotosLibraryBestEffort`) but
  unverified** — no interactive on-device run granted the Photos permission
  and confirmed the asset actually lands in the library (same
  "PHPickerViewController-adjacent system UI has no automation harness
  here" limitation as M4). The system share sheet itself was not built at
  all (a UI-layer concern, M6-M8).

## M4/M9 (Android track): native media custody, proxy pipeline, and export

**M4 (written by the Android track, before the merge — see the iOS
sections above for that platform)** implemented
`pickMedia`, `generateProxy`, and `generateThumbnails` for real on the
Android side:

- `android/.../NativeBridgePlugin.kt` + `android/.../media/*.kt`
  (`MediaPickerIntents`, `MediaImporter`, `MediaProbe`,
  `ThumbnailStripGenerator`, `ProxyTranscoder`) — Photo Picker (with SAF
  fallback) + camera capture import, copy into
  `noBackupFilesDir` (Android's analog to "exclude from iCloud backup"),
  `MediaMetadataRetriever`/`MediaExtractor` probing, a Media3
  Transformer-driven short-GOP downscale proxy transcode with progress
  streamed via `notifyListeners("proxyProgress", ...)`, and a
  `MediaMetadataRetriever.getFrameAtTime` thumbnail strip.
- `packages/native-bridge/src/capacitor-bridge.ts` — real `pickMedia`/
  `generateProxy`/`generateThumbnails`, including the event-to-
  `AsyncGenerator` adapter that turns native `proxyProgress` events back
  into pulled `ProxyProgress` values, wire-format coercion (defensive
  `rotationDegrees` clamping + `durationMicros` rounding), and
  native-error-code-preserving mapping to `NativeBridgeError`. Unit-tested
  against an injected fake plugin (`__tests__/capacitor-bridge.test.ts`) —
  32/32 `bun test` green, including the full progress-stream/termination/
  listener-cleanup path.
- `src/main.ts` — an "Import media" card drives the real
  `pickMedia -> generateProxy -> generateThumbnails` sequence from a
  button tap (still harness UI, not the M6-M8 CapCut timeline's own
  import flow, but the same `NativeBridge` calls that flow will make).

**What is verified vs. not, honestly:** the Kotlin plugin genuinely
compiles (`./gradlew :app:assembleDebug` — `BUILD SUCCESSFUL`, and the
resulting `app-debug.apk`'s dex was decompiled to confirm every new class,
including `androidx.media3.transformer.Transformer` and
`androidx.media3.effect.Presentation`, is actually present in the built
APK, not just resolved-but-unused). `./gradlew :app:testDebugUnitTest`
passes 12/12 plain-JVM tests for the Android-framework-free helpers in
`media/MediaMath.kt`. `./gradlew :app:assembleDebugAndroidTest` packages a
full instrumentation-test APK covering `MediaProbe`/
`ThumbnailStripGenerator`/`MediaImporter`/`MediaPickerIntents` against a
bundled 32KB synthetic fixture clip (`androidTest/res/raw/test_clip.mp4`)
— but **none of those instrumentation tests have actually run**: no
emulator with a working system image was available in this session (both
local AVDs' system images are missing on disk). The real device-level
behaviors — does the Photo Picker actually launch and return a usable
URI, does the Media3 Transformer actually produce a playable proxy file on
real hardware, does a camera-permission prompt actually appear — are
UNVERIFIED. Run `cd android && ./gradlew connectedDebugAndroidTest` on a
real device or a working emulator to close that gap.

**M9 (Android only — see the M9 handoff for iOS status)** implemented
`exportProject` for real on the Android side — EDL v1 in, a hardware- (or,
on `ExportException`, software-) encoded MP4 out, driven through Media3:

- `android/.../edl/{Edl,EdlParser}.kt` — a Kotlin mirror of the frozen EDL v1
  contract (`packages/editor-core/src/edl/types.ts`) and a strict JSON
  parser (`getLong` on every `*Ticks` field — no floats cross the tick
  boundary, matching plan §2.2/§2.3 rule 1).
- `android/.../export/{TransitionAlphaMath,CrossfadeCompositorSettings}.kt`
  — THE cross-fade compositor (plan M9 risk #4, built first): a base
  hard-cut `EditedMediaItemSequence` plus one short alpha-ramped overlay
  sequence per crossfade transition, driven by a custom
  `VideoCompositorSettings` — Media3's own documented extension point for
  exactly this ("no built-in cross-clip transitions... must currently be
  hand-built using the overlay/compositor primitives," corpus `08` §8),
  not a hand-rolled GLSL blend pass. The alpha-ramp math itself
  (`TransitionAlphaMath`) is framework-free and runs as a plain JVM unit
  test.
- `android/.../export/EdlToComposition.kt` — the full EDL -> Media3
  `Composition` mapper: multi-track (main + overlay video/graphic + audio),
  trim/speed (`MediaItem.ClippingConfiguration` + `SpeedParameters`), text
  overlays (`TextOverlay`, time-gated), transform/opacity
  (`MatrixTransformation`/`AlphaScale`). Refuses (rather than silently
  drops) masks, keyframe animations, and generic filter effects — plan §2.3
  rule 3's "cut, don't ship inconsistent."
- `android/.../export/Media3Exporter.kt` — `Transformer.start(Composition,
  String)`, progress polling, a hardware->software encoder retry on
  `ExportException`, an output-integrity re-probe (reusing M4's
  `MediaProbe`) before declaring success, and `cancel()`.
- `NativeBridgePlugin.kt`'s `exportProject`/`cancelExport` +
  `capacitor-bridge.ts`'s real `exportProject` implementation (an
  `exportProgress` event-to-`AsyncGenerator` adapter, same shape as M4's
  `proxyProgress` one, plus native `cancelExport()` wired into the
  generator's cleanup so breaking a `for await` loop actually stops the
  encoder). `capabilities().supportsNativeExport` now reports `true` on
  Android.
- `src/main.ts` — an "Export project" card builds a hand-authored 2-clip
  crossfade + text-overlay EDL (M1's spike shape) from whatever the M4
  import card actually imported, and drives it through `exportProject`.

**What is verified vs. not, honestly:** `EdlToComposition`/`Media3Exporter`
compile against the real Media3 1.11.0 API (confirmed by inspecting the
actual cached `.jar`s with `javap`, not by guessing signatures) —
`./gradlew :app:compileDebugKotlin`, `:app:assembleDebug`, and
`:app:assembleDebugAndroidTest` are all `BUILD SUCCESSFUL`, and a dex
decompile confirms `EdlToComposition`/`Media3Exporter`/
`CrossfadeCompositorSettings`/`TransitionAlphaMath` are genuinely present
in the packaged APK. `TransitionAlphaMath` (12 tests) and `EdlParser` (8
tests) are plain-JVM-unit-tested — 34/34 `testDebugUnitTest` green. The
TS-side adapter (`exportProgressGenerator`, cancellation-on-early-return,
error mapping) is unit-tested against an injected fake plugin — 6 new
tests in `__tests__/capacitor-bridge.test.ts`.

`ExportGoldenFrameInstrumentedTest.kt` (`android/app/src/androidTest`)
builds a real 2-clip-crossfade-plus-text-overlay EDL, runs it through the
actual `Media3Exporter`/`Transformer`, and asserts on the resulting file —
but like M4's instrumentation tests, it has **not been run**: no
emulator with a working system image was available in this session. It
compiles and packages (`assembleDebugAndroidTest`) but needs
`./gradlew connectedDebugAndroidTest` on a real device or working emulator
to actually execute. Two things it explicitly does NOT verify even once it
runs: (1) whether the cross-fade actually looks right — the alpha-ramp
*math* is unit-tested, but Media3's real-time GL compositing of it has
never rendered a single frame in this session; (2) true golden-frame
*parity* against a webview-rendered reference PNG — that reference doesn't
exist yet (needs M6-M8's preview UI or `apps/web-dev`'s reference
renderer, a different track's deliverable), so this harness checks output
*integrity* (valid, right-ish duration, decodable frames), not pixel
*parity*, despite the file's name. The `EdlTransformEffect`/
`EdlTextOverlay` pixel-position mapping (EDL pixel space -> Media3
NDC/anchor space) is a best-effort, explicitly-documented-as-unverified
convention — see that class's own doc comment — pending exactly this kind
of real-device comparison.

`transcribe` remains stubbed on the Capacitor implementation — throws a
typed `NativeBridgeError` naming M10, the milestone that implements it.
(Written pre-merge: "iOS's `exportProject` status is whatever the `ios`
track's own M9 pass left it as" — that pass landed, and both platforms'
exporters are in the tree now. See the iOS sections above.)
