/**
 * `createSyncAccessHandle` is Worker-only per spec (WHATWG File System
 * Access / OPFS). See `opfs-storage.ts`'s file header for why this exists
 * as a separate module instead of being inline in that file.
 */
import { runSyncAccessHandle } from "./opfs-storage";

runSyncAccessHandle().then((result) => {
	postMessage(result);
});
