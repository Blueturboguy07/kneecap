/**
 * The real kneecap mobile app: project list -> the mobile editor
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
import { Component, StrictMode, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
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
import { closeEditorProject, projectHasElements, waitForCloseWork } from "./close-project";
import { CrashBoundary } from "./crash-screen";
import { SettingsScreen } from "./settings-screen";

const NOOP_BOOTSTRAP = async () => {};


/** "closing": the editor is off the screen and closeEditorProject (close-project.ts)
 *  runs; Home shows when it ends. */
type Screen = { name: "home" } | { name: "editor" } | { name: "closing" } | { name: "settings" };

/** Catches an error in the editor screen, logs it, and calls `onError` so
 *  the app goes back to the project list instead of the crash screen. */
class EditorErrorGuard extends Component<
	{ onError: (error: unknown) => void; children: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
		console.error("kneecap editor failed:", error, info.componentStack);
		this.props.onError(error);
	}

	render() {
		return this.state.failed ? null : this.props.children;
	}
}

function App() {
	const [screen, setScreen] = useState<Screen>({ name: "home" });
	/** Shown on the home screen after the editor failed. */
	const [editorError, setEditorError] = useState<string | null>(null);
	/** True from the first close tap until Home shows: a second tap does nothing. */
	const closingRef = useRef(false);
	/** The open project had an element (or its state was not known) when the editor
	 *  opened. Such a project is never deleted on close (item 10: only a project that
	 *  never got content is deleted). */
	const hadContentAtOpenRef = useRef(true);

	/**
	 * Blind test round 3, item 10: every way out of the editor runs closeEditorProject
	 * (close-project.ts). A project that never got content (empty when the editor opened
	 * and empty now) is deleted; any other project gets its thumbnail and is saved. The editor is off the screen first (so
	 * nothing in it reads the deleted project), and Home shows only when the work ends (so
	 * the home grid never loads an empty card or a card without its new thumbnail).
	 */
	const leaveEditor = ({ afterError }: { afterError: boolean }) => {
		if (closingRef.current) return;
		closingRef.current = true;
		const hadContentAtOpen = hadContentAtOpenRef.current;
		void closeEditorProject({ editor: EditorCore.getInstance(), afterError, hadContentAtOpen }).finally(() => {
			closingRef.current = false;
			setScreen({ name: "home" });
		});
	};

	if (screen.name === "editor") {
		return (
			<EditorErrorGuard
				onError={(error) => {
					// EditorErrorGuard already logged the error. The home screen shows
					// plain words only: no error text, stack or file path (blind test 1.0.4).
					void error;
					setEditorError(
						"The editor had a problem and closed. Try again. If it happens again, open Settings > Help and support.",
					);
					// The guard shows nothing now, so the editor is already off the screen.
					setScreen({ name: "closing" });
					leaveEditor({ afterError: true });
				}}
			>
				<EditorShell
					bootstrap={NOOP_BOOTSTRAP}
					onBack={() => {
						if (closingRef.current) return;
						// Take the editor off the screen now (flushSync), before the close
						// work changes or deletes the project.
						flushSync(() => setScreen({ name: "closing" }));
						leaveEditor({ afterError: false });
					}}
				/>
			</EditorErrorGuard>
		);
	}

	if (screen.name === "closing") {
		return (
			<div className="kc-closing" data-kneecap-theme="kneecap-mobile">
				<div className="kc-home__loading" role="progressbar" aria-label="Closing the project" />
			</div>
		);
	}

	if (screen.name === "settings") {
		return <SettingsScreen onBack={() => setScreen({ name: "home" })} />;
	}

	return (
		<HomeScreen
			initialError={editorError}
			onOpenEditor={() => {
				// The project is loaded now (HomeScreen's run awaits the task first).
				hadContentAtOpenRef.current = projectHasElements({ editor: EditorCore.getInstance() }) !== false;
				setEditorError(null);
				setScreen({ name: "editor" });
			}}
			onOpenSettings={() => setScreen({ name: "settings" })}
		/>
	);
}

function HomeScreen({
	initialError,
	onOpenEditor,
	onOpenSettings,
}: {
	initialError: string | null;
	onOpenEditor: () => void;
	onOpenSettings: () => void;
}) {
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
	// Blind test round 2, item 7: the list is empty until loadAllProjects (below) has read
	// storage, which takes about 2 s after sign-in. "No projects yet" shows only after that
	// first load finished with zero projects; before it, the home shows a quiet loading state.
	const listLoaded = useEditor((e) => e.project.getIsInitialized());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(initialError);

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
			// A thumbnail of the last close that took longer than its time limit must
			// land on its own project, not on the one this task opens.
			await waitForCloseWork();
			await task();
			if (open) onOpenEditor();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="kc-home" data-kneecap-theme="kneecap-mobile">
			<header className="kc-home__header">
				{/* The short name, like the home-screen label: "publik kneecap" does not fit next to the
				    two buttons on a 375-402 pt wide iPhone, and the header keeps its look. The long name is
				    on the first-run screen and in Settings > About. */}
				<h1>kneecap</h1>
				<div className="kc-home__header-actions">
					<button type="button" className="kc-home__settings" disabled={busy} onClick={onOpenSettings}>
						Settings
					</button>
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
			{projects.length === 0 && !listLoaded ? (
				<div className="kc-home__loading" role="progressbar" aria-label="Loading projects" />
			) : projects.length === 0 ? (
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
	// Blind test round 3, item 10: a thumbnail that does not load shows the neutral
	// placeholder below, not an empty box.
	const [failedThumbnail, setFailedThumbnail] = useState<string | null>(null);
	const showThumbnail = Boolean(thumbnail) && failedThumbnail !== thumbnail;
	return (
		<li className="kc-home__card">
			<button type="button" className="kc-home__card-open" disabled={disabled} onClick={onOpen}>
				<span className="kc-home__thumb-frame">
					{showThumbnail ? (
						<img
							src={thumbnail}
							alt=""
							className="kc-home__thumb"
							draggable={false}
							onError={() => setFailedThumbnail(thumbnail ?? null)}
						/>
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

/** Project length as the project cards show it: `m:ss` under an
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

/** A software keyboard covers at least this much; a smaller difference between the screen
 *  and the visible area is not a keyboard. */
const KEYBOARD_MIN_PX = 120;

/**
 * Blind test round 2, item 5: with the keyboard open (Text panel), iOS pushed the whole page
 * up to show the text field, and the top bar and the preview went under the status bar. The
 * app has no Keyboard plugin, so the web view keeps the full screen height and iOS moves the
 * page instead. This keeps the page at the top, and it tells the CSS how much of the screen
 * the keyboard covers: `--cc-keyboard-inset` and `data-cc-keyboard="open"` on the root
 * element. components.css then puts the open sheet (where all text fields are) on the
 * keyboard. The app is a fixed full-screen surface (app-root.css), so a page scroll is never
 * wanted.
 */
function keepPageAtTopWithKeyboard(): void {
	const viewport = window.visualViewport;
	if (!viewport) return;
	const root = document.documentElement;
	let appliedInset = -1;
	const update = () => {
		// A pinch zoom also makes the visible area smaller: not a keyboard, and not a page scroll to undo.
		if (viewport.scale > 1.01) return;
		// The root's clientHeight is the full screen; the keyboard does not change it on iOS.
		const covered = Math.round(root.clientHeight - viewport.height);
		const inset = covered >= KEYBOARD_MIN_PX ? covered : 0;
		if (inset !== appliedInset) {
			appliedInset = inset;
			root.style.setProperty("--cc-keyboard-inset", `${inset}px`);
			if (inset > 0) root.dataset.ccKeyboard = "open";
			else delete root.dataset.ccKeyboard;
		}
		if (Math.abs(window.scrollY) >= 1 || Math.abs(viewport.offsetTop) >= 1) window.scrollTo(0, 0);
	};
	viewport.addEventListener("resize", update);
	viewport.addEventListener("scroll", update);
	window.addEventListener("scroll", update);
	update();
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
	// Boot-time runtime prep. The GPU start runs inside editor-core, in the
	// same wasm copy as the compositor; it never rejects and has a time
	// limit, and the renderer draws with Canvas 2D when there is no GPU.
	// PreviewRenderer waits for the same cached promise. The font atlas is
	// only a fetch, so it does not wait for the GPU.
	void ensurePreviewGpu();
	void loadFontAtlas();
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
	keepPageAtTopWithKeyboard();
	container.innerHTML = "";
	createRoot(container).render(
		<StrictMode>
			<CrashBoundary>
				<App />
			</CrashBoundary>
		</StrictMode>,
	);
}
