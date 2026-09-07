import { describe, expect, test } from "bun:test";
import {
	NO_SNAP,
	SNAP_CAPTURE_PX,
	SNAP_RELEASE_PX,
	snapAxisValue,
	snapToCenterAxes,
} from "./axis-snap";

const CAPTURE = 12;
const RELEASE = 28;

describe("snapAxisValue", () => {
	test("captures a free axis inside the capture radius", () => {
		const near = snapAxisValue({
			value: 5,
			wasSnapped: false,
			capture: CAPTURE,
			release: RELEASE,
		});
		expect(near).toEqual({ value: 0, snapped: true });

		const far = snapAxisValue({
			value: 20,
			wasSnapped: false,
			capture: CAPTURE,
			release: RELEASE,
		});
		expect(far).toEqual({ value: 20, snapped: false });
	});

	test("snaps symmetrically on both sides of the axis", () => {
		for (const value of [-5, 5]) {
			expect(
				snapAxisValue({ value, wasSnapped: false, capture: CAPTURE, release: RELEASE }),
			).toEqual({ value: 0, snapped: true });
		}
	});

	test("holds past the capture radius once snapped — the hysteresis", () => {
		// 20 is OUTSIDE capture but INSIDE release. Coming from free it stays
		// free; coming from snapped it stays snapped. Same input, two answers
		// — that is the whole point, and a single-threshold implementation
		// cannot express it.
		const arrivingFree = snapAxisValue({
			value: 20,
			wasSnapped: false,
			capture: CAPTURE,
			release: RELEASE,
		});
		const arrivingSnapped = snapAxisValue({
			value: 20,
			wasSnapped: true,
			capture: CAPTURE,
			release: RELEASE,
		});
		expect(arrivingFree.snapped).toBe(false);
		expect(arrivingSnapped.snapped).toBe(true);
		expect(arrivingSnapped.value).toBe(0);
	});

	test("releases beyond the release radius", () => {
		expect(
			snapAxisValue({ value: 40, wasSnapped: true, capture: CAPTURE, release: RELEASE }),
		).toEqual({ value: 40, snapped: false });
	});

	test("cannot flicker at the boundary", () => {
		// The failure a single threshold produces: snapping outputs 0, 0 is
		// inside the capture zone, so the next frame re-snaps and the element
		// buzzes between two positions while the finger holds still. Walk a
		// finger slowly outward across the capture radius and assert the
		// state only ever changes once, in one direction.
		// Start already on the axis — the realistic state for this walk. (A
		// walk starting free flips once at v=0 simply because 0 is inside the
		// capture radius, which is correct capture, not chatter.)
		let snapped = true;
		const flips: number[] = [];
		for (let v = 0; v <= 60; v += 0.5) {
			const next = snapAxisValue({
				value: v,
				wasSnapped: snapped,
				capture: CAPTURE,
				release: RELEASE,
			});
			if (next.snapped !== snapped) flips.push(v);
			snapped = next.snapped;
		}
		expect(flips.length).toBe(1);
		expect(flips[0]).toBeGreaterThan(RELEASE);
	});

	test("a release smaller than capture is clamped, not obeyed", () => {
		// Misconfigured the other way round, the trigger would invert and
		// chatter. Holding must never be tighter than grabbing.
		const held = snapAxisValue({
			value: 10,
			wasSnapped: true,
			capture: CAPTURE,
			release: 2,
		});
		expect(held.snapped).toBe(true);
	});
});

describe("snapToCenterAxes", () => {
	test("snaps each axis independently", () => {
		// Centred horizontally, far off vertically: X must grab and Y must not.
		const result = snapToCenterAxes({
			x: 3,
			y: 200,
			wasSnapped: NO_SNAP,
			capture: CAPTURE,
			release: RELEASE,
		});
		expect(result).toEqual({ x: 0, y: 200, snapped: { x: true, y: false } });
	});

	test("stays on the vertical axis while dragging ALONG it", () => {
		// The founder's actual ask: "snap to central axes and drag along
		// those." Sliding down the centre line changes Y by hundreds of units
		// while X wanders a few — X must stay pinned the whole way, because
		// only its own perpendicular distance is ever consulted. Snapping the
		// pair as one 2D point would drop the axis the moment Y moved.
		let snapped = { x: true, y: false };
		for (let y = 0; y <= 400; y += 20) {
			const result = snapToCenterAxes({
				x: 4,
				y,
				wasSnapped: snapped,
				capture: CAPTURE,
				release: RELEASE,
			});
			snapped = result.snapped;
			expect(result.x).toBe(0);
			expect(result.snapped.x).toBe(true);
		}
	});

	test("dead centre grabs both axes at once", () => {
		const result = snapToCenterAxes({
			x: 1,
			y: -2,
			wasSnapped: NO_SNAP,
			capture: CAPTURE,
			release: RELEASE,
		});
		expect(result).toEqual({ x: 0, y: 0, snapped: { x: true, y: true } });
	});

	test("shipped thresholds keep capture well inside release", () => {
		// If these ever cross, the trigger stops being a trigger.
		expect(SNAP_CAPTURE_PX).toBeLessThan(SNAP_RELEASE_PX);
		// And capture stays small enough that parking an element just off
		// centre is still possible — the "action at a distance" complaint
		// against naive snapping. A capture radius near release would swallow
		// every nearby position.
		expect(SNAP_CAPTURE_PX).toBeLessThanOrEqual(SNAP_RELEASE_PX / 2);
	});
});
