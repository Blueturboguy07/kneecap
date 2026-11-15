import { describe, expect, test } from "bun:test";
import { ensureGpu, isGpuBroken, isGpuReady, reportGpuFailure } from "../gpu";

// The test preload replaces opencut-wasm with a stub whose initializeGpu
// throws, which is the same as a device with no GPU.
describe("ensureGpu", () => {
	test("resolves false and never rejects when the GPU cannot start", async () => {
		await expect(ensureGpu()).resolves.toBe(false);
		expect(isGpuReady()).toBe(false);
	});

	test("starts the GPU only once", () => {
		expect(ensureGpu()).toBe(ensureGpu());
	});

	test("a GPU failure before a successful start does not block later tries", () => {
		reportGpuFailure(new Error("GPU context not initialized"));
		expect(isGpuBroken()).toBe(false);
	});
});
