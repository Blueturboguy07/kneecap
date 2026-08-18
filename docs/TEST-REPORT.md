# kneecap full-app test report

**Date:** 2026-08-18. **Tester:** adversarial test agent (interactive web-harness testing at 390×780 + static contract analysis + native build smoke). **Bundle under test:** main @ `760b17c7` (earlier flow tests ran on the immediately preceding bundle; each finding notes which). **Method:** real clicks in a real browser with console/error hooks, DOM/IndexedDB inspection, snapshot diffs — the interaction-driven testing this project's prior audits lacked.

## 1. Executive verdict

**Partially usable, with two CRITICAL blockers that make the current HEAD effectively unusable as a product:** (a) entering any project black-screens the entire app on the new preview renderer, and (b) no saved project ever appears in the project list, so all work is lost to the user after every app restart even though the data is actually persisted. The editing engine underneath is genuinely wired — text/audio insertion, split/duplicate/delete, scrubbing, undo all mutate real engine state and passed interactive verification — but the shell around it fails at the two most basic product promises: "open the app and see the editor" and "come back and find your work."

## 2. Findings (ranked)

### CRITICAL

**C1. Entering any project black-screens the whole app (current HEAD).**
- Repro: fresh page → "+ New project" (or open existing). Screen goes fully black; `#app` has 0 children.
- Cause captured via injected `window.onerror` hook: `Uncaught GPU context not initialized. Call initializeGpu() first.` — thrown from the new `PreviewRenderer` (mounted in `editor-shell.tsx` @ 760b17c7) before the wasm GPU context is initialized. The throw during React render unmounts the entire root.
- 100% reproducible in the web harness. The same code path ships to iOS/Android webviews.
- Note: the parent session was actively iterating on this component during testing (churn expected) — but as of `760b17c7` this is the shipped behavior.

**C2. Saved projects never appear in the project list — user-facing total data loss.**
- Repro: create project(s), reload the page → home screen shows "No projects yet" forever.
- Evidence (airtight, twice, including on a wiped-clean origin): IndexedDB `video-editor-projects/projects` contains 1 row (first run) / 3 rows (second run) with full `{id, metadata:{name:"Project 1"...}, scenes, settings}`; `document.querySelectorAll('.kc-home__item').length === 0` immediately AND after 5+ seconds; zero console errors/warnings.
- Localization: the save path works (`createNewProject` → `storageService.saveProject` persists). The read path — `ProjectManager.loadAllProjects()` → `storageService.loadAllProjectsMetadata()` → `getSavedProjects()` → HomeScreen — never surfaces rows. `useEditor()` does subscribe to the project manager (react/use-editor.ts:35), so a completed load + `notify()` would re-render; either the promise chain hangs before `savedProjects` is set or `loadAllProjectsMetadata` resolves empty. Adapter versions match (both v1); the migration runner doesn't obviously hang. Needs a debugger session — mechanism unresolved, symptom conclusive.
- Consequence: the app is session-only for users, AND every "+ New project" tap (including ones that immediately crash via C1) permanently accumulates an orphaned project row that nothing can list or delete.

**C3. Runtime crashes are invisible — pure black screen, no message, nothing in console.**
- The C1 crash produced NO console output (the error only surfaced via an injected capturing `window.addEventListener('error', …, true)` hook). There is no React error boundary around `EditorShell`; `main.ts` deliberately only `console.error`s post-mount rejections, and synchronous render errors produce a silent unmount. A user sees black and has no recourse; a developer sees nothing in logs.
- This is the third confirmed instance of the project's recurring failure class (silent death: CSP/wasm hang, unregistered-plugin error screen, now GPU-init unmount).

### HIGH

**H1. Android's EDL parser is missing 12 field families that TypeScript emits and iOS parses.**
- Static diff of `packages/editor-core/src/edl/types.ts` fields vs `apps/mobile/ios/App/App/NativeExport/EdlModel.swift` (94 properties) vs `apps/mobile/android/.../edl/` data classes (73 properties). Missing on Android only: `background`, `blendMode`, `keyframes`, `keyframeId`, `interpolation`, `extrapolationBefore`, `extrapolationAfter`, `leftHandle`, `dtTicks`, `dv`, `maskId`, `componentKey`.
- Consequence: a project using keyframed animation, blend modes, canvas background, or masks exports differently on Android than iOS/preview — **silently** (no parse error, fields just drop). This is precisely the cross-renderer drift the plan's golden-frame gate exists to catch, but living one level below it (the parser, not the shader).

**H2. Split at a clip boundary silently no-ops.**
- Repro: select clip, playhead at clip edge (t=0), Edit → Split. Button is enabled, nothing happens, no feedback, no error. (Mid-clip split verified working: 1→2 clips.) CapCut disables the action or toasts; kneecap does nothing.

**H3. Audio clips render without waveforms.**
- Insert "Soft Chime" from the Audio panel → audio track row appears but `.cc-timeline__waveform` is absent. The waveform component exists (M7) but the live VM path (`use-timeline-project-vm.ts`) never populates `waveformPeaks` for real audio elements — mock-data-only feature, exactly the "built against mocks, dead in the wired app" class.

### MEDIUM

**M1. Clip selection requires a real pointer gesture; programmatic/`click()`/keyboard selection doesn't exist.** Tap (pointerdown+up pair) selects; plain `click` does not. Fine for touch, but there is no keyboard/assistive path to select a clip (a11y gap).

**M2. HomeScreen cannot distinguish "loading" from "no projects."** It renders the empty-state copy while `loadAllProjects` is pending (`ProjectManager.isLoading` exists but is unread by the UI). Compounds C2 and will mislead debugging again.

**M3. No project delete/rename UI.** Combined with C2's orphan-on-crash behavior, the DB only ever grows.

**M4. Two test suites disagree about engine health.** Root `bun test` (what invariants gates): 399 pass / 3 known fails. `packages/editor-core` standalone `bun test src`: 190 pass / **47 fail / 6 errors** (pre-existing per fixer notes, still true). A gate that only runs the green suite overstates health.

**M5. `generate-captions-e2e.test.ts` is fixture-fed web-fallback, not e2e.** The test body is honest about it; the filename oversells. Native `transcribe` remains stubbed on iOS (documented) — no test exercises a real STT round trip anywhere.

### LOW

- Boundary-condition: `capabilities` is TS-composited (calls `getDeviceInfo` + local probes) — correctly absent from native method lists; `transcribe` missing on iOS is the documented M10 gap. No other TS↔native method drift found (all 6 remaining methods present on both platforms).
- The shared gstack browse daemon is a cross-session collision hazard (a concurrent session hijacked the test tab mid-run); a note for future agent testing, not an app bug.

## 3. Verified WORKING (stop re-testing these)

On the pre-`760b17c7` bundle (editor was enterable), all via real interaction with console watched:
- Home → create project → editor mounts; **all 13 toolbar items present in the captured CapCut order**, including scrolled ones.
- **Text panel**: Add text inserts a real engine element (preview span updated, clip landed on timeline, undo enabled); Bold → computed `font-weight: 700`; color swatch → computed `color: rgb(0,202,224)`.
- **Contextual Edit panel**: Duplicate (1→2 clips), mid-clip Split (1→2), Delete (2→1 + sheet closes). Correctly shows only Split/Duplicate/Delete for a text element.
- **Audio panel**: 4 bundled sounds listed; insert → audio track row appears, "+ Add audio" strip correctly disappears.
- **Timeline scrub**: scrolling the strip updates the timecode overlay (playhead-fixed model works).
- **Sheet mechanics**: open/close, scrim-tap dismiss, hit-testing inside sheets (the old scrim-eats-taps bug stays fixed).
- **Offline claim**: zero non-localhost network requests across the entire interactive session.
- At `760b17c7`: `scripts/invariants.sh` fully green (12 gates); iOS simulator BUILD SUCCEEDED; Android `assembleDebug` BUILD SUCCESSFUL.
- Bridge registration surfaces: TS/iOS/Android method tables aligned (modulo documented gaps above).

**Blocked / not tested** (mostly by C1): Stickers, Overlay, Effects, Filters, Adjust, Captions-generate, Aspect-ratio, Background, Transcript/Template sheets, Export sheet (preview-EDL + web-fallback export) on the current bundle; project-reopen state rehydration and project-switch singleton-leak checks (blocked by C2); anything requiring real devices (native import/export/STT round trips).

## 4. Top 5 fixes by user-visible impact

1. **Initialize the GPU context before `PreviewRenderer` mounts** (or lazy-init inside it with a non-fatal fallback) — unbreaks entering the editor at all (C1).
2. **Fix the project-list read path** and render a loading state (C2 + M2) — unbreaks persistence, the difference between an app and a demo.
3. **Add a React error boundary + visible runtime-error surface** (C3) — converts every future silent black screen into a reported, debuggable message. Cheapest insurance in the codebase.
4. **Reconcile Android's EDL model with the TS schema** — parse-or-loudly-reject unknown fields (H1); silent cross-platform divergence will otherwise surface as "Android exports look wrong" months from now.
5. **Split-at-boundary feedback + audio waveforms** (H2, H3) — the two most visible "this feels broken" moments inside the editor itself.
