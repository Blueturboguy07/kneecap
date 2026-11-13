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
import { startPublik, type GateAction, type GateScreen, type GateUI } from "./publik";

/** Draws one screen at a time into `container`. Each button resolves show() with its action. */
export function domGateUI(container: HTMLElement, openUrl: (url: string) => void): GateUI {
	return {
		show(screen: GateScreen, signal: AbortSignal): Promise<GateAction> {
			return new Promise<GateAction>((resolve) => {
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

/** kneecap's native first-run screen, once per install. main.ts calls it after runPublik(), so the gate comes first. */
export async function showFirstRun(): Promise<void> {
	const { getPublikHost } = await import("@kneecap/native-bridge/publik-host");
	await getPublikHost()
		.showFirstRun()
		.catch((err: unknown) => console.error("kneecap: the first-run screen did not open:", err));
}
