import { describe, expect, test } from "bun:test";
import {
	formatRulerTimecode,
	rulerTickIntervalSec,
	rulerTicks,
} from "../timeline/ruler";

describe("rulerTickIntervalSec", () => {
	test("picks a denser interval at higher zoom (more pixels per second)", () => {
		const zoomedIn = rulerTickIntervalSec({ pixelsPerSecond: 300 });
		const zoomedOut = rulerTickIntervalSec({ pixelsPerSecond: 5 });
		expect(zoomedIn).toBeLessThan(zoomedOut);
	});

	test("chosen interval always yields at least the minimum pixel spacing", () => {
		for (const pixelsPerSecond of [1, 5, 20, 60, 200, 1000]) {
			const interval = rulerTickIntervalSec({ pixelsPerSecond });
			expect(interval * pixelsPerSecond).toBeGreaterThanOrEqual(48 - 1e-9);
		}
	});
});

describe("formatRulerTimecode", () => {
	test("formats under an hour as MM:SS", () => {
		expect(formatRulerTimecode({ timeSec: 0 })).toBe("00:00");
		expect(formatRulerTimecode({ timeSec: 65 })).toBe("01:05");
		expect(formatRulerTimecode({ timeSec: 599 })).toBe("09:59");
	});

	test("formats an hour+ as H:MM:SS", () => {
		expect(formatRulerTimecode({ timeSec: 3661 })).toBe("1:01:01");
	});

	test("never goes negative", () => {
		expect(formatRulerTimecode({ timeSec: -5 })).toBe("00:00");
	});
});

describe("rulerTicks", () => {
	test("covers the full duration inclusive of the end", () => {
		const ticks = rulerTicks({ durationSec: 10, intervalSec: 5 });
		expect(ticks).toEqual([0, 5, 10]);
	});

	test("degenerate interval falls back to a single tick, not an infinite loop", () => {
		expect(rulerTicks({ durationSec: 10, intervalSec: 0 })).toEqual([0]);
	});
});
