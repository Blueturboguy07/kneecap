/**
 * `@kneecap/editor-core/captions` — the caption domain's public surface.
 * Plan M10. Mirrors `edl`'s barrel pattern (see `edl/index.ts`): one clean
 * import path for every external consumer (the web dev harness, the mobile
 * shell, and `@kneecap/native-bridge`'s own cross-package tests) rather than
 * reaching into individual files.
 */
export * from "./generate";
export * from "./styles";
export * from "./layout";
export * from "./resolve-style";
