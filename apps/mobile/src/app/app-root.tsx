/**
 * The real kneecap mobile app: project list -> CapCut-parity editor
 * (`@kneecap/mobile-ui`'s `EditorShell`), driven by the singleton
 * `EditorCore` the same way apps/web's /projects page is.
 *
 * This file is the app-shell layer, so Capacitor-adjacent concerns
 * (routing, boot, native chrome) belong here — but note it still reaches
 * the engine only through `@kneecap/editor-core` and the UI only through
 * `@kneecap/mobile-ui`; the bridge-import gate's boundary (no Capacitor
 * imports inside packages/) is unaffected.
 *
 * Projects boot REAL: `editor.project.createNewProject`/`.loadProject`
 * runs to completion before `EditorShell` mounts, so the shell's
 * `getActive()` call always has a project, and its `bootstrap` prop gets a
 * stable no-op (module-level const — see the exhaustive-deps note on
 * EditorShell's own mount effect) instead of the dev-harness demo project.
 */
import "@kneecap/mobile-ui/tokens.css";
import "@kneecap/mobile-ui/components.css";
import "./app-root.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorCore } from "@kneecap/editor-core";
import { useEditor } from "@kneecap/editor-core/react";
import { EditorShell } from "@kneecap/mobile-ui";

const NOOP_BOOTSTRAP = async () => {};

type Screen = { name: "home" } | { name: "editor" };

function App() {
	const [screen, setScreen] = useState<Screen>({ name: "home" });

	if (screen.name === "editor") {
		return (
			<EditorShell
				bootstrap={NOOP_BOOTSTRAP}
				onBack={() => {
					// Fire-and-forget save: ProjectManager.saveCurrentProject persists
					// the active project; the home screen re-runs loadAllProjects on
					// mount, so the refreshed metadata (name/duration/updatedAt) shows
					// up without waiting here.
					void EditorCore.getInstance().project.saveCurrentProject();
					setScreen({ name: "home" });
				}}
			/>
		);
	}

	return <HomeScreen onOpenEditor={() => setScreen({ name: "editor" })} />;
}

function HomeScreen({ onOpenEditor }: { onOpenEditor: () => void }) {
	const editor = useEditor();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		// Run once per mount; `editor` is the process-wide singleton and never
		// changes identity, so omitting it from the deps array is safe (this
		// app's eslint scope doesn't load the react-hooks plugin, hence a plain
		// comment instead of a rule disable).
		void editor.project.loadAllProjects();
	}, []);

	const projects = editor.project.getSavedProjects();

	const run = async (task: () => Promise<unknown>) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await task();
			onOpenEditor();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="kc-home" data-kneecap-theme="capcut-mobile">
			<header className="kc-home__header">
				<h1>kneecap</h1>
				<button
					type="button"
					className="kc-home__new"
					disabled={busy}
					onClick={() => void run(() => editor.project.createNewProject({ name: nextProjectName(projects.map((p) => p.name)) }))}
				>
					+ New project
				</button>
			</header>
			{error && <p className="kc-home__error">{error}</p>}
			{projects.length === 0 ? (
				<p className="kc-home__empty">No projects yet — tap “New project” to start editing.</p>
			) : (
				<ul className="kc-home__list">
					{projects.map((p) => (
						<li key={p.id}>
							<button
								type="button"
								className="kc-home__item"
								disabled={busy}
								onClick={() => void run(() => editor.project.loadProject({ id: p.id }))}
							>
								{p.thumbnail ? (
									<img src={p.thumbnail} alt="" className="kc-home__thumb" />
								) : (
									<span className="kc-home__thumb kc-home__thumb--empty" />
								)}
								<span className="kc-home__meta">
									<span className="kc-home__name">{p.name}</span>
									<span className="kc-home__date">{new Date(p.updatedAt).toLocaleDateString()}</span>
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** "Project 1", "Project 2", ... skipping names already taken. */
function nextProjectName(existing: string[]): string {
	const taken = new Set(existing);
	let n = 1;
	while (taken.has(`Project ${n}`)) n += 1;
	return `Project ${n}`;
}

export function mountApp() {
	const container = document.getElementById("app");
	if (!container) throw new Error("app-root: #app container missing from index.html");
	container.innerHTML = "";
	createRoot(container).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
}
