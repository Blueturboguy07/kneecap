import { describe, expect, test } from "bun:test";
import { detectGpuBackend } from "../gpu-detect";

describe("detectGpuBackend", () => {
	test("returns 'unknown' when neither navigator.gpu nor document exist (bun test has no DOM)", async () => {
		const backend = await detectGpuBackend();
		expect(backend).toBe("unknown");
	});
});
