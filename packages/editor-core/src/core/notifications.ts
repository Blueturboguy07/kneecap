/**
 * Notification port for the headless engine.
 *
 * kneecap M2: the engine used to `import { toast } from "sonner"` directly,
 * which is a UI dependency (and, on mobile, the wrong presentation entirely —
 * CapCut surfaces these as native-styled toasts/sheets). The engine now emits
 * structured notifications through this port and the host installs a renderer.
 *
 * The default sink is `console`, so the engine stays usable headlessly (tests,
 * the golden-frame harness, a future native shell) with no host installed.
 */

export type NotificationLevel = "error" | "success" | "info" | "warning";

export interface NotificationOptions {
	description?: string;
	/** Milliseconds; host may ignore. */
	duration?: number;
	action?: {
		label: string;
		onClick: () => void;
	};
}

export interface Notification extends NotificationOptions {
	level: NotificationLevel;
	message: string;
}

export type Notifier = (notification: Notification) => void;

const consoleNotifier: Notifier = ({ level, message, description }) => {
	const line = description ? `${message}: ${description}` : message;
	if (level === "error") {
		console.error(`[kneecap] ${line}`);
		return;
	}
	if (level === "warning") {
		console.warn(`[kneecap] ${line}`);
		return;
	}
	console.info(`[kneecap] ${line}`);
};

let activeNotifier: Notifier = consoleNotifier;

/**
 * Install the host's notification renderer. Returns a disposer that restores
 * the previous notifier — handy for tests.
 */
export function setNotifier(notifier: Notifier): () => void {
	const previous = activeNotifier;
	activeNotifier = notifier;
	return () => {
		activeNotifier = previous;
	};
}

export function resetNotifier(): void {
	activeNotifier = consoleNotifier;
}

function emit(notification: Notification): void {
	activeNotifier(notification);
}

/**
 * The engine's notification API. Object params throughout, per this repo's
 * `opencut/prefer-object-params` lint rule — deliberately NOT sonner's
 * positional `toast.error(msg, opts)` signature, so a stray `import { toast }
 * from "sonner"` cannot silently keep type-checking. Only the four levels the
 * engine actually uses are exposed; rich/JSX toasts belong in the host.
 */
export const toast = {
	error(args: { message: string } & NotificationOptions): void {
		emit({ level: "error", ...args });
	},
	success(args: { message: string } & NotificationOptions): void {
		emit({ level: "success", ...args });
	},
	info(args: { message: string } & NotificationOptions): void {
		emit({ level: "info", ...args });
	},
	warning(args: { message: string } & NotificationOptions): void {
		emit({ level: "warning", ...args });
	},
};
