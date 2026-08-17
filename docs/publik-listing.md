# publik listing copy — kneecap

**Status: DRAFT.** Repo-hosted copy for kneecap's future publik listing
(`publikhq.com/kneecap`). **Not submitted or published anywhere.** This
is a draft for review, written against the plan's locked v1 scope; some
described features (multi-track timeline UI, export sheet, on-device
captions) are still in progress — see `docs/DECISIONS.md` and the plan
milestones for what's actually shipped vs. planned. Re-check every
scope claim below against the real app before this ever goes live, and
strip anything not yet true.

No CapCut name, marks, or copyrighted assets appear anywhere below, per
plan §8.0 item 3 / `docs/DECISIONS.md`.

---

## Listing title

```
kneecap
```

## Tagline (one line, card-level)

```
A local-first mobile video editor. No account, no cloud, no watermark.
```

## Category

`Video & Photo` / `Creative Tools`

## Platforms

`Android` · `iOS (sideload)`

## Short description (listing card, ~2–3 sentences)

```
kneecap is an open-source, touch-first video editor for iOS and
Android. Multi-track timeline editing, transitions, text and stickers,
filters, speed ramps, and on-device auto-captions — all running
entirely on your phone, with zero network requests and zero account
required. Free forever, MIT-licensed, no watermark.
```

## Full description

```
kneecap is a mobile video editor built for people who want a fast,
capable, touch-first editing experience without handing their footage
to anyone's server.

Everything runs on-device:
  • Multi-track timeline — video, overlays, text, stickers, audio
  • Trim, split, speed ramp, reverse, freeze frame
  • Transitions, filters, and an Adjust panel (brightness, contrast,
    saturation, temperature, and more)
  • Text and stickers with animation, from a bundled local library
  • On-device automatic captions (speech-to-text runs on your phone —
    audio never leaves it)
  • Hardware-accelerated export, straight to your camera roll / gallery

What kneecap doesn't have, on purpose:
  • No account, no sign-in, no cloud sync
  • No watermark, no paywall, no in-app purchases
  • No ads, no analytics beyond an optional, anonymized, opt-in crash
    report
  • No network requests during editing or export — verified by this
    project's own CI on every change (see scripts/offline-audit.mjs in
    the repo)

kneecap is a fork of the archived, open-source
OpenCut-app/opencut-classic engine (MIT License), rebuilt from the
ground up with a new touch-first mobile interface. It is free and
open-source software — MIT-licensed, source on GitHub, no company
behind it monetizing your edits or your data.

kneecap is not available on the App Store or Play Store by design (see
the linked guides below for why, and how to install anyway) — this
keeps the project independent of any store's review process, revenue
cut, or policy changes.
```

## Install guide CTA

```
📱 Android → docs/guides/android-sideload.md ("Install kneecap on Android")
🍎 iPhone  → docs/guides/ios-xcode-build.md ("Install kneecap on iPhone")
```

(Per the publik (computer, phone) branch model: Android needs only the
phone. iOS needs a Mac for either install path — call this out plainly
in the listing's guide-selection step, the same way the existing
"Windows+iPhone is a real dead end" constraint is handled for other
publik listings.)

## Pricing

```
Free. No IAP, no subscription, no ads.
```

## Links

```
Source:  https://github.com/Blueturboguy07/kneecap
License: MIT (with attribution to OpenCut-app/opencut-classic —
         see NOTICE and docs/THIRD_PARTY_NOTICES.md in the repo)
```

## Screenshot guidance (do not skip before publishing)

Per plan risk register #11 and `docs/DECISIONS.md`: screenshots must
not visually **compose** like any commercial editor's own marketing
screenshots (same framing, same demo clip, same caption placement),
even though the in-app UI itself is allowed to be pixel-faithful
(plan §8.0 item 3, B1). Use kneecap's own original app icon and splash
in any listing chrome/frame — never a borrowed device-frame template
that also appears in a competitor's own store listing.

## Attribution / disclaimer (footer, required on every listing surface)

```
kneecap is an independent, community fork. It is not affiliated with,
endorsed by, or sponsored by OpenCut, OpenCut-app, or any other video
editing app or company. Based on OpenCut-app/opencut-classic (MIT
License) — see the repository's NOTICE file for the full attribution.
```

---

## Notes for whoever posts this

- This is copy only. Do not call the publik submission flow, the Iris
  guide publish step, or any listing API from an agent session against
  this draft — that's a founder action, same as every other publik
  listing in this project's history.
- Verify the "what kneecap doesn't have" bullet list against
  `scripts/offline-audit.sh`'s actual current findings before
  publishing — `docs/DECISIONS.md`'s "Known, tracked exceptions to
  fully functional offline" section lists one real gap
  (transcription's `@huggingface/transformers` first-use fetch) that
  this copy currently glosses over. Either fix it, or the listing copy
  needs a caveat.
- The "on-device automatic captions" and "hardware-accelerated export"
  bullets describe plan milestones M9/M10, not yet built as of this
  draft (M12/M13 scaffolding session). Do not publish this listing
  before those ship, or trim the copy down to what's actually true at
  publish time.
