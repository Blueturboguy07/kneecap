/**
 * The publik gate's screens in the webview (the UI adapter of ./publik.ts).
 *
 * main.ts runs runPublik() before any screen of kneecap, the hidden
 * #/diagnostics and #/autotest routes included. With PUBLIK_GATE_MODE=required
 * a phone that is signed in passes without a screen; until then, the gate
 * shows. With PUBLIK_GATE_MODE=optional there is no screen here.
 * The words come from gateScreen() in ./publik.ts and are not changed here.
 */
import "./gate.css";
import { gateScreen, startPublik, type GateAction, type GateScreen, type GateUI } from "./publik";

/**
 * Draws one screen at a time into `container`. Each button resolves show() with its action.
 * `first`: a screen that shows at once, before the gate asks for a screen (after Sign out: the sign-in screen
 * while publik sets up the new key). A tap on it is kept: the gate's next screen with the same button takes
 * the tap at once (that screen does not show). Any other next screen drops the tap.
 */
export function domGateUI(container: HTMLElement, openUrl: (url: string) => void, first?: GateScreen): GateUI {
	/** The tap on the `first` screen, kept for the gate's next screen. */
	let early: GateAction | null = null;
	const ui: GateUI = {
		show(screen: GateScreen, signal: AbortSignal): Promise<GateAction> {
			return new Promise<GateAction>((resolve) => {
				const tapped = early;
				early = null;
				if (tapped && screen.buttons.some((b) => b.action === tapped)) {
					resolve(tapped);
					return;
				}
				const root = document.createElement("section");
				root.className = "kc-publik-gate";
				root.setAttribute("aria-labelledby", "kc-publik-gate-title");
				root.dataset.screen = screen.id;

				const panel = document.createElement("div");
				panel.className = "kc-publik-gate__panel";

				const title = document.createElement("h1");
				title.id = "kc-publik-gate-title";
				title.className = "kc-publik-gate__title";
				title.textContent = screen.title;

				const body = document.createElement("p");
				body.className = "kc-publik-gate__body";
				body.textContent = screen.body;

				const note = document.createElement("p");
				note.className = "kc-publik-gate__note";
				note.setAttribute("role", "status");
				note.textContent = screen.note ?? "";

				const actions = document.createElement("div");
				actions.className = "kc-publik-gate__actions";
				const buttons = screen.buttons.map((b, i) => {
					const button = document.createElement("button");
					button.type = "button";
					button.className = i === 0 ? "kc-publik-gate__button kc-publik-gate__button--primary" : "kc-publik-gate__button";
					button.textContent = b.label;
					button.addEventListener("click", () => {
						for (const other of buttons) other.disabled = true;
						resolve(b.action);
					});
					return button;
				});
				actions.append(...buttons);

				panel.append(title, body, note, actions);
				root.append(panel);
				if (!signal.aborted) container.replaceChildren(root);
			});
		},
		openUrl,
	};
	if (first) {
		void ui.show(first, new AbortController().signal).then((action) => {
			early = action;
		});
	}
	return ui;
}

/** The gate (required mode) or the background check (optional mode), then index.html's placeholder again: the app mounts next. */
export async function runPublik(): Promise<void> {
	const container = document.getElementById("app") ?? document.body;
	const { getPublikHost } = await import("@kneecap/native-bridge/publik-host");
	const host = getPublikHost();
	const ui = domGateUI(container, (url) => {
		host.openUrl({ url }).catch((err: unknown) => console.error("publik: could not open the sign-in page:", err));
	});
	await startPublik(ui, host);
	const loading = document.createElement("p");
	loading.textContent = "Loading…";
	container.replaceChildren(loading);
}

/**
 * Settings > Sign out with PUBLIK_GATE_MODE=required (blind test 1.0.7, item 5). Before 1.0.8 the app loaded
 * again after Sign out: index.html's blank "Loading…" showed for 2-3 s while the app started and publik set up
 * the new key. Now the sign-in screen shows at once, over the app, with no new load. The gate then runs as at
 * app start (ensureSignedIn); a tap on the first screen opens the publik page when the new key is there.
 * When the person is signed in again, the gate goes and the app (Settings) shows again.
 */
export async function showGateAfterSignOut(): Promise<void> {
	const app = document.getElementById("app");
	const layer = document.createElement("div");
	layer.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
	document.body.append(layer);
	// The app stays under the gate: no tap and no screen reader reaches it.
	app?.setAttribute("inert", "");
	let open: (url: string) => void = () => {};
	// At once, before anything waits: the sign-in screen (the words of gateScreen()).
	const ui = domGateUI(layer, (url) => open(url), gateScreen("sign_in", null));
	try {
		const { getPublikHost } = await import("@kneecap/native-bridge/publik-host");
		const host = getPublikHost();
		open = (url) => {
			host.openUrl({ url }).catch((err: unknown) => console.error("publik: could not open the sign-in page:", err));
		};
		await startPublik(ui, host);
	} catch (err) {
		// The gate stopped without a sign-in: start the app again, so the gate shows (the path before 1.0.8).
		console.error("publik: the gate after Sign out stopped:", err);
		window.location.reload();
		return;
	}
	layer.remove();
	app?.removeAttribute("inert");
}

/** kneecap's native first-run screen, once per install. main.ts calls it after runPublik(), so the gate comes first. */
export async function showFirstRun(): Promise<void> {
	const { getPublikHost } = await import("@kneecap/native-bridge/publik-host");
	await getPublikHost()
		.showFirstRun()
		.catch((err: unknown) => console.error("kneecap: the first-run screen did not open:", err));
}
