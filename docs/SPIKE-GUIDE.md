# M1 Spike Guide — reading the go/no-go numbers

**Audience: the founder, on real hardware.** Plan M1 exists to be cheap to fail, and it can only do that with real device numbers — an agent session cannot produce them (no iPhone, no Android device, and the iOS Simulator numbers below are explicitly *not* a substitute; see "What is and isn't verified" at the bottom). This doc is the exact install → run → read-the-numbers path, plus the kill-threshold table the whole milestone hinges on.

The harness itself is **throwaway** (plan M1: "Build a throwaway harness — not the product"). It ships inside the same `apps/mobile` build as the M3 product placeholder, as a second, unlinked page (`spike.html`) — nothing here is the CapCut UI, and none of this code is meant to survive past M1.

---

## 1. Install

### iOS (Simulator, unsigned — matches this project's engineering rule)

```bash
cd apps/mobile
bun run ios:build:sim
# builds ios/App/App.xcodeproj, Debug, iphonesimulator, CODE_SIGNING_ALLOWED=NO
```

The built app is under Xcode's DerivedData, e.g.:
`~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Debug-iphonesimulator/App.app`

Install + launch on a simulator of your choice:
```bash
xcrun simctl boot "<device name or UDID>"          # if not already booted
xcrun simctl install booted path/to/App.app
xcrun simctl launch booted dev.kneecap.app
```

For a **real iPhone**, open `ios/App/App.xcodeproj` in Xcode, select your device, and Run — this project's engineering rule is Simulator-only for *agent* sessions; the founder should run M1's actual numbers on real hardware, per plan M1's whole premise (a mid-tier real device, not a Mac's GPU via Simulator translation).

### Android (debug APK)

```bash
cd apps/mobile
bun run android:build:debug
# APK at android/app/build/outputs/apk/debug/app-debug.apk
```

Install:
```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 2. Reach the hidden diagnostics screen

The spike screen is **not linked from the app's visible UI** (plan task: "hidden diagnostics screen"). Reach it with the `kneecap-spike://open` deep link, registered on both platforms:

1. Launch the app once and complete the one-time first-run screen (photos/camera/mic explainer — tap through it; nothing is actually requested yet at this stage).
2. Trigger the deep link:
   - **From the device**: type `kneecap-spike://open` into Notes or Safari's address bar and tap the resulting link, or make a QR code for it.
   - **From a terminal, iOS Simulator**: `xcrun simctl openurl booted "kneecap-spike://open"`
   - **From a terminal, Android**: `adb shell am start -a android.intent.action.VIEW -d "kneecap-spike://open"`
3. iOS will show a one-time **"Open in kneecap?"** system confirmation — tap **Open**. This is standard iOS behavior for any custom URL scheme opened from outside the app itself (Safari, Notes, `simctl openurl`); it is not specific to this harness and does not recur once dismissed for that launch.
4. The webview navigates in place to the diagnostics screen — no new app, no address bar.

If nothing happens: confirm you completed first-run in step 1 (the deep-link handler only fires once the Capacitor bridge/webview exists — see `SceneDelegate.swift`'s `navigateToSpikeHarness()` / `MainActivity.java`'s `onNewIntent()`).

---

## 3. Run the tests

Six cards, each with its own **Run** button, plus **Run all 6 tests** and **Export / share results JSON** at the top.

- Tap **Run all 6 tests**. Test 1 (compositor) takes a few seconds (500 rendered frames); the rest are fast except test 4 (whisper — see below, currently a no-op).
- Watch each card's status badge (idle → running → done/error) and its live JSON output.
- When finished, tap **Export / share results JSON** — this opens the system share sheet with a timestamped `.json` file (AirDrop it to yourself, save to Files, etc.), or falls back to copying JSON to the clipboard, or a raw on-screen `<pre>` block if neither is available.
- Send that JSON back with the M1 write-up. It is the `SpikeRunExport` shape defined in `apps/mobile/src/spike/types.ts` — `environment` (device/OS/GPU/codec info) + `results` (one entry per test, keyed by test id).

---

## 4. The kill-threshold table (plan M1's exit criteria, verbatim)

| # | Metric | Pass | Investigate | Kill-signal |
|---|---|---|---|---|
| 1 | 1080p 3-layer composite, p95 frame time, mid-tier device | ≤ 33ms | 33–50ms | > 50ms with WebGL2 on both platforms |
| 2 | Scrub latency with native proxy | ≤ 150ms | 150–400ms | > 400ms with proxies in place |
| 3 | 60s 1080p30 native export wall clock | ≤ 45s | 45–120s | fails or > 120s on mid-tier |
| 4 | whisper.cpp `tiny`, 60s audio | ≤ 30s | 30–90s | > 90s on mid-tier Android |
| 5 | 200MB OPFS write in WKWebView | succeeds | — | fails (→ media stays 100% native, no OPFS derived artifacts either) |
| 6 | Peak webview process RSS during test 1 | ≤ 250MB | 250–400MB | repeated `webViewWebContentProcessDidTerminate` |

**If two or more kill-signals fire: stop.** Fall back to plan §7's Plan B (native UI over the shared Rust core) — see the plan document for the full reasoning. This harness reports numbers and a convenience pass/investigate/kill label per test; it does **not** auto-decide the milestone. That call is the founder's, on real-hardware numbers, per plan §7.

Each card also prints its own threshold band inline, sourced from `apps/mobile/src/spike/thresholds.ts` — the single place these numbers live in code, copied verbatim from the plan.

---

## 5. What each test actually measures

1. **Compositor backend + frame time.** Loads the real `opencut-wasm` compositor (the actual product WASM binary, not a mock), renders 500 frames of a synthetic 3-layer 1080p composite with per-frame animated transforms/opacity, and reports p50/p95/max frame time. Also determines which GPU backend (`webgpu` / `webgl2` / `unknown`) actually got selected by probing the compositor's own `<canvas>` element's locked context type after init — `opencut-wasm` exposes no JS getter for this, so this is the instrumentation plan M1 asked for.
2. **Scrub latency.** Real `mediabunny` `CanvasSink.getCanvas(timestamp)` decode-and-seek, at 5 scattered timestamps, against two bundled fixture clips: `proxy.mp4` (540p, near-all-intra, `-g 1`) and `full.mp4` (1080p, long-GOP, `-g 250`) — see `apps/mobile/scripts/generate-spike-assets.sh`. This isolates the exact effect plan Amendment 4 predicts: long-GOP random-access decode cost.
3. **Native hardware export.** A hand-written 2-clip + text-overlay export via a dedicated, throwaway `SpikeDiagnostics` native plugin (kept separate from the real M9 exporter). iOS: AVFoundation, with a **real cross-fade** via `AVMutableVideoComposition` opacity ramps. Android: Media3 Transformer — **sequential concatenation, not a crossfade** (see §6 below for why, and why that itself is a real answer, not a shortfall).
4. **whisper.cpp `tiny` word timings.** Calls the real (currently stubbed) `NativeBridge.transcribe()`. Reports "ENGINE NOT BUNDLED" honestly — see §6.
5. **OPFS 200MB write/read.** Both `createSyncAccessHandle` (via a dedicated Worker, per spec) and `createWritable()`, each writing 200MB in 4MB chunks, reading back a verification sample, and reporting write/read wall-clock plus byte count. Positively closes the `14-gap-1.md` "10MB OPFS" myth with an on-device measurement, not just a source read.
6. **Peak webview RSS watermark.** Samples the app's real resident memory (via `mach_task_basic_info` on iOS, `ActivityManager.getProcessMemoryInfo` on Android — the same native plugin as test 3) every 25 frames during test 1's render loop, reporting the max.

---

## 6. Known gaps — read before treating a result as a kill-signal

- **Test 4 (whisper) always reports "not available."** Bundling and building whisper.cpp (a C++ library, via XCFramework/SPM on iOS and CMake/NDK on Android) plus a real GGML `tiny` model file is substantial standalone integration work that belongs to plan M10 ("Local on-device captions"). It was **not attempted** in this M1 pass — the harness correctly detects and reports the gap rather than fabricating a number. Test 4 will start producing real numbers with zero code changes here once M10 lands a real `NativeBridge.transcribe()`.
- **Test 3 on Android never applies a crossfade.** Verified directly against `androidx/media`'s `RELEASENOTES.md` on 2026-08-17 (latest release checked: 1.11.0): **no cross-clip video transition/crossfade support has landed in Media3 Transformer**, confirming plan risk-register item #4 ("Media3 has no cross-clip transitions... as of Media3 1.10") still holds at 1.11.0. The Android export is a real, working sequential 2-clip concatenation + text overlay — `crossfadeApplied: false` with an explanatory `note` is itself the M1 answer to "can a hand-built cross-fade compositor be stood up in three weeks," not a bug in this harness. A hand-built GLES cross-fade shader (plan M9's fallback for exactly this case) was not attempted here.
- **Test 3's native export code is compile-verified, not run-verified, as of this pass.** iOS: `xcodebuild` succeeded for the Simulator (unsigned). Android: `./gradlew assembleDebug` succeeded. Neither was executed end-to-end on a booted simulator/emulator with the real first-run → deep-link → tap-Run flow in the session that wrote this guide — that requires tapping through on-device UI, which the writing session had no tooling for (see below). Tests 1, 2, and 5's actual *logic* (identical TypeScript/WASM/mediabunny code on both platforms) WAS run end-to-end, just via desktop-adjacent Safari against a real WebKit engine rather than the full native shell — see the next section.
- **A real bug this spike found, already fixed here:** `packages/editor-core`'s product renderer (`services/renderer/compositor/wasm-compositor.ts`, from M2) never calls `opencut-wasm`'s required `await initializeGpu()` before `initCompositor()` — calling `initCompositor()` first throws `"GPU context not initialized. Call initializeGpu() first."` every time. This spike's own test 1 calls `initializeGpu()` itself before touching the compositor. **The M2-owned file was left unfixed** (out of this milestone's scope, and another track may be actively working in it) — flagging here so the product renderer's first real run doesn't rediscover the same failure from zero.

---

## 7. What is and isn't verified (read this before trusting any number above)

This section exists because a prior project shipped green tests hiding dead features — this guide draws the line precisely.

**Verified for real, in this pass**, by loading `spike.html?autorun=1` in **iOS 18.6 Simulator Safari** (a real WebKit engine — the same rendering engine WKWebView embeds, though not the identical embedding APIs, and Simulator GPU/CPU behavior is Mac hardware via translation, not representative of a real iPhone's thermals or GPU):
- Test 1 ran end-to-end against the real `opencut-wasm` binary: `gpuBackend: "webgl2"`, 500/500 frames, p50 ≈ 4–5ms, p95 ≈ 7–8ms (comfortably inside the ≤33ms pass band — **on Simulator hardware, not a real device; do not read this as an M1 pass**).
- Test 2 ran end-to-end against real bundled fixtures via real `mediabunny`: proxy p50 ≈ 5ms/max ≈ 10ms vs. full p50 ≈ 126ms/max ≈ 419ms across repeated runs — a real, reproducible, large gap in exactly the direction plan Amendment 4 predicts.
- Test 5's `createSyncAccessHandle` path ran for real: wrote+read+verified 209,715,200 bytes (200MB exactly) in ≈280–310ms.
- Test 5's `createWritable()` path ran for real and **failed** on this WebKit build: `"fileHandle.createWritable is not a function"` — genuine evidence that Safari/WebKit's OPFS support is partial (sync-access-handle yes, writable-stream no), independent of the `createSyncAccessHandle` result.
- Test 3 and test 6 correctly detected the non-native (plain-browser) context and returned a clean, typed "native-only" error rather than crashing or fabricating a result — confirming the harness's own error-handling paths work, not confirming the native export/memory-probe code itself (which needs the real app).
- Test 4 correctly surfaced the real `NativeBridge` stub's `NOT_IMPLEMENTED` error end-to-end.

**Compiled but not executed in this pass:**
- `SpikeDiagnosticsPlugin.swift` (iOS) — `xcodebuild … build` succeeded (Debug, iphonesimulator, unsigned).
- `SpikeDiagnosticsPlugin.java` (Android) — `./gradlew assembleDebug` succeeded.
- Neither plugin's `getMemoryFootprint()` or `exportSpikeSequence()` method actually ran on a device in this pass — that needs the full app + completed first-run + the deep link, which requires tapping through on-device system UI (the one-time first-run screen, and iOS's "Open in kneecap?" confirmation). The session that wrote this guide had `xcrun simctl`/`adb` for install-and-launch but no UI-automation tool (no XCUITest harness, no `idb`, no Accessibility-scripting permission for `osascript`/System Events against simulated device content) to tap through those screens — confirmed by direct attempts (button-by-name and keyboard-Return dismissal attempts on the iOS confirmation dialog both had no effect on the simulated screen content).
- **This is exactly the boundary plan M1 itself draws**: "The founder runs this on real hardware; agents cannot." Tests 3 and 6's real numbers — and every number's real-device credibility — are the founder's to produce.

**Not attempted at all:** the plan M1 item 6 Capacitor-vs-Tauri shell comparison. Plan §2.4 already resolved the shell decision ("Decision: Capacitor 8 primary") before this milestone ran, and M3 committed a Capacitor-only implementation (no Tauri scaffold exists anywhere in this repo). Standing up a second, parallel Tauri mobile shell — a full second native toolchain — is outside this task's scope (building the M1 diagnostics harness) and was not started.

---

## 8. Files

- `apps/mobile/spike.html`, `apps/mobile/src/spike/**` — the harness UI and all 6 test implementations (TypeScript, shared by both platforms).
- `apps/mobile/scripts/generate-spike-assets.sh` — regenerates the bundled test-fixture videos (ffmpeg; not run at build time).
- `apps/mobile/public/spike-assets/{proxy,full}.mp4` — test 2's fixtures, served as plain static web assets.
- `apps/mobile/android/app/src/main/assets/spike/{clip-a,clip-b}.mp4` — test 3's Android fixtures.
- `packages/native-bridge/src/spike-diagnostics.ts` — the TS-side wrapper for the throwaway `SpikeDiagnostics` native plugin (deliberately separate from the production `NativeBridge` — see that file's header).
- `apps/mobile/ios/App/App/SpikeDiagnosticsPlugin.swift`, `apps/mobile/android/.../SpikeDiagnosticsPlugin.java` — the native halves.
- `apps/mobile/src/spike/thresholds.ts` — the kill-threshold table as data (§4 above is generated from the plan the same way this file is).

All of the above is throwaway (plan M1). Once M1 is read and a go/no-go call is made, delete this directory tree, the two native plugin files, their manifest/pbxproj/gradle entries, and this guide.
