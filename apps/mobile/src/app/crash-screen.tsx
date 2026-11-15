/**
 * The crash screen of publik kneecap (blind test round 1, items 6 and 12).
 *
 * A render error anywhere under the app root shows this screen instead of a
 * blank page. It has a plain message, "Try again" (renders the app again)
 * and "Report" (opens https://publikhq.com/in-app/support in the in-app
 * sheet). It never shows the error text, a stack trace or a file path: the
 * error goes to the console only. The root element has the class "kc-crash"
 * and `data-kneecap-crash="1"`, so the simulator tests in CI can find it.
 *
 * main.ts shows the same words with plain DOM when the app cannot start
 * (React is not loaded then): see BOOT_FAILED_TITLE and CRASH_MESSAGE.
 */
import { getPublikHost } from "@kneecap/native-bridge/publik-host";
import { Component, type ReactNode } from "react";
import { SUPPORT_URL } from "../publik/publik";

export const CRASH_TITLE = "publik kneecap stopped working";
export const CRASH_MESSAGE =
	"Something went wrong on this screen. Your projects are safe on this phone. Tap Try again. If it happens again, tap Report and tell us what you did.";

/** Opens the support page in the in-app sheet. A failure to open is not shown: the screen stays. */
export function openSupport(): void {
	void getPublikHost()
		.openUrl({ url: SUPPORT_URL })
		.catch(() => {});
}

export function CrashScreen({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="kc-crash" data-kneecap-crash="1" role="alert">
			<p className="kc-crash__title">{CRASH_TITLE}</p>
			<p className="kc-crash__message">{CRASH_MESSAGE}</p>
			<div className="kc-crash__actions">
				<button type="button" className="kc-home__new kc-crash__button" onClick={onRetry}>
					Try again
				</button>
				<button type="button" className="kc-crash__button kc-crash__button--secondary" onClick={openSupport}>
					Report
				</button>
			</div>
		</div>
	);
}

export class CrashBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
		// The console only: the screen never shows the error, the stack or a path.
		console.error("publik kneecap stopped working:", error, info.componentStack);
	}

	render() {
		if (this.state.failed) return <CrashScreen onRetry={() => this.setState({ failed: false })} />;
		return this.props.children;
	}
}
