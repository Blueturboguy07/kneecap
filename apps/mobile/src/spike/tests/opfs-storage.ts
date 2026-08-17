/**
 * Test 5 (plan M1 item 5): write and read a 200MB file via
 * `createSyncAccessHandle` AND `createWritable()` inside a real WKWebView
 * (not Safari) on current iOS — positively closing the residual
 * `14-gap-1.md` uncertainty (plan §2.6 already debunked the "10MB per OPFS
 * file" claim from source, but that was a documentation read, not an
 * on-device measurement; this is the on-device measurement).
 *
 * Runs unmodified in a plain browser too (mediabunny/OPFS APIs are
 * standards, not Capacitor-specific) — useful for a `bun run dev` sanity
 * check before ever touching a device, though the plan is explicit that the
 * WKWebView-specific result is the one that matters (Safari's OPFS
 * implementation is not guaranteed identical).
 *
 * `createSyncAccessHandle` is only available inside a dedicated Worker
 * (spec requirement) — this file's `run*` functions are written to be
 * called from a Worker context; `main.ts` dispatches to a tiny inline
 * Worker for exactly that reason.
 */
import type { OpfsStorageResult } from "../types";

const TARGET_BYTES = 200 * 1024 * 1024; // 200MB
const CHUNK_BYTES = 4 * 1024 * 1024; // write in 4MB chunks
const VERIFY_SAMPLE_BYTES = 1024; // spot-check, not a full re-read of 200MB

function buildChunk({ seed, size }: { seed: number; size: number }): Uint8Array<ArrayBuffer> {
	const chunk = new Uint8Array(new ArrayBuffer(size));
	// Deterministic, cheap-to-verify pattern — not cryptographically
	// meaningful, just enough to catch silent truncation/corruption.
	for (let i = 0; i < size; i++) {
		chunk[i] = (seed + i) & 0xff;
	}
	return chunk;
}

async function runSyncAccessHandle(): Promise<OpfsStorageResult["syncAccessHandle"]> {
	if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
		return {
			attempted: false,
			succeeded: false,
			writeMs: null,
			readMs: null,
			bytesVerified: null,
			error: "navigator.storage.getDirectory unavailable in this context.",
		};
	}

	let handle: FileSystemSyncAccessHandle | null = null;
	try {
		const root = await navigator.storage.getDirectory();
		const fileHandle = await root.getFileHandle("spike-sync-200mb.bin", { create: true });
		handle = await fileHandle.createSyncAccessHandle();

		const writeStart = performance.now();
		let written = 0;
		let seed = 0;
		while (written < TARGET_BYTES) {
			const size = Math.min(CHUNK_BYTES, TARGET_BYTES - written);
			const chunk = buildChunk({ seed, size });
			handle.write(chunk, { at: written });
			written += size;
			seed++;
		}
		handle.flush();
		const writeMs = performance.now() - writeStart;

		const readStart = performance.now();
		const verifyBuffer = new Uint8Array(VERIFY_SAMPLE_BYTES);
		handle.read(verifyBuffer, { at: 0 });
		const expected = buildChunk({ seed: 0, size: VERIFY_SAMPLE_BYTES });
		const matches = verifyBuffer.every((byte, i) => byte === expected[i]);
		const readMs = performance.now() - readStart;

		if (!matches) {
			throw new Error("Read-back verification failed: written bytes did not round-trip.");
		}

		return {
			attempted: true,
			succeeded: true,
			writeMs,
			readMs,
			bytesVerified: written,
			error: null,
		};
	} catch (err) {
		return {
			attempted: true,
			succeeded: false,
			writeMs: null,
			readMs: null,
			bytesVerified: null,
			error: err instanceof Error ? err.message : "unknown createSyncAccessHandle error",
		};
	} finally {
		handle?.close();
		try {
			const root = await navigator.storage.getDirectory();
			await root.removeEntry("spike-sync-200mb.bin");
		} catch {
			// Best-effort cleanup.
		}
	}
}

async function runCreateWritable(): Promise<OpfsStorageResult["createWritable"]> {
	if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
		return {
			attempted: false,
			succeeded: false,
			writeMs: null,
			readMs: null,
			bytesVerified: null,
			error: "navigator.storage.getDirectory unavailable in this context.",
		};
	}

	try {
		const root = await navigator.storage.getDirectory();
		const fileHandle = await root.getFileHandle("spike-writable-200mb.bin", { create: true });

		const writeStart = performance.now();
		const writable = await fileHandle.createWritable();
		let written = 0;
		let seed = 0;
		while (written < TARGET_BYTES) {
			const size = Math.min(CHUNK_BYTES, TARGET_BYTES - written);
			await writable.write(buildChunk({ seed, size }));
			written += size;
			seed++;
		}
		await writable.close();
		const writeMs = performance.now() - writeStart;

		const readStart = performance.now();
		const file = await fileHandle.getFile();
		const bytesVerified = file.size;
		const sample = new Uint8Array(await file.slice(0, VERIFY_SAMPLE_BYTES).arrayBuffer());
		const expected = buildChunk({ seed: 0, size: VERIFY_SAMPLE_BYTES });
		const matches = sample.every((byte, i) => byte === expected[i]);
		const readMs = performance.now() - readStart;

		if (!matches || bytesVerified !== TARGET_BYTES) {
			throw new Error(
				`Read-back verification failed: size=${bytesVerified}, expected=${TARGET_BYTES}, samplesMatch=${matches}`,
			);
		}

		return { attempted: true, succeeded: true, writeMs, readMs, bytesVerified, error: null };
	} catch (err) {
		return {
			attempted: true,
			succeeded: false,
			writeMs: null,
			readMs: null,
			bytesVerified: null,
			error: err instanceof Error ? err.message : "unknown createWritable error",
		};
	} finally {
		try {
			const root = await navigator.storage.getDirectory();
			await root.removeEntry("spike-writable-200mb.bin");
		} catch {
			// Best-effort cleanup.
		}
	}
}

export async function runOpfsStorage(): Promise<OpfsStorageResult> {
	// createWritable() works on the main thread; createSyncAccessHandle needs
	// a Worker (spec requirement — see file header). Run createWritable()
	// directly here and delegate the sync-access half to a Worker.
	const createWritable = await runCreateWritable();
	const syncAccessHandle = await runSyncAccessHandleViaWorker();
	return { testId: "opfs-storage", syncAccessHandle, createWritable };
}

function runSyncAccessHandleViaWorker(): Promise<OpfsStorageResult["syncAccessHandle"]> {
	return new Promise((resolve) => {
		try {
			const worker = new Worker(new URL("./opfs-sync-worker.ts", import.meta.url), {
				type: "module",
			});
			const timeout = setTimeout(() => {
				worker.terminate();
				resolve({
					attempted: true,
					succeeded: false,
					writeMs: null,
					readMs: null,
					bytesVerified: null,
					error: "Worker timed out after 30s.",
				});
			}, 30_000);
			worker.onmessage = (event: MessageEvent<OpfsStorageResult["syncAccessHandle"]>) => {
				clearTimeout(timeout);
				worker.terminate();
				resolve(event.data);
			};
			worker.onerror = (event) => {
				clearTimeout(timeout);
				worker.terminate();
				resolve({
					attempted: true,
					succeeded: false,
					writeMs: null,
					readMs: null,
					bytesVerified: null,
					error: event.message || "Worker error",
				});
			};
		} catch (err) {
			resolve({
				attempted: false,
				succeeded: false,
				writeMs: null,
				readMs: null,
				bytesVerified: null,
				error: err instanceof Error ? err.message : "Worker construction failed",
			});
		}
	});
}

export { runSyncAccessHandle };
