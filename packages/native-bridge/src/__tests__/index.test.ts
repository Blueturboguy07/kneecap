import { describe, expect, test } from "bun:test";
import { _resetNativeBridgeForTests, getNativeBridge } from "../index";

describe("getNativeBridge", () => {
	test("selects the web-fallback bridge when Capacitor.isNativePlatform() is false (true under bun test: no window/webkit bridge global)", async () => {
		_resetNativeBridgeForTests();
		const bridge = await getNativeBridge();
		expect(bridge.platform).toBe("web");
	});

	test("memoizes: a second call returns the same instance", async () => {
		_resetNativeBridgeForTests();
		const a = await getNativeBridge();
		const b = await getNativeBridge();
		expect(a).toBe(b);
	});
});
