import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Same implementation as apps/web/src/utils/ui.ts's `cn`. Duplicated rather
 * than imported because packages/mobile-ui must type-check and lint fully
 * standalone (same rule editor-core and native-bridge already follow) — it
 * cannot reach back into apps/web/src.
 */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
