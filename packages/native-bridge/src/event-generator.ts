/**
 * Bridges a Capacitor plugin's push-style `addListener(event, cb)` events
 * into a pull-style `AsyncGenerator`, for native methods whose TS contract
 * is streaming (`generateProxy`, and M10's `transcribe`) but whose native
 * implementation can only resolve a `CAPPluginCall` promise once (plan M4
 * handoff: Capacitor promise calls resolve exactly once, so streaming
 * progress has to ride the separate, well-established
 * `notifyListeners`/`addListener` event mechanism instead — see the doc
 * comment on `pluginMethods` in
 * `apps/mobile/ios/App/App/NativeBridgePlugin.swift`).
 *
 * Pure and DOM-free — unlike `capacitor-bridge.ts` itself, this is directly
 * unit-testable under `bun test` with a fake listener source.
 */

export interface ListenerHandle {
	remove(): void | Promise<void>;
}

export interface ListenerSource<T> {
	addListener(
		eventName: string,
		callback: (data: T) => void,
	): ListenerHandle | Promise<ListenerHandle>;
}

/** Returns `true` once `event` should be the LAST value the generator
 * yields (e.g. a terminal `"done"` / `"error"` stage). */
export type IsTerminal<T> = (event: T) => boolean;

/**
 * Registers the listener and returns an `AsyncGenerator` that drains it.
 *
 * Deliberately `async` (not itself `async function*`): an `async
 * function*`'s body — including an `addListener` call at its top — does not
 * run until the caller's first `.next()`/`for await`, which would leave a
 * window between "caller thinks it's listening" and "listener is actually
 * registered." Splitting registration (this function, awaited) from
 * draining (the `AsyncGenerator` it returns) means the listener is
 * guaranteed live once this promise resolves — callers subscribe FIRST,
 * *then* trigger the native call that will emit into it, so a
 * faster-than-expected native completion can never fire its terminal event
 * into a not-yet-registered listener.
 *
 * Backpressure-safe: events that arrive before the consumer calls
 * `.next()` again are queued, not dropped.
 */
export async function subscribeToEvents<T>({
	source,
	eventName,
	filter,
	isTerminal,
}: {
	source: ListenerSource<T>;
	eventName: string;
	filter: (event: T) => boolean;
	isTerminal: IsTerminal<T>;
}): Promise<AsyncGenerator<T>> {
	const queue: T[] = [];
	const waiters: Array<(event: T) => void> = [];

	const handle = await source.addListener(eventName, (event: T) => {
		if (!filter(event)) return;
		const waiter = waiters.shift();
		if (waiter) {
			waiter(event);
		} else {
			queue.push(event);
		}
	});

	async function* drain(): AsyncGenerator<T> {
		let finished = false;
		try {
			while (!finished) {
				const event =
					queue.length > 0
						? queue.shift()!
						: await new Promise<T>((resolve) => waiters.push(resolve));
				finished = isTerminal(event);
				yield event;
			}
		} finally {
			await handle.remove();
		}
	}

	return drain();
}
