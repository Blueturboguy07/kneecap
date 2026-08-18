# Founder runbook — the things only you can do

Ordered by how much downstream work each unblocks. Status context: `docs/STATUS.md`.

## 1. Run the M1 spike on real devices (~1 hour per device)

The whole architecture bet (web engine in a webview + native codec bridges) has **pre-committed kill thresholds** that only real hardware can test. Everything after this is polish if it passes and a pivot if it fails — run it first.

- Guide: `docs/SPIKE-GUIDE.md` — install steps, the 6 tests, the kill-thresholds table from the plan.
- iOS: open `apps/mobile/ios/App/App.xcodeproj` in Xcode, run on your iPhone (free Apple ID is fine), navigate to `#/diagnostics` → spike screen → "Run all 6 tests" → share the JSON export.
- Android: `cd apps/mobile/android && ./gradlew installDebug` with the phone plugged in, same flow.
- Keep the app **foregrounded** during the run — tests 1 and 6 are frame-clock-gated and will stall in the background (known, documented).
- Read the numbers against the thresholds table. Scrub latency > 400ms with proxies, or peak memory past the documented watermark, are kill-signals, not annoyances.

## 2. The M6a CapCut capture session (~2 hours, once)

The UI was built from store screenshots; **~24 values are flagged `[NEEDS-CAPTURE]`** and every one is closable in a single sitting with live CapCut on your phone.

- Process + flag inventory: `docs/capcut-reference/README.md`. Find every open flag with: `grep -rn "NEEDS-CAPTURE" packages/mobile-ui/src`.
- Headliners: exact primary-toolbar left-to-right order, type scale in pt, pressed/disabled states, sheet scrim opacity, panel motion timing, keyframe-diamond rendering, audio-waveform shape.
- Capture screen recordings + screenshots into `docs/capcut-reference/`, then each flag flips to `MEASURED` with a pointer.

## 3. Sideload the app itself and tap through it (~15 min)

The project-list → editor flow in `apps/mobile` compiles and passes every automated gate, but **no human has tapped through it on a screen yet**. While you have the devices out for the spike: create a project, import a clip, trim it, add text, open the export sheet, run an export. What breaks becomes the next work list — the export path in particular has never done a JS↔native round trip on hardware.

## 4. Android keystore + CI secrets (~20 min)

The tag-triggered release workflow (signed APK + unsigned IPA on GitHub Releases) is written but has never run for real.

- Steps: `docs/RELEASING.md` — generate the keystore, add the four repo secrets, push a test tag.
- Same pattern as publik's notarize-artifact flow: secrets live in CI, never locally.

## 5. Device matrix (§8.6, approved)

Buy/collect: current iPhone, an iPhone 13-class, a Pixel a-series, one budget/Go-class Android. The corpus has **zero** whisper.cpp phone benchmarks and mediabunny decode behavior differs between an iPhone 13 and 13 Pro Max on the same OS — the matrix is not optional for the spike to mean anything.

## 6. Local Android emulator repair (optional, ~10 min)

The build machine's AVD (`Pixel_3a_API_34`) is registered but its system images are missing, so Android **instrumented** tests (the ones that exercise the real Media3 export path) have never run. `sdkmanager "system-images;android-34;google_apis;arm64-v8a"` + recreate the AVD, or just run them on a plugged-in device: `./gradlew connectedDebugAndroidTest`.

## Standing decisions you've already made (no action, just memory)

- B1 full pixel fidelity; only name/icon/splash original — the icon and splash still need to be **designed** (currently placeholder).
- No store release; publik + GitHub Releases only. iOS distribution = build-from-source guide + unsigned IPA (drafts in `docs/guides/`).
- Quarterly check on upstream's OpenCut rewrite (`OpenCut-app/OpenCut`) for their mobile plans.
