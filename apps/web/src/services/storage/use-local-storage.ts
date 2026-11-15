import { useState, useEffect, useCallback, useRef } from "react";

export function useLocalStorage<T>({
	key,
	defaultValue,
}: {
	key: string;
	defaultValue: T;
}): [
	T,
	({ value }: { value: T | ((previousValue: T) => T) }) => void,
	boolean,
] {
	const [value, setValue] = useState<T>(defaultValue);
	const [isReady, setIsReady] = useState(false);
	const valueRef = useRef(defaultValue);

	// avoid hydration mismatch by reading after mount
	useEffect(() => {
		try {
			const storedValue = localStorage.getItem(key);
			if (storedValue !== null) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- this hook wrote the value with JSON.stringify under the same key.
				const parsedValue = JSON.parse(storedValue) as T;
				valueRef.current = parsedValue;
				// eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage exists only after mount; reading it here avoids a hydration mismatch.
				setValue(parsedValue);
			}
		} catch {
			// localstorage might be unavailable
		}
		setIsReady(true);
	}, [key]);

	// sync to localstorage after hydration
	useEffect(() => {
		if (!isReady) return;

		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {
			// localstorage might be full or disabled
		}
	}, [key, value, isReady]);

	const setValueWithCallback = useCallback(
		({ value: nextValue }: { value: T | ((previousValue: T) => T) }) => {
			const resolvedValue =
				typeof nextValue === "function"
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the hook's contract treats any function value as an updater, as React's setState does.
					? (nextValue as (previousValue: T) => T)(valueRef.current)
					: nextValue;

			valueRef.current = resolvedValue;
			setValue(resolvedValue);
		},
		[],
	);

	return [value, setValueWithCallback, isReady];
}
