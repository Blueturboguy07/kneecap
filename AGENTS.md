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
- Sign in with publik: the publik module's gate (`apps/mobile/src/publik/publik.ts`, started by `runPublikGate()` in `apps/mobile/src/main.ts`) runs at start-up, before the first screen; it also sends usage telemetry (`app_opened`, then `active_session` every 30 minutes)
- `USES_AI = false`: kneecap calls no model (captions and retouch run on the phone), so there is no plan screen and no publik API provider. If a model call is added, use Base URL https://publikhq.com/api/v1 (OpenAI Chat Completions, Responses, Anthropic Messages) with models publik-fast, publik-balanced, publik-smart only; never a vendor model name
- Key: per-install `pk_` from POST /installs, stored in the app's publik folder (`apps/kneecap.json`, mode 0600, not backed up); launch setting PUBLIK_API_BASE_URL overrides the base URL (tests)
- App token: `PUBLIK_APP_TOKEN` at build time (`apps/mobile/vite.config.ts`; CI uses the repo secret); public by design
- Phone side: `@kneecap/native-bridge/publik-host` and `PublikGatePlugin` (iOS and Android); never import `@capacitor/*` in `apps/mobile/src`
- 402: show error.message plus error.top_up_url only
- Never print or log a key
- Docs: https://publikhq.com/llms.txt, https://publikhq.com/developers, https://publikhq.com/skills/api.md
