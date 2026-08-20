# kneecap — honest milestone status

**As of:** 2026-08-18 (post plan-execution campaign). Plan: `~/.claude/plans/opencut-mobile-port.md` (ratified 2026-08-17). Evidence rule: a milestone is only "done" if the claimed behavior was actually run and observed; everything else says so.

| Milestone | Status | Evidence / caveats |
|---|---|---|
| **M0** Fork, strip network, hygiene, invariants gate | **Done** | Freesound/remote-fonts/auth/Postgres path removed; `scripts/offline-audit.mjs` passes and was proven to catch an injected violation; `scripts/invariants.sh` is the merge gate and is **green** on this commit; CI workflow runs it; README/NOTICE/THIRD_PARTY_NOTICES/DECISIONS.md in place. |
| **M1** Feasibility spike | **Harness built; spike NOT run (device-blocked)** | Hidden diagnostics screen (`apps/mobile` `#/diagnostics` → spike.html) with the 6 tests + JSON export; `docs/SPIKE-GUIDE.md` has install steps and the kill-thresholds table. Tests 4 (whisper) and 5 (OPFS 200MB) verified locally; tests 1/6 rely on `requestAnimationFrame` and could not complete under background-tab automation (expected artifact, see SPIKE-GUIDE). **The actual go/no-go numbers require the founder's real devices.** |
| **M2** Headless editor-core + frozen EDL v1 | **Done** | `packages/editor-core` standalone-typechecks with 0 errors; headless gate scans 400 files for UI/server imports (0); EDL v1 (`docs/EDL.md`, integer ticks + rational fps) frozen, round-trip + golden-fixture tests green. |
| **M3** Capacitor shells + NativeBridge seam | **Done** | Both native projects build (iOS simulator `CODE_SIGNING_ALLOWED=NO`: BUILD SUCCEEDED; Android `assembleDebug`: BUILD SUCCESSFUL); bridge-import gate (no shell SDK imports outside `packages/native-bridge`) enforced in invariants, 0 hits. |
| **M4** Native media custody + proxy pipeline | **Built, compile-verified; runtime partially verified** | iOS: PHPicker → container copy → proxy transcode → thumbnails, exercised in simulator with a bundled CC0 clip. Android: same pipeline via Photo Picker + Media3 Transformer, **JVM unit tests only — instrumented tests never ran** (no emulator system images on the build machine; AVD exists but is broken). |
| **M5** Touch input layer | **Done** | Timeline controllers rewritten to pointer events; mouse-event gate is strict in invariants (0 raw mouse listeners); gestures exercised in the dev harness. |
| **M6** CapCut design tokens + component kit (B1) | **Done, with measurement debt** | Tokens measured from real App Store screenshots (`docs/capcut-reference/`); **~24 `[NEEDS-CAPTURE]` flags** across tokens.css/components mark values that could not be measured from available sources — the M6a founder capture session closes them (see FOUNDER-RUNBOOK). |
| **M7** Timeline component | **Built + wired; known gap** | Originally built against mock data (audit finding); fixer wired it to live EditorCore state via `use-timeline-project-vm.ts` and mounted it in `EditorShell`. `handleTrimCommit`'s own comment discloses trim-commit wiring still needs a follow-up pass. |
| **M8** Panels, toolbars, export sheet | **Done (post-audit fixes)** | Audit pressed every control against live engine state in a real browser. Fixed since: preview-canvas 0×0 collapse under an open sheet (two separate bugs), empty-Edit-sheet prompt, opacity/blendMode preview reflection, captions panel wiring. |
| **M9** Native export bridges | **Built; iOS partially verified, Android device-blocked** | Merge unified two incompatible wire contracts (see the MERGE NOTE atop `packages/native-bridge/src/capacitor-bridge.ts` before touching the bridge). iOS: EDL→AVFoundation mapper compiles, golden-frame harness ran in the simulator and produced a score. Android: EDL→Media3 with custom cross-fade GL compositor, JVM-tested only. Export UI now calls `NativeBridge.exportProject` (exportId-keyed) with progress + cancel; **no JS↔native export round trip has run on a real device.** |
| **M10** Local captions | **Engine done; iOS native plugin NOT wired** | Word-timestamp smoothing verified against a real whisper.cpp 1.9.2 capture; caption track + karaoke preview + EDL burn-in wired; Generate works end-to-end in the dev harness (web fallback + fixture; a silent `AddTrackCommand` bug mistyping caption tracks was found and fixed). Android whisper JNI compiles; **the iOS whisper plugin is scaffolded but not wired.** On-device transcription unverified on both platforms. |
| **M11** Performance/memory hardening | **Not started** | Never assigned in the execution campaign. Depends on real devices anyway (jetsam/OOM behavior); fold into the M1 spike follow-up. |
| **M12** QA + CI | **CI real; device QA not started** | Invariants run in CI on push; release workflow (signed APK + unsigned IPA on tag) exists but **its first real run needs repo secrets** (keystore — see RELEASING.md). Device-matrix QA blocked on hardware. |
| **M13** Direct distribution | **Drafted only** | publik listing copy + Android sideload guide + iOS build-from-source guide written under `docs/`; nothing published. Signing blocked on founder keystore/secrets. |

## The shipping gap that was closed last

Until the final pass, `apps/mobile` booted the old M3/M4 raw-JSON debug harness — the CapCut UI existed only in a web dev route. Now: `apps/mobile` boots a **project list → real `EditorShell`** (`src/app/app-root.tsx`), with the legacy harness kept behind `#/diagnostics`. Verified by: vite build, tsc, eslint, invariants green, and both native builds compiling the new bundle. **Not yet verified: a human actually tapping through the home→editor flow on a device/simulator screen.** That is deliberately listed in the runbook rather than claimed here.

## Corrections from real-device testing (2026-08-18, founder's iPhone)

- The audit's "every NativeBridge method has a real registered implementation on BOTH platforms" was **wrong for iOS**: the plugins compiled and linked but were never registered with the Capacitor bridge (no `capacitorDidLoad` registration), so every native call died with `plugin is not implemented on ios` on first real tap. Fixed via `KneecapBridgeViewController`. Lesson for future audits: *compiled ≠ registered* — plugin availability must be verified by invoking a method at runtime, not by reading `pluginMethods` lists.
- The webview CSP blocked WASM compilation (`wasm-unsafe-eval` missing) — the app hung on "Loading…" forever. Both found only because a human tapped the real app.

## Corrections from real-device testing round 2 (2026-08-19, founder's iPhone) — fixed in 6e76d486

- **Whole app page-scrolled / chrome outside the safe area.** The 2026-08-18 safe-area fix was right in intent, wrong in box model: no `box-sizing` reset loads on the real app path, so `.cc-editor-shell`'s `height: 100%` + inset paddings summed past the viewport (content-box). Same bug on `.kc-home`/`.kc-crash`. Now border-box + page scroll locked (`html/body/#app` overflow hidden, overscroll none); lists scroll internally. Lesson: env(safe-area-inset-*) fixes are invisible in any 0-inset environment — only a notched device shows the box-model mistake.
- **Playback totally dead for native imports.** M4's documented zero-byte stub `File` reached mediabunny's `BlobSource` via every decode path; each advancing frame re-parsed the empty blob and failed silently (playback clock over a black canvas — a fourth instance of the "silent death" class). Fixed by `media/playable-source.ts` (plan §2.6 swap): file-bytes-else-`UrlSource(mediaAsset.url)` in video-cache/backdrop/audio paths, plus a failed-sink negative cache + one-shot toast. **UrlSource-over-Capacitor-scheme playback has NOT yet run on a device** — verify on the next founder run.
- **Import looked dead.** Picker → sequential native transcodes with no UI until completion. `importMediaFromNative` now emits per-asset progress; EditorShell drives ProgressOverlay from tap to done.

## Corrections round 3 (2026-08-19, founder's iPhone console log) — fixed in 28e9f2f7 + e7d7a75c

The round-2 UrlSource swap surfaced the layer beneath it ("Retrying failed fetch" spam on merely opening a project):

- **iOS playback URLs were bare filesystem paths.** Swift returns raw `URL.path` values (by design — raw paths are the canonical native handles), but `Capacitor.convertFileSrc` only rewrites `file://`/`content://` strings and passes raw paths through untouched. `toPlaybackUri` now normalizes absolute paths to `file://` first. Android was never affected (`Uri.fromFile(...).toString()`). Verified in-repo that Capacitor 8.5 iOS's WebViewAssetHandler serves `_capacitor_file_` with full Range support (206 + Content-Range), so UrlSource streaming has a sound transport.
- **mediabunny's default retry policy never gives up** on same-origin fetch failures — the infinite loop kept sink-init pending, so the round-2 failed-sink cache/toast never engaged. UrlSource now caps at 3 attempts.
- **CSP listed the wrong iOS origin**: `server.hostname` applies to BOTH platforms, so iOS runs at `capacitor://appassets.androidplatform.net`, while the CSP only allowed Capacitor's default `capacitor://localhost`. Now listed in default-src and img-src.
- **Reopened projects rehydrated dead assets**: storage persisted the zero-byte stub and rebuilt `url` as an object URL of nothing; `MediaAssetData` now persists `url` for native-custody assets (and fps/hasAudio, which were declared but never round-tripped). Assets saved before this fix stay dead — recreate test projects. Known limit: the persisted URI embeds the iOS container UUID → app REINSTALLS orphan saved native assets (v1-acceptable).
- Unexplained log residue to watch next run: one boot-time "JS Eval error", repeated WebKit `AVIF initImage err=-39` decode failures (asset audit pending), and "Updated list with error: DownloadFailed" (believed iOS system noise, not app traffic — the offline gate stays green).

## Round 4 (2026-08-19): simulator-verified transport + the container-rotation fix

Round 3 still failed on device ("Load failed" on every sink init). Rather than another device round, the seam was reproduced **locally in the iOS Simulator** with a planted proxy file and a boot-time probe of the exact pipeline — and the entire transport WORKS as shipped: plain fetch returns full bytes, Range returns a correct 206, mediabunny UrlSource decodes a real first frame over the `capacitor://appassets.androidplatform.net/_capacitor_file_/...` URL (spaces in "Application Support" and all). The shipped playback code is correct for FRESH imports.

The remaining failure is environmental and now understood: **iOS rotates the app data-container UUID on every app update/reinstall** (observed live: a simctl upgrade-install rotated it too). Persisted ABSOLUTE media paths/URLs — including round 3's persisted `url` — die on the next install. Founder-device failures were rehydrated assets pointing into the previous container.

Fix (this round): container-RELATIVE persistence. New `NativeBridge.getMediaRoot()` (iOS `MediaSandbox.rootDirectory()`, Android `noBackupFilesDir`, web null), `media/native-paths.ts` resolver registry (host registers root+converter at boot, same pattern as `EdlAssetResolver`), `MediaAssetData.nativeRelativePath`/`thumbnailNativeRelativePath` persisted at import, re-anchored to the current root at every load (absolute `url` kept as same-install fallback). Assets imported before this build have no relative path and stay dead after a reinstall — recreate test projects once.

Still open, same log: the boot-time "JS Eval error", and `www/fonts/font-chunk-*.avif` failing iOS decode (err=-39, ×15 = the font atlas chunks — text glyph rendering likely degraded on iOS; needs its own investigation). NOT yet verified anywhere: an end-to-end on-device play (frames on screen) — the sim probe verified decode, not the full UI loop.

## Round 5 (2026-08-19): playback PROVEN end-to-end in the simulator — `#/autotest` harness (0dd90239, 973c5182)

The round-4 device log (with the new source instrumentation) showed the failing assets were the founder's PRE-fix clips rehydrating as `blob:`-of-zero-bytes — not the new pipeline. Instead of asking for another device round, apps/mobile gained a **`#/autotest`** route (also triggerable headlessly by planting `<mediaRoot>/autotest.flag`): it drives the real app with zero taps — real `importMediaFromNative` (only `pickMedia` substituted with a runner-planted mp4), real clip placement, real EditorShell, real play — and logs a `[autotest] VERDICT`. In-page PASS = clock advanced + videoCache decoded frames (WebKit clears WebGPU canvases after present, so in-page pixel readback is blank by design; the runner's `simctl io … screenshot` is pixel ground truth).

**All three phases verified on the iOS Simulator with screenshots showing the video actually rendering:** (1) import → plays; (2) relaunch/reopen from storage → plays; (3) **reinstall → container UUID rotated AND the data migrated (exactly like a real iOS update) → reopened project plays** — the founder-device failure scenario end to end. Storage also now: skips dead pre-persistence assets (url undefined + named console.warn, no more decoder error storm), and SALVAGES round-3 absolute-url assets by re-anchoring the stale URL's custody-relative suffix (files survive rotation; only the prefix died).

Also fixed after real research: the boot-time `AVIF err=-39` ×15 spam was the font-picker atlas chunks — AV1 High-profile yuv444 + separate monochrome alpha track (ffprobe-verified), which Chrome decodes and Apple ImageIO does not. All 15 chunks re-encoded as lossless WebP in both apps; `generate-font-sprites.ts` emits webp now.

Remaining round-5 leftovers: the boot "JS Eval error" (reproduces in sim, app unaffected — still undiagnosed); the simulator renders the editor chrome with degraded styling (huge serif fallbacks, mislaid timeline chrome — not seen in founder device captures; suspected iOS-26-sim WebKit/CSS quirk, worth one look); audio playback verified only decode-side (autotest asserts video frames, not audible output).

## Round 6 (2026-08-19): image imports died in the video transcoder — fixed + autotest now covers stills

The round-5 device log was the healthiest yet (dead legacy assets cleanly flagged, no error storms, the founder's fetch failures gone) but surfaced the next seam on first real use: **picking a JPEG fed the still to the VIDEO proxy transcoder** — AVFoundation refused with `-11828 Cannot Open … AVErrorFailedDependenciesKey=(Duration)`. Neither platform's `generateProxy` ever branched on `handle.kind`; the web fallback documented the intended contract all along ("the proxy IS the source"). NOTE for future triage: the scary LaunchServices/`usermanagerd`/sandbox-extension lines around picker use are normal out-of-process PHPicker noise, not app failures.

Fix, one layer per concern: (a) `importMediaFromNative` short-circuits `kind=="image"` — no transcode call, proxy = source, the still is its own thumbnail, relative-path persistence included; fixes iOS AND Android identically. (b) Both native `generateProxy`s now reject images loudly ("video-only") instead of streaming a cryptic AVFoundation/Media3 error if a future caller regresses. (c) Zero-length image clips fixed at placement (`duration || 3s` — a probed still has durationMicros 0, and `?? 3` never fired).

Verified in the simulator via `#/autotest` (now imports a planted mp4 AND jpeg together): both import, both land on the timeline (screenshot), video plays, VERDICT PASS on import and reopen phases (the image's `rel=Media/autotest-image.jpeg` persists + re-anchors). invariants green; both native builds compile.

## Round 7 (2026-08-19): the "stuck at import" class — pick progress + failure surfacing; fonts to PNG (1e582b4b)

Device log showed `pickMedia` fire then silence. Root cause: iOS `loadFileRepresentation` IS the iCloud original download (minutes, unobserved Progress), and per-item errors resumed nil — silently dropped, so an all-failed batch resolved `handles: []` exactly like a user cancel. Android inversely rejected the whole batch on one bad item. Fixed with a `pickProgress` event stream on both platforms (iOS KVO on the load Progress = real download fractions; Android per-item stage markers + per-item isolation), forwarded as import-stage "picking" ("Preparing media N of M…" in the overlay), with every dropped item toasted.

Fonts: lossless WebP ALSO failed device ImageIO (err=-50 ×15) — and round 5's "0 AVIF errors" sim check was vacuous because WebContent-process decode errors never reach the app console. Chunks are now PNG; the autotest VERDICT includes an in-app `Image.decode` probe (`fonts=ok`) so image-format support is measured, never assumed. Sim-verified: import phase exercises pickProgress, video+image import, playback PASS, fonts=ok; reopen PASS.

**Closed as not-a-bug:** the boot "JS Eval error" ×1-2 is Capacitor's own `CapacitorBridge.eval` firing a lifecycle event before the page loads (always pre-"WebView loaded") — benign framework noise on every Capacitor iOS app.

## Round 8 (2026-08-19): audio + timeline-follow — sim VERDICT now fully green (97486811, 53188d46)

Founder: "audio doesn't play and the timeline doesn't track." Both real, both engine-adjacent mobile-shell wiring (the OpenCut engine itself is intact — every campaign bug has lived in the new UI/native seams):

- **Every iOS proxy was silently MUTE**: nil-passthrough audio writer without a sourceFormatHint fails `writer.canAdd`, and the guard skipped audio wholesale (proven by #/autotest's new mediabunny probe: `getPrimaryAudioTrack()==null` on the proxy). Now PCM-decode → AAC 44.1k/2ch/128k encode (robust to any source codec), failed add THROWS. That exposed the classic AVAssetReader two-output stall (sequential drain + bulky PCM = 27%-in-4-minutes crawl) — track loops now drain concurrently. Plus AVAudioSession `.playback` so the ring/silent switch stops muting all WebAudio.
- **Timecode + strip froze during playback**: per-frame time rides `PlaybackManager.onUpdate`, but `useEditor` selectors ride `subscribe` (play/pause/seek only). `useCurrentTimeSeconds` now subscribes to all three channels (+ SSR getServerSnapshot for the web harness — caught after invariants printed 11/12), and TimelineView gained playback-follow (fixed-center playhead, strip scrolls beneath, no-op-set guard so syncs can't swallow the next user scrub).
- **Harness confession**: #/autotest never imported the app stylesheets (vite per-entry CSS splitting) — every "degraded UI" screenshot and the unscrollable `overflow:visible` timeline were HARNESS artifacts, not app bugs. Fixed; the route now renders and asserts the real UI. Verdict asserts audio stats (new `AudioManager.getStats`) and measured strip scroll: final sim run `PASS advanced sinks decodedFrames fonts=ok audio=ok timeline=ok(0->126px)`.

Residual: audible-through-speakers not verifiable headlessly (stats say running+scheduled); reopen-phase proxies transcoded by OLDER builds remain mute — re-import once on the new build.

## Round 9 (2026-08-19): the jetsam kill named itself + clip-selection UX (2dc1724b)

Founder's Xcode screenshot settled the crash-during-import mystery: **"killed by the operating system because it is using too much memory"** — jetsam, exactly the class the simulator can never reproduce (Mac RAM). Root cause: the proxy transcoder decoded every frame at SOURCE resolution to 32BGRA (~33MB/frame at 4K) plus per-frame CoreImage. Now `AVAssetReaderVideoCompositionOutput` — VideoToolbox delivers upright, proxy-scaled ~2MB frames appended directly, zero CoreImage. Measured (4K60 10-bit HLG import in sim): **51MB → 98MB peak footprint**, with `[kneecap-mem]` watermark logs bracketing every transcode for future triage.

Selection ("options don't change / delete not popping up"): the contextual row was one subtle "Edit" chip, Delete two taps deep. Now CapCut-style direct Split / Delete / Duplicate on the row + "Edit" for the sheet. #/autotest drives the real gesture path (dispatched pointerdown/up) end to end: select → Delete visible → press → element removed → undo restores. Note for the "did you retain OpenCut" question: yes — editor-core IS OpenCut's engine; the selection/actions all existed (M8, browser-verified for text); the gap was surfacing them per CapCut's one-tap pattern.

Full fresh-import verdict: `PASS … fonts=ok audio=ok timeline=ok(0→128px) select=ok(sel=1 delete 1→0)`. invariants 12/12 checked before push.

## Test sweep (2026-08-18, Fable fork agent) — see docs/TEST-REPORT.md

All three CRITICALs found by the sweep are fixed and re-verified live in the browser harness: (C1) GPU init now gates the preview renderer (plus boot-time `ensurePreviewGpu` + font atlas bundled into apps/mobile, so text renders with real fonts); (C2) the home project list re-renders via a selector subscription — the engine always had the data, the UI never re-subscribed (verified: engine 1 / DOM 0 before, 1/1 after; reopen-after-reload rehydrates); (C3) a CrashBoundary paints any React render crash on screen instead of silent black. HIGHs still open, in priority order: Android's EDL parser missing ~12 field families that TS emits and iOS parses (must parse-or-reject, never silently drop); split-at-boundary silently no-ops; audio waveforms never populated (mock-only).

## Known residual defects / debt

- Trim-commit wiring in the timeline (disclosed in `timeline-view.tsx`).
- `demo-project.ts` bootstrap leaves an element pre-selected (noted by fixer; dev-harness-only).
- Whisper model is fetched at build time, not committed; CI needs network for that step (documented known gap in the offline audit for the web ML runtime signatures).
- 3 pre-existing unit-test failures in `masks/snap.test.ts` (documented baseline; predates this campaign).
- Spike tests 1/6 can only run in a foregrounded tab/app (rAF-gated) — fine on real hardware.
