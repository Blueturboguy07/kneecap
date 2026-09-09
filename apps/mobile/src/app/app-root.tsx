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
import { Component, StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
	EditorCore,
	mediaTimeToSeconds,
	registerNativeMediaPathResolver,
	registerNativeAudioRouter,
	type MediaTime,
} from "@kneecap/editor-core";
import { getNativeBridge } from "@kneecap/native-bridge";
import { loadFontAtlas, loadFonts } from "@kneecap/editor-core/fonts/local-fonts";
import { useEditor } from "@kneecap/editor-core/react";
import { EditorShell, ensurePreviewGpu } from "@kneecap/mobile-ui";

const NOOP_BOOTSTRAP = async () => {};

/** CRITICAL finding #3 of the 2026-08-18 test sweep: a throw during React
 *  render unmounted the entire root with ZERO console output and no visible
 *  surface — the app just went black (third instance of the silent-death
 *  class). Every crash must be loud: this boundary paints the error +
 *  component stack on screen and logs it. */
class CrashBoundary extends Component<
	{ children: ReactNode },
	{ error: unknown; stack: string | null }
> {
	state: { error: unknown; stack: string | null } = { error: null, stack: null };

	static getDerivedStateFromError(error: unknown) {
		return { error };
	}

	componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
		console.error("kneecap crashed:", error, info.componentStack);
		this.setState({ stack: info.componentStack ?? null });
	}

	render() {
		if (this.state.error !== null) {
			const err = this.state.error;
			const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			return (
				<div className="kc-crash">
					<p className="kc-crash__title">kneecap crashed</p>
					<pre className="kc-crash__detail">
						{detail}
						{this.state.stack ? `\n${this.state.stack}` : ""}
					</pre>
					<button
						type="button"
						className="kc-home__new"
						onClick={() => this.setState({ error: null, stack: null })}
					>
						Try again
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}

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
	// CRITICAL finding #2 of the 2026-08-18 test sweep ("saved projects never
	// appear"): this originally read `editor.project.getSavedProjects()`
	// during render off the BARE `useEditor()` above — whose snapshot is the
	// singleton itself, identical forever, so React never re-rendered when
	// `loadAllProjects` resolved and the list stayed on its mount-time empty
	// value while the engine genuinely held the projects (verified live:
	// engine 1 / DOM 0). A SELECTOR subscription re-renders on the manager's
	// array-replace notify.
	const projects = useEditor((e) => e.project.getSavedProjects());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		// Run once per mount; `editor` is the process-wide singleton and never
		// changes identity, so omitting it from the deps array is safe (this
		// app's eslint scope doesn't load the react-hooks plugin, hence a plain
		// comment instead of a rule disable).
		void editor.project.loadAllProjects();
	}, []);

	/** Runs an engine task with the busy/error plumbing. `open` decides
	 *  whether the editor is entered afterwards: creating/loading a project
	 *  does, deleting one must NOT (the row-era code routed Delete through
	 *  the same helper and landed in the editor with no active project). */
	const run = async (task: () => Promise<unknown>, { open }: { open: boolean }) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await task();
			if (open) onOpenEditor();
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
				<div className="kc-home__header-actions">
					<button
						type="button"
						className="kc-home__new"
						disabled={busy}
						onClick={() =>
							void run(
								() => editor.project.createNewProject({ name: nextProjectName(projects.map((p) => p.name)) }),
								{ open: true },
							)
						}
					>
						+ New project
					</button>
				</div>
			</header>
			{error && <p className="kc-home__error">{error}</p>}
			{projects.length === 0 ? (
				<p className="kc-home__empty">No projects yet — tap “New project” to start editing.</p>
			) : (
				<ul className="kc-home__grid">
					{projects.map((p) => (
						<ProjectCard
							key={p.id}
							name={p.name}
							thumbnail={p.thumbnail}
							duration={p.duration}
							updatedAt={p.updatedAt}
							disabled={busy}
							onOpen={() => void run(() => editor.project.loadProject({ id: p.id }), { open: true })}
							onDelete={() => {
								if (!window.confirm(`Delete “${p.name}”? This can’t be undone.`)) return;
								void run(() => editor.project.deleteProjects({ ids: [p.id] }), { open: false });
							}}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

/**
 * Thumbnail-first project card for the two-column home grid (2026-09-07,
 * founder: "make it thumbnail based not row based… 2 videos next to each
 * other"). The whole card is the open tap; the "⋯" chip in the thumbnail's
 * corner is a SIBLING of that button (a button inside a button is invalid
 * HTML and WebKit un-nests it) and is the delete affordance that replaced
 * round 21's swipe-to-delete — a swipe gesture has no natural home on a
 * grid cell, and swipe-left on a two-up grid fights horizontal wobble
 * while scrolling. Delete still confirms before calling the engine's
 * permanent `deleteProjects` (it removes the project AND its media custody).
 */
function ProjectCard({
	name,
	thumbnail,
	duration,
	updatedAt,
	disabled,
	onOpen,
	onDelete,
}: {
	name: string;
	thumbnail?: string;
	duration: MediaTime;
	updatedAt: Date | string;
	disabled: boolean;
	onOpen: () => void;
	onDelete: () => void;
}) {
	return (
		<li className="kc-home__card">
			<button type="button" className="kc-home__card-open" disabled={disabled} onClick={onOpen}>
				<span className="kc-home__thumb-frame">
					{thumbnail ? (
						<img src={thumbnail} alt="" className="kc-home__thumb" draggable={false} />
					) : (
						<span className="kc-home__thumb kc-home__thumb--empty" aria-hidden="true">
							<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6">
								<rect x="3" y="5" width="18" height="14" rx="2.5" />
								<path d="M10 9.5v5l4.5-2.5z" fill="currentColor" stroke="none" />
							</svg>
						</span>
					)}
					<span className="kc-home__duration">{formatDuration(duration)}</span>
				</span>
				<span className="kc-home__meta">
					<span className="kc-home__name">{name}</span>
					<span className="kc-home__date">{new Date(updatedAt).toLocaleDateString()}</span>
				</span>
			</button>
			<button
				type="button"
				className="kc-home__more"
				aria-label={`Delete ${name}`}
				disabled={disabled}
				onClick={onDelete}
			>
				⋯
			</button>
		</li>
	);
}

/** Project length as CapCut's project cards show it: `m:ss` under an
 *  hour, `h:mm:ss` past it. Metadata duration is in ticks. */
function formatDuration(duration: MediaTime): string {
	const total = Math.max(0, Math.floor(mediaTimeToSeconds({ time: duration })));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const ss = String(s).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
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
	// Debug handle for remote/Web-Inspector diagnosis (finding C2 of the
	// 2026-08-18 test sweep was undiagnosable without engine access from the
	// console). Read-only convenience; nothing in the app depends on it.
	(window as unknown as Record<string, unknown>).__kneecap = {
		editor: EditorCore.getInstance(),
	};
	// Boot-time runtime prep, mirroring apps/web's editor-provider ordering:
	// GPU first (the project-thumbnail snapshot path throws "GPU context not
	// initialized" if anything renders before this), font atlas alongside
	// (text renders with a fallback face without it). Both are cached
	// one-shot promises; PreviewRenderer awaits the same GPU promise.
	void ensurePreviewGpu().then(() => loadFontAtlas());
	// The DEFAULT face (Albert Sans, round 31) must be decoded before the
	// first text/caption render or canvas fillText falls back to the system
	// font for that frame — @font-face alone only loads on first CSS use,
	// which never happens for canvas-drawn text.
	void loadFonts({ families: ["Albert Sans"] });
	// Anchor persisted container-RELATIVE media paths to THIS install's
	// custody root before any project load needs them (iOS rotates the
	// container UUID every update/reinstall — media/native-paths.ts). Fire
	// and forget: a human can't reach a saved project before this settles,
	// and a failure just leaves the absolute-url fallback in effect.
	void getNativeBridge().then(async (bridge) => {
		const root = await bridge.getMediaRoot();
		if (root) {
			registerNativeMediaPathResolver({
				root,
				toPlaybackUri: bridge.toPlaybackUri,
			});
		}
		// Native preview-audio routing (2026-08-20): the device bisect proved
		// this webview's WebAudio output is silent while native audio works —
		// see editor-core media/native-audio-router.ts. The Capacitor file
		// marker reversal is the inverse of convertFileSrc's rewrite.
		registerNativeAudioRouter({
			start: (params) => bridge.audioStart(params),
			stop: () => bridge.audioStop(),
			level: () => bridge.audioLevel(),
			toNativePath: (url) => {
				const marker = "/_capacitor_file_";
				const index = url.indexOf(marker);
				return index === -1 ? null : url.slice(index + marker.length);
			},
		});
	});
	container.innerHTML = "";
	createRoot(container).render(
		<StrictMode>
			<CrashBoundary>
				<App />
			</CrashBoundary>
		</StrictMode>,
	);
}
