/**
 * The one place that starts the GPU for the renderer.
 *
 * Each bundled copy of `opencut-wasm` has its own wasm instance and its own
 * GPU state. The compositor (wasm-compositor.ts) uses the copy that this
 * package imports, so the GPU must be started HERE. If another package
 * imports `initializeGpu` itself, it can start the GPU in a different copy,
 * and every compositor call then fails with "GPU context not initialized".
 */
import { initializeGpu } from "opencut-wasm";

/** How long a caller waits for the GPU before it draws with Canvas 2D.
 *  The GPU start keeps going after this; renderers made later can use it. */
export const GPU_START_TIMEOUT_MS = 5000;

let startPromise: Promise<boolean> | null = null;

/**
 * The app shell can turn the GPU off before the page loads, with
 * `window.__KNEECAP_NO_GPU__` (a reason string). The iOS shell does this in
 * the simulator (SceneDelegate.swift): there WebGPU starts, but the first
 * real frame fails with a wgpu "Out of Memory" panic, and the panic leaves
 * the wasm instance unusable (1.0.4 simulator test). The renderer then draws
 * with Canvas 2D from the first frame.
 */
export function gpuDisabledReason(): string | null {
	const flag = (globalThis as { __KNEECAP_NO_GPU__?: unknown }).__KNEECAP_NO_GPU__;
	return flag ? String(flag) : null;
}
let ready = false;
let broken = false;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Starts the GPU once per process. It never rejects: `false` means "no GPU
 * yet" (the start failed or took longer than GPU_START_TIMEOUT_MS), and the
 * renderer then draws with Canvas 2D.
 */
export function ensureGpu(): Promise<boolean> {
	if (!startPromise && gpuDisabledReason()) {
		console.info(`GPU renderer off (${gpuDisabledReason()}), drawing with Canvas 2D`);
		startPromise = Promise.resolve(false);
	}
	if (!startPromise) {
		const start = Promise.resolve()
			.then(() => initializeGpu())
			.then(() => {
				ready = true;
				console.info("GPU renderer ready");
				return true;
			})
			.catch((error: unknown) => {
				console.warn(`GPU renderer unavailable, drawing with Canvas 2D: ${errorMessage(error)}`);
				return false;
			});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => {
				console.warn(
					`GPU renderer did not start in ${GPU_START_TIMEOUT_MS} ms, drawing with Canvas 2D`,
				);
				resolve(false);
			}, GPU_START_TIMEOUT_MS);
		});
		startPromise = Promise.race([start, timeout]).finally(() => clearTimeout(timer));
	}
	return startPromise;
}

/** True when the GPU started and no GPU call has failed for good. */
export function isGpuReady(): boolean {
	return ready && !broken;
}

/** True after a GPU call failed although the GPU had started. */
export function isGpuBroken(): boolean {
	return broken;
}

/**
 * Records a failed GPU call. When the GPU had started, the failure will not
 * fix itself, so new renderers stop trying the GPU and draw with Canvas 2D.
 * When the GPU never started here (another app shell started it, or it is
 * still starting), nothing is recorded: the next renderer tries again.
 */
export function reportGpuFailure(error: unknown): void {
	if (!ready || broken) return;
	broken = true;
	console.warn(`GPU renderer failed, drawing with Canvas 2D: ${errorMessage(error)}`);
}
