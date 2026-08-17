# Third-Party Notices

kneecap is a fork of [`OpenCut-app/opencut-classic`](https://github.com/OpenCut-app/opencut-classic)
(MIT License; see `LICENSE` at the repo root). This file additionally
tracks third-party assets bundled directly into the repo (as opposed to
npm/Cargo dependencies, which carry their own licenses via the package
registry and are not duplicated here).

This is a living document — it currently only covers the assets added
while stripping the network surface (plan M0). It is expected to grow as
later milestones (e.g. M6's curated font/icon work) add more.

## Fonts

### Inter

- **Files:** `apps/web/public/fonts/local/inter-latin.woff2`,
  `apps/web/public/fonts/local/inter-latin-ext.woff2`
- **License:** SIL Open Font License, version 1.1 (OFL-1.1)
- **Source:** [rsms/inter](https://github.com/rsms/inter) — fetched via
  Google Fonts' `css2` API (`fonts.googleapis.com`/`fonts.gstatic.com`)
  as a one-time build step and vendored in; the running app never
  requests these hosts (see `apps/web/src/fonts/local-fonts.css` and
  `scripts/offline-audit.mjs`).
- **Copyright:** Copyright 2020 The Inter Project Authors
  (https://github.com/rsms/inter)

The OFL permits bundling, embedding, and redistribution as part of a
larger software work without a separate license file per embedding, so
long as the font itself is not sold on its own. It is included here for
completeness and traceability.
