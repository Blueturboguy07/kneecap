/**
 * EDL v1 — the frozen bridge contract. See docs/EDL.md.
 *
 *   buildEdl({ project, scene, mediaAssets, output })  -> Edl
 *   serializeEdl({ edl })                              -> canonical JSON
 *   validateEdl({ edl, options: { strict } })          -> { ok, errors, warnings }
 *
 * The JSON Schema for third-party (Swift / Kotlin) consumers lives at
 * `packages/editor-core/schema/edl-v1.json` and is checked against this
 * module's own output by `src/edl/__tests__/edl.test.ts` — the two cannot
 * drift apart without a test going red.
 */
export * from "./types";
export * from "./rational";
export * from "./build";
export * from "./validate";
