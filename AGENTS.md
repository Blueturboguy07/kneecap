# Agents.md

## Architecture

An ongoing migration is moving all business logic into `rust/`. Each app under `apps/` is a UI shell — it owns rendering, interaction, and platform-specific concerns, but never owns logic. The UI framework for any given app is a replaceable detail.

### `rust/`

The single source of truth for all non-UI code. Everything platform-agnostic belongs here: no components, no hooks, no framework imports.

### `apps/`

Each app is a frontend that calls into Rust. Logic is never duplicated between apps — only UI is, because each platform may use an entirely different framework and language to build it.

- `web/` — Next.js
- `desktop/` — GPUI

## Web

### React

- Read components before using them. They may already apply classes, which affects what you need to pass and how to override them.


## publik API
- Name: the App Store and in-app name is "publik kneecap"; the home-screen label and the home header stay "kneecap" (they would be cut off). Slug, bundle id and scheme stay `kneecap` / `dev.kneecap.app`. Never name or point to another app or brand in code, comments, strings or asset names (`docs/DECISIONS.md`, Nov 14 2026)
- Sign in with publik: the publik module (`apps/mobile/src/publik/publik.ts`, started by `runPublik()` in `apps/mobile/src/main.ts`) runs at start-up, before the native first-run screen; after a sign-in it sends usage telemetry (`app_opened`, then `active_session` every 30 minutes)
- Gate mode: ONE build setting, `PUBLIK_GATE_MODE` = `required` (default: the gate is the first screen, no way past it) or `optional` (no wall; "Sign in with publik" is a row in Settings). Read only in `apps/mobile/vite.config.ts`; CI builds both. App Store and release builds are always `required`; `optional` is a CI test artifact only
- Store build: `APP_STORE_BUILD=1` (App Store and release builds). The build fails unless the gate is required, PUBLIK_TEST_HOOKS, KNEECAP_DEBUG_TOOLS and PUBLIK_ALLOW_NO_TOKEN are off, it runs in GitHub Actions, and no .env file sets PUBLIK_APP_TOKEN (the token comes only from the CI secret). The iOS "Debug-only items" build phase and the Android release check refuse a store build without the bundle marker `publik-build:store`. `apps/mobile/scripts/test-store-build-guards.sh` proves it in CI
- Settings (`apps/mobile/src/app/settings-screen.tsx`): Sign in, Sign out (deletes the key file first, stops usage counting, then revokes the key with a 3 s limit), Delete account (local data, then publik's in-app delete page), the usage-counting switch, Privacy policy, and Licenses (`public/licenses/third-party-licenses.json`, made by `apps/mobile/scripts/generate-licenses.py`; re-run it after a dependency change)
- Not reachable = no answer, or an answer that is not publik's (not JSON, such as a captive portal's 200 page; 408, 429, 5xx, a 2xx that is not a wallet, a 401 or 403 without publik's JSON error). Only publik's JSON 401 or 403 from GET /wallet deletes the key (then at most 2 new keys). A signed-in phone opens offline in all these cases
- POST /installs 403 `install_revoked`: ONE new install with a new random UUID. A saved install id is used only with its saved key
- Sign-out race: Sign out and Delete account count up `forgets` first; a wallet check that waited for publik reads the key again (keyStillSaved) and writes nothing when it is gone
- In-app browser: open ONLY publik's bare in-app pages (no site menu, footer, prices or plan links): sign-in = the server's claim_url with `in_app=1` added (`inAppClaimUrl()`; other query items stay; publik redirects to /in-app/claim/<code>), Delete account = https://publikhq.com/in-app/delete-account, Privacy policy = https://publikhq.com/in-app/privacy. Never the profile, /privacy, /wallet or /pricing pages. The sheet closes by itself after the sign-in (`closeBrowser()` in `pass()`)
- Purchase links: kneecap shows none (no plan screen; the sign-in button opens only the claim page, never the wallet page). If one is ever added: only in the US App Store storefront; elsewhere no link, no button, no price, only: To get a plan, search for "publik" on Google
- `USES_AI = false`: kneecap calls no model (captions and retouch run on the phone), so there is no plan screen and no publik API provider. If a model call is added, use Base URL https://publikhq.com/api/v1 (OpenAI Chat Completions, Responses, Anthropic Messages) with models publik-fast, publik-balanced, publik-smart only; never a vendor model name
- Key: per-install `pk_` from POST /installs, stored in the app's publik folder (`apps/kneecap.json`, mode 0600, not backed up); launch setting PUBLIK_API_BASE_URL overrides the base URL (tests)
- Launch settings are test hooks: Android reads them only in a debuggable build; iOS reads PUBLIK_API_BASE_URL only in Debug or with the Swift condition PUBLIK_TEST_HOOKS (only those builds get NSAllowsLocalNetworking); the web side accepts only a local base URL unless the bundle has PUBLIK_TEST_HOOKS=1. Never ship a test-hooks build. Android MainActivity is not exported in src/main
- App token: `PUBLIK_APP_TOKEN` at build time (`apps/mobile/vite.config.ts`; CI uses the repo secret); public by design. A store build without a `pat_` token fails (opt-out `PUBLIK_ALLOW_NO_TOKEN=1`, fork pull requests only); `check-web-bundle.sh` and `release.yml` check it too, without printing it
- Phone side: `@kneecap/native-bridge/publik-host` and `PublikGatePlugin` (iOS and Android); never import `@capacitor/*` in `apps/mobile/src`
- 402: show error.message; show error.top_up_url only where the purchase-link rule above allows a link
- Never print or log a key
- Docs: https://publikhq.com/llms.txt, https://publikhq.com/developers, https://publikhq.com/skills/api.md
