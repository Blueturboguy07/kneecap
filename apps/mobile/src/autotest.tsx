/**
 * kneecap `#/autotest` — headless-drivable end-to-end playback QA
 * (2026-08-19, added during the device-playback campaign).
 *
 * The one gap every automated gate shared was "no human tap": the CI/browser
 * harnesses never exercised native import → persistence → preview frames, so
 * device-only failures (zero-byte stub decode, container-UUID rotation)
 * survived four rounds of green builds. This route drives that exact loop
 * inside the REAL app with no UI interaction, so a simulator run (which has
 * no tap automation without host Accessibility permissions) can verify it:
 *
 *   1. The runner plants a real mp4 at `<mediaRoot>/Media/autotest-source.mp4`
 *      (`xcrun simctl get_app_container … data` + cp) and relaunches the app
 *      with `#/autotest` in the URL (see docs/STATUS.md round 5).
 *   2. IMPORT phase (no project named "Autotest" yet): create the project,
 *      run the REAL `importMediaFromNative` orchestration against the real
 *      bridge — only `pickMedia` is substituted, returning a handle for the
 *      planted file — and place the clip on the timeline like the "+" button
 *      does.
 *   3. REOPEN phase (an "Autotest" project already exists): load it from
 *      storage instead, exercising persistence + container-relative path
 *      re-anchoring (media/native-paths.ts).
 *   4. Both phases then mount the real EditorShell, wait for the preview
 *      canvas, press play, and sample rendered pixels off the wgpu output
 *      canvas. Every step logs `[autotest] …`; the terminal line is
 *      `[autotest] VERDICT phase=<import|reopen> <PASS|FAIL> …`, greppable
 *      from `simctl launch --console-pty`.
 *
 * Deliberately a sibling of `#/diagnostics`: reachable only by hash, inert
 * for real users, and honest about being QA chrome rather than product.
 */
// The SAME stylesheet set app-root.tsx loads — vite splits CSS per entry
// chunk, so without these the whole route rendered UNSTYLED: every earlier
// screenshot's degraded layout, and a timeline scroller stuck at
// overflow:visible (scrollLeft a no-op), were THIS harness's artifact, not
// the app's (2026-08-19).
import "@kneecap/mobile-ui/tokens.css";
import "@kneecap/mobile-ui/components.css";
import "./app/app-root.css";
import { createRoot } from "react-dom/client";
import {
	EditorCore,
	importMediaFromNative,
	registerNativeMediaPathResolver,
	mediaTimeFromSeconds,
	videoCache,
	type NativeMediaHandle,
	type NativeMediaSource,
} from "@kneecap/editor-core";
import { buildElementFromMedia } from "@kneecap/editor-core/timeline";
import { InsertElementCommand } from "@kneecap/editor-core/commands";
import { loadFontAtlas } from "@kneecap/editor-core/fonts/local-fonts";
import { EditorShell, ensurePreviewGpu } from "@kneecap/mobile-ui";
import { getNativeBridge } from "@kneecap/native-bridge";

const PROJECT_NAME = "Autotest";
const SOURCE_RELATIVE = "Media/autotest-source.mp4";

const log = (...args: unknown[]) => console.error("[autotest]", ...args);

/** Matches the clip the runner plants (ffmpeg testsrc2 1280x720@30, 6s,
 *  h264 + aac). generateProxy's native side probes the real file for
 *  everything that matters; these fields are the wire contract's metadata. */
function plantedHandle(root: string): NativeMediaHandle {
	const handle: NativeMediaHandle = {
		id: "autotest-src",
		uri: `${root}/${SOURCE_RELATIVE}`,
		kind: "video",
		fileName: "autotest-source.mp4",
		sizeBytes: 2_372_615,
		durationMicros: 6_000_000,
		width: 1280,
		height: 720,
		hasAudio: true,
		codec: "avc1",
		frameRate: { numerator: 30, denominator: 1 },
	};
	// rotationDegrees is not part of editor-core's structural handle subset,
	// but the real native generateProxy reads it off the wire handle dict
	// (pickMedia normally supplies it) — add it the way pickMedia would.
	return Object.assign({}, handle, { rotationDegrees: 0 });
}

/** The still the runner plants next to the video (regression coverage for
 *  the image-import path: images must NEVER reach the native video
 *  transcoder — found on device 2026-08-19, AVFoundation -11828). */
function plantedImageHandle(root: string): NativeMediaHandle {
	const handle: NativeMediaHandle = {
		id: "autotest-img",
		uri: `${root}/Media/autotest-image.jpeg`,
		kind: "image",
		fileName: "autotest-image.jpeg",
		sizeBytes: 100_000,
		durationMicros: 0,
		width: 1280,
		height: 720,
		hasAudio: false,
		codec: "jpeg",
		frameRate: null,
	};
	return Object.assign({}, handle, { rotationDegrees: 0 });
}

async function waitFor<T>(
	label: string,
	probe: () => T | null | undefined | false,
	timeoutMs = 20_000,
): Promise<T> {
	const start = Date.now();
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() - start > timeoutMs) {
			throw new Error(`timed out waiting for ${label}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

/** Fraction (0..1) of visibly lit pixels on the wgpu preview canvas. */
function sampleLitFraction(canvas: HTMLCanvasElement): number {
	const w = 64;
	const h = 64;
	const scratch = document.createElement("canvas");
	scratch.width = w;
	scratch.height = h;
	const ctx = scratch.getContext("2d");
	if (!ctx) return -1;
	ctx.drawImage(canvas, 0, 0, w, h);
	const { data } = ctx.getImageData(0, 0, w, h);
	let lit = 0;
	for (let i = 0; i < data.length; i += 4) {
		if (data[i] + data[i + 1] + data[i + 2] > 48) lit++;
	}
	return lit / (w * h);
}

async function runPhase({
	editor,
	phase,
	root,
}: {
	editor: EditorCore;
	phase: "import" | "reopen";
	root: string;
}): Promise<void> {
	const bridge = await getNativeBridge();

	if (phase === "reopen") {
		const saved = editor.project
			.getSavedProjects()
			.find((p) => p.name === PROJECT_NAME);
		if (!saved) throw new Error("reopen phase lost the Autotest project");
		await editor.project.loadProject({ id: saved.id });
		log("reopened project", saved.id);
		return;
	}

	await editor.project.createNewProject({ name: PROJECT_NAME });
	log("created project");

	// The REAL import orchestration; only the picker is substituted.
	const source: NativeMediaSource = {
		pickMedia: async (opts) => {
			// Exercise the pickProgress plumbing the way a real iCloud
			// download would drive it.
			opts.onProgress?.({ index: 0, total: 2, stage: "loading", fraction: 0.5 });
			opts.onProgress?.({ index: 0, total: 2, stage: "loaded", fraction: 1 });
			return [plantedHandle(root), plantedImageHandle(root)];
		},
		// The cast mirrors how the real flow types out: `actions.ts` passes
		// the bridge itself (method bivariance), while this explicit wrapper
		// is checked strictly — plantedHandle() DOES carry rotationDegrees.
		generateProxy: (params) =>
			bridge.generateProxy(
				params as Parameters<typeof bridge.generateProxy>[0],
			),
		toPlaybackUri: bridge.toPlaybackUri,
		getMediaRoot: () => bridge.getMediaRoot(),
	};
	const { imported, failed } = await importMediaFromNative({
		editor,
		projectId: editor.project.getActive().metadata.id,
		source,
		kinds: ["video", "image"],
		allowMultiple: true,
		onProgress: (p) =>
			log(`import ${p.fileName} ${p.stage} ${Math.round(p.fraction * 100)}%`),
	});
	if (failed.length > 0 || imported.length !== 2) {
		throw new Error(
			`import failed: imported=${imported.length} failed=${failed[0]?.error ?? "none"}`,
		);
	}
	for (const asset of imported) {
		log(
			`imported ${asset.type} url=${asset.url} rel=${asset.nativeRelativePath ?? "(none)"}`,
		);
		editor.command.execute({
			command: new InsertElementCommand({
				element: buildElementFromMedia({
					mediaId: asset.id,
					mediaType: asset.type,
					name: asset.name,
					// `||`: image imports probe duration 0 (same rule as
					// actions.ts importAndPlaceMedia).
					duration: mediaTimeFromSeconds({ seconds: asset.duration || 3 }),
					startTime: editor.playback.getCurrentTime(),
				}),
				placement: { mode: "auto", trackType: "video" },
			}),
		});
	}
	log("clips placed on timeline");
	await editor.project.saveCurrentProject();
	log("project saved");
}

async function driveAndSample({
	editor,
	phase,
}: {
	editor: EditorCore;
	phase: "import" | "reopen";
}): Promise<void> {
	const canvas = await waitFor(
		"preview canvas",
		() =>
			document.querySelector<HTMLCanvasElement>(
				".cc-preview-stage__render canvas",
			),
		// Generous: the canvas appears only after bootstrap, which includes
		// the REAL native transcode — a 4K60 source under the simulator's
		// software HEVC decode legitimately takes minutes (a 20s limit here
		// produced a false FAIL against a perfectly healthy app, 2026-08-19).
		240_000,
	);
	// Give the first render a beat, then confirm playback advances AND the
	// canvas shows real pixels.
	await new Promise((resolve) => setTimeout(resolve, 800));
	const timelineScroller =
		document.querySelector<HTMLElement>(".cc-timeline__scroll");
	const t0 = editor.playback.getCurrentTime();
	const scroll0 = timelineScroller?.scrollLeft ?? -1;
	editor.playback.play();
	await new Promise((resolve) => setTimeout(resolve, 1200));
	log(
		"mid-play:",
		JSON.stringify({
			engineT: String(editor.playback.getCurrentTime()),
			scrollLeft: timelineScroller?.scrollLeft ?? -1,
			scrollWidth: timelineScroller?.scrollWidth ?? -1,
			clientWidth: timelineScroller?.clientWidth ?? -1,
			overflowX: timelineScroller
				? getComputedStyle(timelineScroller).overflowX
				: "(none)",
			display: timelineScroller
				? getComputedStyle(timelineScroller).display
				: "(none)",
			label:
				document.querySelector(".cc-timeline__timecode, [class*='timecode']")
					?.textContent ?? "(no label node)",
		}),
	);
	const litA = sampleLitFraction(canvas);
	await new Promise((resolve) => setTimeout(resolve, 800));
	const litB = sampleLitFraction(canvas);
	const t1 = editor.playback.getCurrentTime();
	const scroll1 = timelineScroller?.scrollLeft ?? -1;
	const audio = editor.audio.getStats();

	// Selection + delete flow, via the REAL gesture path (pointerdown/up on
	// the clip node — plain click() does not select, per the M-sweep):
	// select the video clip, assert the contextual row's direct Delete
	// button appears, press it, assert the element left the track, undo.
	let selectOk = false;
	let selectDetail = "no video clip node";
	const clipNode = document.querySelector<HTMLElement>(
		".cc-timeline__clip--video",
	);
	if (clipNode) {
		const rect = clipNode.getBoundingClientRect();
		const pointerOpts = {
			bubbles: true,
			cancelable: true,
			pointerId: 7,
			pointerType: "touch",
			clientX: rect.left + rect.width / 2,
			clientY: rect.top + rect.height / 2,
		};
		clipNode.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
		clipNode.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
		await new Promise((resolve) => setTimeout(resolve, 400));
		const selectedCount = editor.selection.getSelectedElements().length;
		const deleteButton = [...document.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === "Delete",
		);
		if (selectedCount === 1 && deleteButton) {
			const mainBefore =
				editor.scenes.getActiveSceneOrNull()?.tracks.main.elements.length ?? -1;
			deleteButton.click();
			await new Promise((resolve) => setTimeout(resolve, 400));
			const mainAfter =
				editor.scenes.getActiveSceneOrNull()?.tracks.main.elements.length ?? -1;
			selectOk = mainAfter === mainBefore - 1;
			selectDetail = `sel=${selectedCount} delete ${mainBefore}->${mainAfter}`;
			// Restore the clip so later reopen phases still have media to play.
			editor.command.undo();
			await new Promise((resolve) => setTimeout(resolve, 200));
		} else {
			selectDetail = `sel=${selectedCount} deleteBtn=${Boolean(deleteButton)}`;
		}
	}
	// Bisect the audio-sink hang: same asset URL, (a) mediabunny audio
	// demux over UrlSource (the hanging production path), (b) over a
	// whole-file Blob (transport removed). TIMEOUT on (a) + ok on (b)
	// convicts UrlSource-based audio demux; TIMEOUT on both convicts the
	// demux/decode itself.
	const videoAsset = editor.media.getAssets().find((a) => a.type === "video");
	if (videoAsset?.url) {
		const { Input, ALL_FORMATS, UrlSource, BlobSource } = await import("mediabunny");
		const race = (p: Promise<unknown>) =>
			Promise.race([
				p.then((v) => (v ? "ok" : "null")),
				new Promise<string>((r) => setTimeout(() => r("TIMEOUT"), 4000)),
			]).catch((e) => `THREW ${e instanceof Error ? e.message : String(e)}`);
		const urlInput = new Input({
			source: new UrlSource(videoAsset.url),
			formats: ALL_FORMATS,
		});
		log("audio-probe url:", await race(urlInput.getPrimaryAudioTrack()));
		const bytes = await fetch(videoAsset.url).then((r) => r.arrayBuffer());
		const blobInput = new Input({
			source: new BlobSource(new Blob([bytes])),
			formats: ALL_FORMATS,
		});
		log("audio-probe blob:", await race(blobInput.getPrimaryAudioTrack()));
	}
	const dbgTracks = editor.scenes.getActiveSceneOrNull()?.tracks;
	log(
		"audio-debug elements:",
		JSON.stringify(
			dbgTracks?.main.elements.map((e) => {
				const el = e as unknown as Record<string, unknown>;
				return {
					type: el.type,
					mediaId: el.mediaId,
					muted: el.muted,
					sourceType: el.sourceType,
				};
			}),
		),
		"assets:",
		JSON.stringify(
			editor.media
				.getAssets()
				.map((a) => ({ type: a.type, hasAudio: a.hasAudio, name: a.name })),
		),
	);
	editor.playback.pause();

	const advanced = t1 > t0;
	const stats = videoCache.getStats();
	// Font-chunk decode probe: image-FORMAT support must be measured
	// in-app, not assumed — the atlas shipped as AVIF variants iOS could
	// not decode, then as lossless WebP iOS ALSO refused (err=-50), and
	// neither showed up in any console this harness captured (the decode
	// errors live in the WebContent process). Image.decode() is the same
	// path the real font picker uses.
	const fontsOk = await new Promise<boolean>((resolve) => {
		const probe = new Image();
		probe.onload = () => resolve(probe.naturalWidth > 0);
		probe.onerror = () => resolve(false);
		probe.src = "/fonts/font-chunk-0.png";
		setTimeout(() => resolve(false), 5000);
	});
	// WebKit clears WebGPU canvases after present, so drawImage readback is
	// legitimately blank (verified 2026-08-19: lit=0.000 while a simulator
	// screenshot showed the video playing). `lit` is advisory only; the
	// binding in-page evidence is: the clock advanced AND the video cache
	// actually decoded frames for an active sink. The RUNNER additionally
	// captures a `simctl io … screenshot` for pixel-level ground truth.
	const decoded = stats.totalSinks > 0 && stats.cachedFrames > 0;
	const lit = Math.max(litA, litB);
	// Audio: speakers can't be heard headlessly; the in-page evidence is a
	// RUNNING AudioContext with opened sinks and zero failures (the test
	// clip has an audio track). Timeline follow: the strip must have
	// scrolled while the clock ran (CapCut fixed-playhead model — the strip
	// IS the tracking).
	const audioOk =
		audio.contextState === "running" &&
		audio.failedSinks === 0 &&
		audio.activeSinks + audio.decodedBuffers > 0;
	const timelineOk = scroll0 >= 0 && scroll1 > scroll0;
	const pass = advanced && decoded && fontsOk && audioOk && timelineOk && selectOk;
	log(
		`VERDICT phase=${phase} ${pass ? "PASS" : "FAIL"} advanced=${advanced} sinks=${stats.totalSinks} decodedFrames=${stats.cachedFrames} fonts=${fontsOk ? "ok" : "FAIL"} audio=${audioOk ? "ok" : `FAIL(${audio.contextState},clips=${audio.scheduledClips},active=${audio.activeClips},sinks=${audio.activeSinks},failed=${audio.failedSinks},buffers=${audio.decodedBuffers})`} timeline=${timelineOk ? `ok(${scroll0}->${scroll1}px)` : `FAIL(${scroll0}->${scroll1}px)`} select=${selectOk ? `ok(${selectDetail})` : `FAIL(${selectDetail})`} lit=${lit.toFixed(3)} (t ${String(t0)} -> ${String(t1)})`,
	);
}

export async function mountAutotest(): Promise<void> {
	const container = document.getElementById("app");
	if (!container) throw new Error("autotest: #app container missing");

	const editor = EditorCore.getInstance();
	(window as unknown as Record<string, unknown>).__kneecap = { editor };

	void ensurePreviewGpu().then(() => loadFontAtlas());

	const bridge = await getNativeBridge();
	const root = await bridge.getMediaRoot();
	if (!root) {
		log("VERDICT phase=none FAIL no media root (web platform or old native build)");
		return;
	}
	registerNativeMediaPathResolver({ root, toPlaybackUri: bridge.toPlaybackUri });
	log("media root", root);

	await editor.project.loadAllProjects();
	const phase: "import" | "reopen" = editor.project
		.getSavedProjects()
		.some((p) => p.name === PROJECT_NAME)
		? "reopen"
		: "import";
	log("phase:", phase);

	const bootstrap = async () => {
		try {
			await runPhase({ editor, phase, root });
		} catch (err) {
			log(
				`VERDICT phase=${phase} FAIL bootstrap: ${err instanceof Error ? err.message : String(err)}`,
			);
			throw err;
		}
	};

	container.innerHTML = "";
	createRoot(container).render(<EditorShell bootstrap={bootstrap} />);

	driveAndSample({ editor, phase }).catch((err) => {
		log(
			`VERDICT phase=${phase} FAIL drive: ${err instanceof Error ? err.message : String(err)}`,
		);
	});
}
