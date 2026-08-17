# Decisions

This file is the ratification record for the six founder decisions in
the kneecap plan (`~/.claude/plans/opencut-mobile-port.md`, §8 "Founder
decisions"). It is copied verbatim from plan §8.0, which is itself the
authoritative record — if this file and the plan ever disagree, the plan
wins and this file is stale and should be re-synced.

The full option analysis behind each decision (§8.1–§8.6 of the plan)
is retained there, not duplicated here; this file exists so "what did we
decide and why" is answerable from inside the repo without also having
the plan file open.

---

## 8.0 Ratification record — all six decided by Mann, 2026-08-17

1. **8.1 Fork base: A (opencut-classic), framed as C.** Executed —
   forked as **`Blueturboguy07/kneecap`**, cloned at `~/kneecap`.
   Quarterly review of the upstream rewrite stands.
2. **8.2 Naming: delegated to Claude; chosen "kneecap"** (repo and app
   name; original icon/splash designed in M6). Attribution posture (ii)
   — prominent "based on OpenCut-app/opencut-classic (MIT)" credit.
   Upstream posture (ii) — independent fork.
3. **8.3 Visual differentiation: B1 — full pixel fidelity, OVERRIDING
   the B2 recommendation.** Founder's words: the target is that using it
   "feels like the same experience as using CapCut. Not OpenCut, CapCut."
   The B2 divergence checklist below is **void** except that the
   original name/icon/splash stand. Exact measured CapCut tokens —
   including cyan `#00CAE0`, the spacing rhythm, and motion timing — are
   IN. With no store release (see 8.5) the app-review exposure is moot;
   the residual takedown surface is the GitHub repo and publik listing
   (trade-dress complaint / DMCA), accepted by the founder. Mitigation
   kept: never use CapCut's name or marks in repo description, listing
   copy, or screenshot framing.
4. **8.4 Adjust: yes — basic sliders in v1;** HSL and curves deferred.
   The bundled-assets sub-question resolves by default under no-store
   (no size-ceiling pressure): bundle whisper `base` (142MiB) plus a
   small CC0/OFL starter pack of fonts/stickers/sounds.
5. **8.5 Store strategy: OVERRIDDEN — no app-store release on either
   platform.** M13 is rewritten for direct distribution (GitHub Releases
   + publik guides; signed APK on Android, sideload paths on iOS).
   Consequences applied throughout: M3 item 7 and M12 CI item 8 build
   signed *direct* artifacts instead of TestFlight/Play-track uploads;
   risk-register #9 (Play webview classifier) and every Apple/Google
   review mitigation are downgraded to dormant-unless-revisited. The
   iOS 17.0 floor stands.
6. **8.6 Device budget: approved** — current iPhone, iPhone 13-class,
   Pixel a-series, one budget/Go-class Android.

The original per-decision option analysis (§8.1–§8.6, including the full
recommendation tables the founder overrode on items 3 and 5) is retained
in the plan and is not duplicated here.

---

## What this means for code in this repo, concretely

A few decisions above are easy to nod along with and then violate by
accident in a specific PR. Spelling out the concrete implications:

- **Decision 3 (B1 full pixel fidelity)** means CapCut's exact measured
  tokens — including cyan `#00CAE0` — are the correct target for
  `packages/mobile-ui/tokens.css` once M6 lands, **not** a violation of
  "no CapCut marks." What stays original per the ratification record:
  the app name ("kneecap"), the app icon, and the splash screen. CapCut's
  *name* and *logo/wordmark* must still never appear in repo
  description, listing copy, README, or screenshot framing (that's a
  separate constraint from the token/pixel decision, and it did **not**
  get overridden).
- **Decision 5 (no store release)** means M3/M12/M13's CI produces
  signed **direct-distribution** artifacts (APK for Android; ad-hoc/
  unsigned `.ipa` for iOS sideload flows) — never a TestFlight or Play
  Console upload step. `scripts/invariants.sh` and its CI workflow are
  written with this in mind.
- **Decision 1 (fork opencut-classic, archived)** is why
  `scripts/offline-audit.sh`, `docs/THIRD_PARTY_NOTICES.md`, and
  `docs/DECISIONS.md` (this file) exist at all as CI-gated artifacts
  rather than one-off docs: we own this dependency tree permanently
  (plan risk register #6), with no upstream to receive security/dep
  patches from.
- **Zero-cost/local-first is a hard directive independent of, but
  reinforced by, decision 5** — a no-store, direct-distribution app has
  no app-review backstop forcing an offline story either; the offline
  guarantee has to be self-enforced in this repo, which is what
  `scripts/offline-audit.sh` is for.

## Known, tracked exceptions to "fully functional offline"

- `apps/web/src/services/transcription/worker.ts` (on-device auto
  captions via `@huggingface/transformers`) can reach `huggingface.co`
  and `cdn.jsdelivr.net` on first use — flagged, not hidden, as a
  non-blocking warning by `scripts/offline-audit.mjs` (see
  `KNOWN_VENDOR_ML_RUNTIME_SIGNATURES` in that file for the full
  writeup). Real fix is plan M1/M4's native whisper.cpp bridge, or
  properly wiring transformers.js's local-model/offline mode — not a
  one-line change.
- Font bundling (`apps/web/src/fonts/local-fonts.css`) currently covers
  Inter end-to-end as the proof of the local-fonts pattern. The other
  ~1900 families browsable in the font picker's atlas are preview-only
  (local sprite images) and not yet selectable offline — deferred to
  plan M8's curated font set by design, not an oversight.
- The Rust/Cargo dependency tree (`rust/crates/*`, `rust/wasm`) has not
  had a license/CVE audit yet — `docs/THIRD_PARTY_NOTICES.md`'s "NPM /
  Bun dependencies" section covers the JS/TS tree only. Tracked as a
  follow-up for whoever next touches the Rust workspace.
