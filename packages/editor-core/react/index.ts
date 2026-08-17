/**
 * The ONLY React-aware surface of `@kneecap/editor-core`.
 *
 * Everything under `src/` is framework-agnostic and must stay that way (see
 * scripts/check-headless.mjs). This directory holds the thin
 * `useSyncExternalStore` bridge that lets a React host consume `EditorCore`'s
 * hand-rolled observer managers. Ported verbatim per plan M2 item 3 — it has no
 * desktop-DOM assumptions and works unchanged in a mobile WebView.
 *
 * A non-React host (native Swift/Kotlin over a JS bridge, or a different UI
 * layer) skips this entirely and calls `editor.<manager>.subscribe()` directly.
 */
export { useEditor } from "./use-editor";
