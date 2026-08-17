/**
 * Bun test preload. Registered from the repo-root `bunfig.toml`.
 *
 * `mock.module()` has to run before Bun loads the module being mocked, and Bun
 * resolves a test file's static import graph before evaluating any of it — so
 * putting the mock in an ordinary first-position `import` does not work (it was
 * tried; `opencut-wasm` still blew up at load). A preload runs early enough.
 *
 * See ./wasm-stub.ts for what is being stubbed and why.
 */
import "./wasm-stub";
