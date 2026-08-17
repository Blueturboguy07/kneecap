import { describe, expect, test } from "bun:test";
import { subscribeToEvents } from "../event-generator";
import type { ListenerHandle, ListenerSource } from "../event-generator";

interface FakeEvent {
	assetId: string;
	stage: "transcoding" | "done" | "error";
	fraction: number;
}

/** A fake Capacitor-plugin-shaped event source: `addListener` registers a
 * callback; `emit` drives it, exactly like a real `notifyListeners` call
 * would from the native side. `removed` records whether the consumer
 * cleaned up. */
function createFakeSource(): {
	source: ListenerSource<FakeEvent>;
	emit: (event: FakeEvent) => void;
	removed: () => boolean;
} {
	let callback: ((event: FakeEvent) => void) | null = null;
	let removed = false;
	const source: ListenerSource<FakeEvent> = {
		// eslint-disable-next-line opencut/prefer-object-params -- mirrors the real Capacitor plugin proxy's positional `addListener(eventName, callback)` shape (packages/native-bridge/src/event-generator.ts's `ListenerSource<T>`), which this fake exists to stand in for.
		addListener(_eventName, cb) {
			callback = cb;
			const handle: ListenerHandle = {
				remove() {
					removed = true;
				},
			};
			return handle;
		},
	};
	return {
		source,
		emit: (event) => callback?.(event),
		removed: () => removed,
	};
}

const isTerminal = (e: FakeEvent) => e.stage === "done" || e.stage === "error";

describe("subscribeToEvents", () => {
	test("the listener is live as soon as the promise resolves — events fired immediately after are not dropped", async () => {
		const { source, emit } = createFakeSource();
		const gen = await subscribeToEvents({
			source,
			eventName: "proxyProgress",
			filter: (e) => e.assetId === "a1",
			isTerminal,
		});

		// This is the exact race this module exists to close: emit BEFORE the
		// consumer ever calls .next(), the way a very fast native transcode
		// could fire "done" before JS gets around to draining the generator.
		emit({ assetId: "a1", stage: "transcoding", fraction: 0.1 });
		emit({ assetId: "a1", stage: "transcoding", fraction: 0.9 });
		emit({ assetId: "a1", stage: "done", fraction: 1 });

		const first = await gen.next();
		const second = await gen.next();
		const third = await gen.next();

		expect(first.value?.fraction).toBe(0.1);
		expect(second.value?.fraction).toBe(0.9);
		expect(third.value?.stage).toBe("done");
	});

	test("yields events in order and stops after the terminal one", async () => {
		const { source, emit } = createFakeSource();
		const gen = await subscribeToEvents({
			source,
			eventName: "proxyProgress",
			filter: (e) => e.assetId === "a1",
			isTerminal,
		});

		const collected: FakeEvent[] = [];
		const consumePromise = (async () => {
			for await (const event of gen) {
				collected.push(event);
			}
		})();

		emit({ assetId: "a1", stage: "transcoding", fraction: 0.2 });
		emit({ assetId: "a1", stage: "transcoding", fraction: 0.6 });
		emit({ assetId: "a1", stage: "done", fraction: 1 });

		await consumePromise;
		expect(collected.map((e) => e.stage)).toEqual([
			"transcoding",
			"transcoding",
			"done",
		]);
		expect(collected[2]?.fraction).toBe(1);
	});

	test("ignores events for a different assetId", async () => {
		const { source, emit } = createFakeSource();
		const gen = await subscribeToEvents({
			source,
			eventName: "proxyProgress",
			filter: (e) => e.assetId === "target",
			isTerminal,
		});

		const collected: FakeEvent[] = [];
		const consumePromise = (async () => {
			for await (const event of gen) {
				collected.push(event);
			}
		})();

		emit({ assetId: "other", stage: "done", fraction: 1 });
		emit({ assetId: "target", stage: "done", fraction: 1 });

		await consumePromise;
		expect(collected).toHaveLength(1);
		expect(collected[0]?.assetId).toBe("target");
	});

	test("removes the listener once the generator finishes", async () => {
		const { source, emit, removed } = createFakeSource();
		const gen = await subscribeToEvents({
			source,
			eventName: "proxyProgress",
			filter: () => true,
			isTerminal,
		});

		const consumePromise = (async () => {
			for await (const _event of gen) {
				// drain
			}
		})();

		emit({ assetId: "a1", stage: "error", fraction: 1 });
		await consumePromise;

		expect(removed()).toBe(true);
	});

	test("an error-stage event is still yielded (not thrown) — the caller decides how to surface it", async () => {
		const { source, emit } = createFakeSource();
		const gen = await subscribeToEvents({
			source,
			eventName: "proxyProgress",
			filter: () => true,
			isTerminal,
		});

		emit({ assetId: "a1", stage: "error", fraction: 1 });
		const result = await gen.next();
		expect(result.value?.stage).toBe("error");

		const after = await gen.next();
		expect(after.done).toBe(true);
	});
});
