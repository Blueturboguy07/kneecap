# CapCut mobile reference captures — M6a checklist

**Status as of 2026-08-17: NOT YET DONE.** This directory is empty of
actual captures. Plan M6a calls for "screenshots + screen recordings" from
"a live CapCut install on one iPhone and one Android device," saved here —
that requires physical hardware and a human founder session; it cannot be
produced by an automated coding session (no device access, and fabricating
screenshots would defeat the entire point of a pixel-fidelity track). This
file exists so that session has a ready checklist instead of having to
reconstruct one from the plan and the two research reports by hand.

`packages/mobile-ui/src/tokens.css` and every component in
`packages/mobile-ui/src/components/` already shipped against the best
available evidence (10 real CapCut iOS App Store screenshots, pixel-sampled
— see `/Users/mannbellani/opencut-research/06-capcut-ui-visual.md` and
`04-capcut-ui-inventory.md`). Every value that evidence couldn't settle is
tagged `[NEEDS-CAPTURE]` in `tokens.css` with a comment explaining exactly
what's missing and why. This checklist is that same list, reorganized for a
capture session instead of a token file.

## How to close an item

1. Capture the screenshot/recording on-device, save it here as
   `docs/capcut-reference/<platform>-<item>.{png,mp4}` with today's date in
   the filename.
2. Re-measure the specific token(s) listed below (same method as the
   corpus: crop, pixel-sample, edge-scan — see `06-capcut-ui-visual.md` §1
   for the methodology if repeating it programmatically).
3. Update the value + provenance comment in `tokens.css` (change
   `[NEEDS-CAPTURE]` to `MEASURED <confidence>` with a pointer to the new
   file).
4. Re-run `bun test packages/mobile-ui/src/__tests__/contrast-audit.test.ts`
   — a new measured color can change a contrast ratio; the audit must stay
   green.

## Checklist (plan M6a bullets, cross-referenced to the exact token/component each one unblocks)

- [ ] **Primary bottom toolbar order.** Three sources gave three different
      orders (corpus `04` §3, §7 item 1). Unblocks: the default `items`
      array passed to `<BottomToolbar>` — currently the canonical superset
      order assembled by cross-referencing, explicitly not claimed-verified
      (see `apps/web/src/app/dev/mobile-ui/page.tsx`'s
      `PRIMARY_TOOLBAR_ITEMS`).
- [ ] **Is "Edit" a standing icon or purely contextual?** (corpus `04` §7
      item 2). Same unblock as above.
- [ ] **Clip-selected contextual toolbar mechanic** — replace vs. overlay
      vs. horizontal-scroll-extend of the primary bar (corpus `04` §4).
      Unblocks: whether `<SubToolbar>` should ever render simultaneously
      with `<BottomToolbar>`, currently built as a visually-identical
      sibling pending this answer.
- [ ] **Export sheet field set and layout** (corpus `04` §5, §7 item 3).
      Not yet built at all — M8 scope, but the capture should happen now
      while the device is out.
- [ ] **Timeline track-row height, bottom-toolbar height, filmstrip
      thumbnail density at 3 zoom levels** (corpus `06` §5, §9). Unblocks:
      `--cc-track-height`, `--cc-toolbar-height`, `--cc-subtoolbar-height`,
      `--cc-ruler-height` in `tokens.css`.
- [ ] **Playhead's exact horizontal position.** M7 scope, capture now.
- [ ] **Audio waveform rendering** — amplitude shape vs. flat line, sources
      conflict (corpus `06` §5). M7 scope.
- [ ] **Motion**: bottom-sheet open/close, toolbar context switch, snap
      feedback — frame-by-frame durations/easing (corpus `06` §6, entirely
      unevidenced). Unblocks: `--cc-motion-sheet-duration`,
      `--cc-motion-sheet-easing`, `--cc-motion-toolbar-crossfade`.
- [ ] **Text/sticker on-canvas manipulation** — handle count/position,
      whether two-finger pinch works alongside handles. M7/M8 scope.
- [ ] **Bottom navigation tab set** (single-sourced, unverified — corpus
      `04` §1.3, §7 item 4). Not part of the editor screen itself; capture
      if the home/project-list screen is ever built.
- [ ] **Keyframe diamond empty/filled states**, and whether mobile CapCut
      has any easing/curve control at all in the 2026 build. Unblocks:
      `KeyframeDiamondIcon`'s `filled` prop in
      `packages/mobile-ui/src/icons/keyframe-diamond.tsx` — currently ships
      a reasonable placeholder convention (outline = no keyframe here,
      filled = keyframe here), not a confirmed CapCut behavior.
- [ ] **Sheet corner radius, exact.** Corpus `06` §5 already flagged this
      low-medium confidence; this session's own edge-scan on
      `iphone_shots/ip_1.jpg` independently hit the same
      marketing-template contamination the corpus warned about (see the
      long comment on `--cc-radius-sheet` in `tokens.css`) — genuinely
      needs a live, uncomposited capture, not another attempt at the same
      marketing screenshots.
- [ ] **Toolbar icon size in situ** (as opposed to the one measured
      menu-grid sample). Unblocks: `--cc-icon-size-toolbar`.
- [ ] **Type scale** — no marketing screenshot gives an unobstructed,
      uncompressed crop of dense UI chrome text. Unblocks: `--cc-text-tab`,
      `--cc-text-label`, `--cc-text-body`, `--cc-text-title`.
- [ ] **Pressed/active-state colors** (accent pressed, disabled states) —
      no such state was visible in any static marketing screenshot.
      Unblocks: `--cc-accent-active`, `--cc-text-disabled`.
- [ ] **Sheet backdrop scrim opacity.** Unblocks: `--cc-bg-scrim`.

## What this session verified directly (not [NEEDS-CAPTURE], for context)

For completeness — these did NOT need a live-device capture because the
existing 10 App Store screenshots already settled them at high confidence,
and this session independently re-verified the two most decision-critical
ones by pixel-sampling the saved JPEGs directly (not just trusting the
corpus's own numbers secondhand):

- `--cc-accent: #00cae0` — re-sampled directly from
  `iphone_shots/ip_9.jpg`'s CTA button interior, 34/36 probe points landed
  exactly on `rgb(0,202,224)`.
- The tab-bar pattern (active = white/weight-600 + cyan underline,
  inactive = gray/weight-400) — re-confirmed by reading
  `iphone_shots/zoom_tabs_ip1.png` and `zoom_tabs_ip5.png` directly.
- `--cc-bg-panel: #202020`, `--cc-text-primary: #f5f5f5`,
  `--cc-text-secondary: #8b8a90` — trusted from the corpus's own
  high-confidence multi-screenshot pixel scan (06 §2.1); not independently
  re-sampled this session, but not flagged [NEEDS-CAPTURE] either.
