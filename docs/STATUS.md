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

## Test sweep (2026-08-18, Fable fork agent) — see docs/TEST-REPORT.md

All three CRITICALs found by the sweep are fixed and re-verified live in the browser harness: (C1) GPU init now gates the preview renderer (plus boot-time `ensurePreviewGpu` + font atlas bundled into apps/mobile, so text renders with real fonts); (C2) the home project list re-renders via a selector subscription — the engine always had the data, the UI never re-subscribed (verified: engine 1 / DOM 0 before, 1/1 after; reopen-after-reload rehydrates); (C3) a CrashBoundary paints any React render crash on screen instead of silent black. HIGHs still open, in priority order: Android's EDL parser missing ~12 field families that TS emits and iOS parses (must parse-or-reject, never silently drop); split-at-boundary silently no-ops; audio waveforms never populated (mock-only).

## Known residual defects / debt

- Trim-commit wiring in the timeline (disclosed in `timeline-view.tsx`).
- `demo-project.ts` bootstrap leaves an element pre-selected (noted by fixer; dev-harness-only).
- Whisper model is fetched at build time, not committed; CI needs network for that step (documented known gap in the offline audit for the web ML runtime signatures).
- 3 pre-existing unit-test failures in `masks/snap.test.ts` (documented baseline; predates this campaign).
- Spike tests 1/6 can only run in a foregrounded tab/app (rAF-gated) — fine on real hardware.
