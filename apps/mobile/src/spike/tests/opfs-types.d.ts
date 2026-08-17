/**
 * Minimal ambient declarations for the OPFS `createSyncAccessHandle` API.
 *
 * This project's `lib` is `["dom", "dom.iterable", "esnext"]`
 * (`apps/mobile/tsconfig.json`) — `FileSystemSyncAccessHandle` only exists in
 * TypeScript's `lib.webworker.d.ts`, and `dom` + `webworker` cannot both be
 * listed (they redeclare overlapping globals, e.g. `self`). Declaring just
 * the members this harness actually calls avoids pulling in the whole
 * conflicting lib for one Worker-only API — see plan M1 item 5 / `../types.ts`
 * `OpfsStorageResult` and `./opfs-storage.ts`.
 */
export {};

declare global {
	interface FileSystemSyncAccessHandle {
		read(buffer: ArrayBufferView, options?: { at?: number }): number;
		write(buffer: ArrayBufferView, options?: { at?: number }): number;
		truncate(newSize: number): void;
		getSize(): number;
		flush(): void;
		close(): void;
	}

	interface FileSystemFileHandle {
		createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
	}
}
