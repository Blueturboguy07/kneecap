# kneecap

A local-first, fully offline mobile video editor, built for CapCut-mobile
feature and visual parity.

**kneecap is an independent, community fork.** It is **not affiliated
with, endorsed by, or sponsored by** OpenCut, OpenCut-app, CapCut,
ByteDance, or TikTok Pte. Ltd. "CapCut" is referenced in this repo's
planning docs only as a functional/visual parity target for the editor
we're building — no CapCut trademarks, marks, or copyrighted assets are
bundled, redistributed, or reproduced here. See `docs/DECISIONS.md` for
the full attribution and naming posture.

## Based on OpenCut-app/opencut-classic (MIT)

kneecap is forked from
[**`OpenCut-app/opencut-classic`**](https://github.com/OpenCut-app/opencut-classic)
— the archived-but-complete Next.js/Rust engine behind the original
OpenCut web editor — licensed under the **MIT License**. The original
copyright notice and license are preserved verbatim in `LICENSE`; see
`NOTICE` for the attribution statement and `docs/THIRD_PARTY_NOTICES.md`
for a full inventory of bundled third-party assets and dependency
licenses.

`opencut-classic` was archived by its maintainers on 2026-05-16. This
fork receives no upstream commits and owns its entire dependency and
security surface going forward — see `docs/DECISIONS.md` for what that
means in practice. It is **unrelated to and not a redistribution of**
the separate, actively-developed `OpenCut-app/OpenCut` rewrite.

## What this is

kneecap strips the inherited engine down to its headless editing core —
timeline, ripple/placement, effects, storage — and is being rebuilt as a
touch-first, CapCut-mobile-shaped editor for iOS and Android, running
fully on-device:

- **Zero cloud dependency.** No account, no server, no paid API of any
  kind. The app is designed to work correctly with the network off.
- **On-device auto-captions**, multi-track timeline editing, trim/split,
  transitions, text/stickers, filters, speed ramping, and
  hardware-accelerated export — all local.
- **No app-store release.** kneecap is distributed directly (signed
  builds via GitHub Releases + install guides), not through the Apple
  App Store or Google Play. See `docs/DECISIONS.md` §8.5.

The full architecture and milestone plan lives outside this repo in the
project's planning documents; `docs/DECISIONS.md` is the in-repo record
of what's been ratified and why.

## Current status

This repo is mid-fork: the inherited codebase is a Next.js 16 web app
(`apps/web/`) with the original desktop shell (`apps/desktop/`, GPUI) and
Rust/WASM compositor (`rust/`) still present.

**M2 landed the headless engine extraction.** The editing engine now
lives in `packages/editor-core` — `EditorCore` and its 12 managers,
timeline/placement/ripple/retime, the command system, storage and its
31 migrations, the renderer graph, and the frozen **EDL v1** bridge
contract (`docs/EDL.md`). It contains no React, Next, or UI-library
imports, enforced two ways: the package type-checks standalone with
`@/*` mapped to its own `src` only, and `scripts/check-headless.mjs`
scans every file. `apps/web` consumes it and keeps working.

The mobile shell (`apps/mobile/`) does not exist yet — see the plan's
milestone list for sequencing. Treat what remains under `apps/web/src`
as inherited *UI* code being progressively adapted, not as the shipped
mobile product.

## Project structure

- `packages/editor-core/` — **the headless editing engine.** Framework-
  agnostic TypeScript: no React, no DOM-desktop assumptions, no server.
  Its `react/` subdirectory holds the one React-aware file, the
  `useSyncExternalStore` bridge. `schema/edl-v1.json` is the frozen
  native-export contract; see `docs/EDL.md`.
- `apps/web/` — inherited Next.js web application. Now the *UI host* for
  `packages/editor-core`, and the dev harness for engine work.
- `apps/desktop/` — inherited native desktop shell (GPUI), not a build
  target for this project.
- `rust/` — the Rust/wgpu compositor compiled to WASM (`rust/wasm`) and
  its supporting crates (`rust/crates/{gpu,compositor,effects,masks,time}`).
- `docs/` — architecture notes, `EDL.md` (the frozen EDL v1 bridge
  contract — read this before writing a native exporter), `DECISIONS.md`
  (ratified founder decisions), `THIRD_PARTY_NOTICES.md`,
  `RELEASING.md` (how signed direct-distribution releases are cut —
  plan M13's no-app-store section), and `guides/` + `publik-listing.md`
  (draft install guides and listing copy; repo docs only, not yet
  published anywhere).
- `scripts/` — `offline-audit.{sh,mjs}` (the CI gate that keeps the app
  network-free), `invariants.sh` (the merge gate), `check-headless.mjs`
  (the `packages/editor-core` import gate), and
  `generate-third-party-notices.mjs`.

## Getting started

Prerequisite: [Bun](https://bun.sh/docs/installation) `1.2.18` (see
`packageManager` in `package.json` — this repo does not use npm/pnpm/yarn).

```bash
bun install
bun run build:web   # builds apps/web via Turborepo
bun run dev:web     # local dev server, http://localhost:3000
```

No database, no Docker, and no `.env` setup is required — the auth,
Postgres/Drizzle, and CMS/blog surfaces this codebase inherited from
upstream have been removed (see `docs/DECISIONS.md`'s "known, tracked
exceptions" section for the one remaining non-offline code path and its
tracking status).

### Verifying the offline guarantee

```bash
bash scripts/offline-audit.sh   # wants apps/web/.next to exist; run after a build
```

This scans both source and the built bundle for outbound network
references and fails on anything not explicitly allowlisted as a
plain outbound link (e.g. a GitHub credit link) — see the script's own
header comment for the full allowlist and rationale.

### Running the merge gate locally

```bash
bash scripts/invariants.sh
```

Runs the same build → typecheck → lint → unit tests → offline-audit →
architecture-gate sequence CI runs on every push/PR. See
`scripts/invariants.sh`'s header comment for what's strict today versus
what's a documented, non-blocking placeholder pending a later milestone.

### Local WASM development

Only needed if you're editing `rust/wasm` and want the web app to use
your local build instead of the published `opencut-wasm` package.

```bash
# once: Rust toolchain + wasm-pack + cargo-watch
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install wasm-pack cargo-watch

# build once from the repo root
bun run build:wasm

# register + link the local build into apps/web
cd rust/wasm/pkg && bun link
cd ../../../apps/web && bun link opencut-wasm

# rebuild on changes
bun run dev:wasm
```

Switch back to the published package with `cd apps/web && bun add opencut-wasm`.

## License

[MIT](LICENSE) — see `NOTICE` for the required upstream attribution and
`docs/THIRD_PARTY_NOTICES.md` for third-party asset and dependency
licenses.
