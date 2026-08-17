import { useEffect, useRef, useState } from "react";

/**
 * Minimal ResizeObserver-backed size hook. Duplicated (not imported) from
 * the equivalent apps/web/src/hooks/use-container-size.ts for the same
 * standalone-package reason as lib/cn.ts and timeline/haptics.ts.
 */
export function useElementSize<T extends HTMLElement>(): {
	ref: React.RefObject<T | null>;
	width: number;
	height: number;
} {
	const ref = useRef<T | null>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });

	useEffect(() => {
		const node = ref.current;
		if (!node || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			setSize({
				width: entry.contentRect.width,
				height: entry.contentRect.height,
			});
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	return { ref, width: size.width, height: size.height };
}
