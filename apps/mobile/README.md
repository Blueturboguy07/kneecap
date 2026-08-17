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

## NativeBridge: what's real vs. stubbed (M3 + M4)

`@kneecap/native-bridge`'s `capabilities()` is genuinely wired end-to-end:
GPU/codec feature detection runs in the WebView's JS (shared with the web
fallback), blended with a real native call
(`NativeBridgePlugin.getDeviceInfo()`, implemented on both platforms) for
OS version / device model / RAM tier.

**M4 (Android only — see the M4 handoff for iOS status)** implemented
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
iOS's `exportProject`/`transcribe` status is whatever the `ios` track's own
M9/M10 passes left it as; this session did not touch `apps/mobile/ios`.
