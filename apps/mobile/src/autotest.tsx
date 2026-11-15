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
 *
 * Editor CI mode (bottom of this file): when the runner also plants
 * `editor-ci-phase1.flag` or `editor-ci-phase2.flag`, this route mounts the
 * real app (app/app-root.tsx) and drives it with clicks for the CI editor
 * test (scripts/ios-sim-editor-test.py, mobile-ci.yml).
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
	registerNativeAudioRouter,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	videoCache,
	type MediaTime,
	type NativeMediaHandle,
	type NativeMediaSource,
} from "@kneecap/editor-core";
import { buildElementFromMedia, buildTextElement } from "@kneecap/editor-core/timeline";
import {
	InsertElementCommand,
	UpdateElementsCommand,
	UpdateProjectSettingsCommand,
} from "@kneecap/editor-core/commands";
import { loadFontAtlas } from "@kneecap/editor-core/fonts/local-fonts";
import { EditorShell, ensurePreviewGpu, getAllCaptions } from "@kneecap/mobile-ui";
import {
	getNativeBridge,
	type ExportProgress,
	type MediaHandle,
	type NativeBridge,
} from "@kneecap/native-bridge";

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

/** The audio file the runner plants next to the video (regression coverage
 *  for round 22's Files-picker audio import: proxy-less kinds take the
 *  proxy-IS-the-source rule, get placed on an AUDIO track, and must join
 *  the NATIVE preview mix — a clip the router can't map used to silently
 *  kill the entire native session, i.e. ALL audio, on the device where
 *  WebAudio renders silently; founder report 2026-08-20). */
function plantedAudioHandle(root: string): NativeMediaHandle {
	const handle: NativeMediaHandle = {
		id: "autotest-audio",
		uri: `${root}/Media/autotest-audio.m4a`,
		kind: "audio",
		fileName: "autotest-audio.m4a",
		sizeBytes: 36_000,
		durationMicros: 4_000_000,
		width: 0,
		height: 0,
		hasAudio: true,
		codec: "m4a",
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
			opts.onProgress?.({ index: 0, total: 3, stage: "loading", fraction: 0.5 });
			opts.onProgress?.({ index: 0, total: 3, stage: "loaded", fraction: 1 });
			return [plantedHandle(root), plantedImageHandle(root), plantedAudioHandle(root)];
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
		kinds: ["video", "image", "audio"],
		allowMultiple: true,
		onProgress: (p) =>
			log(`import ${p.fileName} ${p.stage} ${Math.round(p.fraction * 100)}%`),
	});
	if (failed.length > 0 || imported.length !== 3) {
		throw new Error(
			`import failed: imported=${imported.length} failed=${failed[0]?.error ?? "none"}`,
		);
	}
	// The image is placed AFTER the video so it lands on the MAIN track
	// (auto placement at an occupied time would push it to an overlay) —
	// regression coverage for the -11828 "Cannot Open" export failure: a
	// main-track JPEG fed to AVURLAsset killed every export containing a
	// photo (founder's device, 2026-08-23; stills now composite build-time).
	let mainCursorSec = 0;
	for (const asset of imported) {
		log(
			`imported ${asset.type} url=${asset.url} rel=${asset.nativeRelativePath ?? "(none)"}`,
		);
		// `||`: image imports probe duration 0 (same rule as actions.ts).
		const durationSec = asset.duration || 3;
		const isVisual = asset.type !== "audio";
		editor.command.execute({
			command: new InsertElementCommand({
				element: buildElementFromMedia({
					mediaId: asset.id,
					mediaType: asset.type,
					name: asset.name,
					duration: mediaTimeFromSeconds({ seconds: durationSec }),
					// The AUDIO clip deliberately OVERHANGS the main track's end
					// (round 32 regression coverage): a composition whose
					// instructions stop before its full duration is rejected
					// with AVErrorInvalidVideoComposition (-11841) — the
					// founder's export died on 2026-08-23. Starting it 1s before
					// the last visual clip ends leaves a real uncovered tail.
					startTime: isVisual
						? mediaTimeFromSeconds({ seconds: mainCursorSec })
						: mediaTimeFromSeconds({ seconds: Math.max(0, mainCursorSec - 1) }),
				}),
				// Same per-kind routing as actions.ts: audio files land on an
				// audio track (importAndPlaceAudio), visual media on video.
				placement: {
					mode: "auto",
					trackType: asset.type === "audio" ? "audio" : "video",
				},
			}),
		});
		if (isVisual) mainCursorSec += durationSec;
	}
	// A TEXT overlay with KNOWN params, for the round-33 golden-frame check
	// (founder: exported text "shrank to fuck" vs the preview, captions'
	// borders "out of control"). fontSize 15 must render at
	// 15 × canvasHeight/90 = 120px on a 720-tall canvas, and the 2%-of-font
	// border at ~2.4px total. The runner measures both off a real exported
	// frame with ffmpeg.
	editor.command.execute({
		command: new InsertElementCommand({
			element: buildTextElement({
				raw: {
					name: "autotest-text",
					duration: mediaTimeFromSeconds({ seconds: 2 }),
					params: {
						// Two lines + a trailing caption underneath: round 34
					// regression coverage for "line breaks are not registering
					// in export" and "captions must layer on top of text".
					content: "HH\nHH",
						fontSize: 15,
						color: "#ffffff",
						strokeColor: "#000000",
						strokeWidth: 2,
						fontWeight: "bold",
						// PINCH-SCALED (round 36 regression coverage): the
						// preview rasterizes glyphs from vectors at the scaled
						// size, so the export must too — rasterizing at 1× and
						// letting the compositor resample produced the soft,
						// thin text on every scaled overlay. At 1.5× the
						// exported stem must still measure the font's true
						// weight (16.2px × 1.5 ≈ 24px), not a blurred 1× raster.
						"transform.scaleX": 1.5,
						"transform.scaleY": 1.5,
					},
				},
				// Over the BLACK tail (past the last video clip) so the
				// exported glyph "ink" can be measured exactly against the
				// preview's — see the fontprobe ink log below.
				startTime: mediaTimeFromSeconds({ seconds: 9.5 }),
			}),
			placement: { mode: "newTrack", trackType: "text" },
		}),
	});
	log("text overlay placed (fontSize 15, border 2%)");

	// AUDIO AT +20 dB / 1000% (round 39 regression coverage): the volume
	// slider reaches 1000%, and an unlimited encode turns the resulting
	// over-full-scale sum into hard clipping — "audio rips when i do 1000x".
	// The runner measures the exported waveform for flat-topped (clipped)
	// samples; a limited mix has none.
	{
		const scene = editor.scenes.getActiveScene();
		const audioTrack = scene.tracks.audio[0];
		const audioElement = audioTrack?.elements[0];
		if (audioTrack && audioElement) {
			editor.command.execute({
				command: new UpdateElementsCommand({
					updates: [
						{
							trackId: audioTrack.id,
							elementId: audioElement.id,
							patch: { params: { ...audioElement.params, volume: 20 } },
						},
					],
				}),
			});
			log("audio boosted to +20 dB (1000%) for the limiter check");
		}
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
	// Sound: sample the master-bus RMS while playing — "sinks opened" is not
	// "audio flows" (founder heard silence while all open/decode stats
	// passed, 2026-08-19). Non-zero RMS proves signal up to the speaker
	// driver, the furthest a headless run can hear.
	let rmsMax = 0;
	for (let i = 0; i < 8; i++) {
		rmsMax = Math.max(rmsMax, await editor.audio.getOutputLevel());
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
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
	// scrolled while the clock ran (fixed-playhead model — the strip
	// IS the tracking).
	// nativeSkippedClips must be 0: a clip the router can't map is silent
	// for the whole session (see audio-manager's tryStartNativeRoute) — the
	// planted AUDIO file import (round 22) rides this exact path.
	const audioOk = audio.routedNatively
		? audio.failedSinks === 0 && audio.nativeSkippedClips === 0
		: audio.contextState === "running" &&
			audio.failedSinks === 0 &&
			audio.activeSinks + audio.decodedBuffers > 0;
	// FONT PROBE (round 36): measure what the APP'S OWN preview canvas draws
	// — same face, size and weight the text overlay uses — so it can be
	// compared numerically against the exported frame. The WebGPU preview
	// canvas can't be read back (WebKit clears it post-present), but text
	// reaches it through a 2D context, so an offscreen 2D canvas is the
	// faithful stand-in. Albert Sans Bold at 120px measures cap 84px /
	// stem 16.2px in the font's own outlines.
	try {
		const fontsApi = document.fonts;
		await fontsApi.load('bold 120px "Albert Sans"');
		await fontsApi.load('120px "Albert Sans"');
		const probe = document.createElement("canvas");
		probe.width = 900;
		probe.height = 300;
		const pctx = probe.getContext("2d", { willReadFrequently: true });
		if (pctx) {
			pctx.fillStyle = "#000";
			pctx.fillRect(0, 0, 900, 300);
			pctx.font = 'normal bold 120px "Albert Sans", sans-serif';
			pctx.fillStyle = "#fff";
			pctx.textAlign = "center";
			pctx.textBaseline = "middle";
			pctx.fillText("HH", 450, 150);
			const data = pctx.getImageData(0, 0, 900, 300).data;
			const isW = (x: number, y: number) => data[(y * 900 + x) * 4] > 200;
			const rows: number[] = [];
			for (let y = 0; y < 300; y++) {
				for (let x = 0; x < 900; x += 2) {
					if (isW(x, y)) { rows.push(y); break; }
				}
			}
			if (rows.length > 0) {
				const top = Math.min(...rows);
				const bottom = Math.max(...rows);
				const sampleY = top + Math.round((bottom - top) * 0.25);
				const stems: number[] = [];
				let run = 0;
				for (let x = 0; x < 900; x++) {
					if (isW(x, sampleY)) run++;
					else { if (run > 0) stems.push(run); run = 0; }
				}
				// INK = summed luminance / 255 over the glyph box: the
				// perceptual "how much of the letter is painted" measure,
				// independent of any threshold. The export is measured the
				// same way off a frame where the text sits on black.
				let ink = 0;
				for (let i = 0; i < data.length; i += 4) ink += data[i] / 255;
				log(
					`fontprobe check(bold)=${fontsApi.check('bold 120px "Albert Sans"')} ` +
						`check(regular)=${fontsApi.check('120px "Albert Sans"')} ` +
						`capHeight=${bottom - top + 1}px stems=${JSON.stringify(stems)} ` +
						`ink=${ink.toFixed(0)} (font outlines: cap 84px, stem 16.2px)`,
				);
			}
		}
	} catch (error) {
		log("fontprobe failed:", error);
	}

	// CAPTIONS (round 30): whole-timeline transcription. The planted VIDEO's
	// audio is a pure sine tone (no speech); the planted AUDIO-track clip is
	// real synthesized SPEECH — so any caption appearing at all proves the
	// generator processed beyond the main track's first clip (the old
	// single-clip behavior returned "No speech was detected" on exactly this
	// timeline shape — the founder's screenshot, 2026-08-23). Runs the REAL
	// on-device recognizer (iOS 26 SpeechAnalyzer / SFSpeech fallback).
	let captionsOk = false;
	let captionsDetail = "not-run";
	try {
		const { generateCaptions, getAllCaptions } = await import("@kneecap/mobile-ui");
		// Generous: the first run may download a locale model (iOS), and
		// whisper.cpp on an emulated arm64 CPU (Android) runs several times
		// slower than on real silicon — 240s was enough for the device but
		// flaked on the emulator.
		const timeoutMs = 420_000;
		const result = await Promise.race([
			generateCaptions({ editor, stylePresetId: "simple" }),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`captions timed out after ${timeoutMs}ms`)), timeoutMs),
			),
		]);
		const captions = getAllCaptions({ editor });
		const words = captions
			.flatMap(({ element }) => element.words.map((w) => w.text))
			.join(" ");
		captionsOk = result !== null && captions.length > 0;
		captionsDetail = captionsOk
			? `ok(${captions.length} pages, "${words.slice(0, 60)}")`
			: "generated null / zero captions";
	} catch (error) {
		captionsDetail = error instanceof Error ? error.message : String(error);
	}

	// EXPORT: build the real EDL with the native asset resolver, drive the
	// native exporter, then verify the output file has bytes AND a decodable
	// video track — the founder-device failure was "asset could not be
	// resolved to a readable URL" (missing source-path persistence,
	// 2026-08-20).
	let exportOk = false;
	let exportDetail = "not-run";
	try {
		{
			// Export-resolution ground truth (the grainy-export hunt,
			// 2026-08-22): the EDL exports at the project canvas — print it.
			const settings = editor.project.getActive().settings;
			log(
				`canvas=${settings.canvasSize.width}x${settings.canvasSize.height} mode=${settings.canvasSizeMode ?? "(unset)"}`,
			);
		}
		const { buildEdl } = await import("@kneecap/editor-core/edl");
		const { toEdlMediaAssets, buildNativeEdlAssetResolver } = await import(
			"@kneecap/mobile-ui"
		);
		const bridge = await getNativeBridge();
		const edl = buildEdl({
			project: editor.project.getActive(),
			scene: editor.scenes.getActiveScene(),
			mediaAssets: toEdlMediaAssets({ assets: editor.media.getAssets() }),
			resolveAsset: buildNativeEdlAssetResolver(),
			output: {
				container: "mp4",
				videoCodec: "h264",
				audioCodec: "aac",
				bitrate: 8_000_000,
				includeAudio: true,
			},
		});
		let outputUri: string | null = null;
		// Round 37: text/captions rendered by the PREVIEW's own code and
		// handed to the exporter, so the exported overlay layer IS the
		// editor's drawing.
		const { renderOverlayFrames } = await import(
			"@kneecap/editor-core/export/overlay-frames"
		);
		const overlayFrames = await renderOverlayFrames({
			tracks: editor.scenes.getActiveScene().tracks,
			mediaAssets: editor.media.getAssets(),
			canvasSize: {
				width: edl.output.resolution.width,
				height: edl.output.resolution.height,
			},
			fps: edl.output.fps,
			durationTicks: edl.meta.durationTicks,
			ticksPerSecond: edl.meta.ticksPerSecond,
		});
		log(`overlay frames prerendered: ${overlayFrames.length}`);
		for await (const p of bridge.exportProject({ edl, overlayFrames })) {
			if (p.stage === "error") throw new Error(p.error ?? "export error");
			if (p.stage === "done") outputUri = p.outputUri ?? null;
		}
		if (!outputUri) throw new Error("export finished without an outputUri");
		// exportProject's outputUri is ALREADY a converted playback URL (the
		// bridge maps it through toPlaybackUri) — converting again produced a
		// double-marker dead URL (caught by this assertion's own detail log).
		const outputUrl = outputUri;
		let bytes: ArrayBuffer | null = null;
		let lastFetchError = "";
		// A just-finalized file can race the scheme handler's first read —
		// retry briefly before declaring the output unreadable.
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				bytes = await fetch(outputUrl).then((r) => r.arrayBuffer());
				break;
			} catch (e) {
				lastFetchError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
		if (!bytes) {
			throw new Error(`output fetch failed (${lastFetchError}) url=${outputUrl}`);
		}
		if (bytes.byteLength < 10_000) {
			throw new Error(`suspiciously small output (${bytes.byteLength}B)`);
		}
		const { Input, ALL_FORMATS, BlobSource } = await import("mediabunny");
		const probe = new Input({
			source: new BlobSource(new Blob([bytes])),
			formats: ALL_FORMATS,
		});
		const track = await probe.getPrimaryVideoTrack();
		if (!track) throw new Error("output has no video track");
		exportOk = true;
		exportDetail = `${Math.round(bytes.byteLength / 1024)}KB`;
	} catch (error) {
		exportDetail = error instanceof Error ? error.message : String(error);
	}

	const timelineOk = scroll0 >= 0 && scroll1 > scroll0;
	const soundOk = rmsMax > 0.0005;
	const pass =
		advanced && decoded && fontsOk && audioOk && timelineOk && selectOk && soundOk && exportOk && captionsOk;
	log(
		`VERDICT phase=${phase} ${pass ? "PASS" : "FAIL"} advanced=${advanced} sinks=${stats.totalSinks} decodedFrames=${stats.cachedFrames} fonts=${fontsOk ? "ok" : "FAIL"} audio=${audioOk ? `ok(${audio.routedNatively ? "native" : "web"})` : `FAIL(${audio.contextState},routed=${audio.routedNatively},clips=${audio.scheduledClips},active=${audio.activeClips},sinks=${audio.activeSinks},failed=${audio.failedSinks},buffers=${audio.decodedBuffers})`} timeline=${timelineOk ? `ok(${scroll0}->${scroll1}px)` : `FAIL(${scroll0}->${scroll1}px)`} select=${selectOk ? `ok(${selectDetail})` : `FAIL(${selectDetail})`} export=${exportOk ? `ok(${exportDetail})` : `FAIL(${exportDetail})`} captions=${captionsOk ? captionsDetail : `FAIL(${captionsDetail})`} sound=${soundOk ? `ok(rms=${rmsMax.toFixed(4)})` : `FAIL(rms=${rmsMax.toFixed(4)},queued=${audio.queuedSources},AudioDecoder=${typeof (globalThis as { AudioDecoder?: unknown }).AudioDecoder !== "undefined"})`} lit=${lit.toFixed(3)} (t ${String(t0)} -> ${String(t1)})`,
	);
}

export async function mountAutotest(): Promise<void> {
	// The CI editor test has its own mode. Check it first: it must not run
	// the setup below (ensurePreviewGpu etc.), because it tests the app's own.
	const ci = await editorCiPhase();
	if (ci) {
		await mountEditorCi(ci);
		return;
	}

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
	log("media root", root);

	// Opt-in device-profile mode: a runner-planted `<root>/autotest-fallback.flag`
	// deletes WebCodecs AudioDecoder so the WebAudio remux fallback (the path
	// older-WebKit iPhones take) is what gets exercised and asserted. This
	// caught two real bugs on 2026-08-19: decodeAudioData rejecting movie
	// containers, and readPlayableBytes throwing on Capacitor's status-0
	// media responses.
	try {
		const flag = await fetch(
			bridge.toPlaybackUri(`file://${root}/autotest-fallback.flag`),
		);
		if (flag.ok || flag.status === 0) {
			delete (globalThis as { AudioDecoder?: unknown }).AudioDecoder;
			log("device-profile mode: AudioDecoder removed — fallback path under test");
		}
	} catch {
		// No flag — native WebCodecs path runs (the simulator default).
	}

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

// ======================= Editor CI test (mobile-ci.yml) =======================
// scripts/ios-sim-editor-test.py plants autotest.flag plus
// editor-ci-phase1.flag (first launch) or editor-ci-phase2.flag (after a
// relaunch), and a photo at Media/ci-photo.jpg. This mode mounts the REAL app
// (app/app-root.tsx) and drives it with clicks, like a person:
//   A. phase 1: New project, back, reopen, back, reopen, back.
//      phase 2 (app relaunched): reopen, back, reopen. 5 editor opens.
//   B. the preview: empty, then with a text element (the text sheet's
//      "Add text"), then with a photo (the timeline "+"; only the OS photo
//      picker is replaced, it returns the planted photo).
//   D. (phase 2, after B) every Stickers tab and its images, one sticker on
//      the timeline, one bundled sound on the timeline (and its file loads).
//      Both inserts are undone after the checks, so C exports photo + text.
//   C. export through the export sheet at 1080p, 30 fps, High: the TIMELINE
//      line gives the latest end over all tracks (the file must last that
//      long), the EXPORT SHEET line gives what the sheet shows at the end.
//   E. phase 3 (relaunch, editor-ci-phase3.flag): a NEW project with the
//      planted video (Media/ci-video.mp4, through the real native proxy):
//      preview, Captions "Generate", Split, Duplicate, Delete, Mute, Import
//      audio (Media/ci-audio.m4a), then an export with video and sound.
// Every line starts with "[editor-ci]". The app reports facts; the runner
// judges. For each SHOT line the runner takes a simulator screenshot and then
// writes <mediaRoot>/ci-ack-<name>.

type CiStep = "boot" | "A" | "B" | "C" | "D" | "E";

interface CiPlace {
	bridge: NativeBridge;
	root: string;
}

interface CiContext extends CiPlace {
	phase: 1 | 2 | 3;
	step: CiStep;
	/** Uncaught errors, crash logs and GPU errors seen so far. */
	problems: number;
	gpuProblems: number;
}

const CI_PHOTO = "Media/ci-photo.jpg";
/** The runner's test video: H.264 1280x720, 30 fps, 4 s, with an AAC tone. */
const CI_VIDEO = "Media/ci-video.mp4";
const CI_VIDEO_SECONDS = 4;
/** The runner's test audio file for "Import audio": AAC, 3 s tone. */
const CI_AUDIO = "Media/ci-audio.m4a";
const CI_AUDIO_SECONDS = 3;
const CI_TEXT = "New text";
const CI_GPU_ERROR = /GPU context not initialized/i;

const ciSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One line per message, so the runner can read it. */
function ciLog(message: string): void {
	console.log(`[editor-ci] ${message.replace(/\s*\n\s*/g, " | ").slice(0, 900)}`);
}

function ciDescribe(value: unknown): string {
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

async function ciFileExists(place: CiPlace, relative: string): Promise<boolean> {
	try {
		const res = await fetch(place.bridge.toPlaybackUri(`file://${place.root}/${relative}`), {
			cache: "no-store",
		});
		return res.ok || res.status === 0;
	} catch {
		return false;
	}
}

/** The phase the runner asks for, or null when this is not a CI editor test. */
async function editorCiPhase(): Promise<(CiPlace & { phase: 1 | 2 | 3 }) | null> {
	const bridge = await getNativeBridge();
	const root = await bridge.getMediaRoot();
	if (!root) return null;
	const place = { bridge, root };
	if (await ciFileExists(place, "editor-ci-phase3.flag")) return { ...place, phase: 3 };
	if (await ciFileExists(place, "editor-ci-phase2.flag")) return { ...place, phase: 2 };
	if (await ciFileExists(place, "editor-ci-phase1.flag")) return { ...place, phase: 1 };
	return null;
}

/** The crash screen as text, or null. app-root.tsx (or its crash-screen
 *  file) marks it with class kc-crash / data-kneecap-crash; main.ts shows
 *  "failed to start" when boot dies. */
function ciCrashText(): string | null {
	const screen = document.querySelector<HTMLElement>("[data-kneecap-crash], .kc-crash");
	if (screen) return (screen.textContent ?? "").trim().slice(0, 300) || "(empty crash screen)";
	const body = document.body.textContent ?? "";
	return /kneecap crashed|publik kneecap stopped|failed to start|GPU context not initialized/i.test(body)
		? body.trim().slice(0, 300)
		: null;
}

/** Reports uncaught errors, crash logs and the GPU error as PROBLEM lines. */
function ciWatchProblems(ctx: CiContext): void {
	const report = (kind: string, text: string) => {
		if (/ResizeObserver loop/i.test(text)) return;
		if (kind === "gpu") ctx.gpuProblems++;
		if (kind !== "render") ctx.problems++;
		ciLog(`PROBLEM step=${ctx.step} kind=${kind} ${text.slice(0, 400)}`);
	};
	window.addEventListener("error", (event) =>
		report(CI_GPU_ERROR.test(event.message) ? "gpu" : "uncaught", event.message || ciDescribe(event.error)),
	);
	window.addEventListener("unhandledrejection", (event) => {
		const text = ciDescribe(event.reason);
		report(CI_GPU_ERROR.test(text) ? "gpu" : "unhandled-rejection", text);
	});
	for (const level of ["error", "warn"] as const) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			original(...args);
			const text = args.map(ciDescribe).join(" ");
			if (CI_GPU_ERROR.test(text)) report("gpu", text);
			else if (/kneecap crashed|stopped working|kneecap editor failed/i.test(text)) report("crash", text);
			else if (/preview render failed/i.test(text)) report("render", text);
			else if (/GPU renderer unavailable/i.test(text)) ciLog(`INFO step=${ctx.step} ${text.slice(0, 300)}`);
		};
	}
}

/** Waits for `probe`. Throws on time-out, and (by default) at once when the crash screen shows. */
async function ciWait<T>(
	label: string,
	probe: () => T | null | undefined | false,
	timeoutMs: number,
	failOnCrash = true,
): Promise<T> {
	const start = Date.now();
	for (;;) {
		if (failOnCrash) {
			const crash = ciCrashText();
			if (crash) throw new Error(`crash screen: ${crash}`);
		}
		const value = probe();
		if (value) return value;
		if (Date.now() - start > timeoutMs) {
			throw new Error(`no ${label} after ${Math.round(timeoutMs / 1000)} s`);
		}
		await ciSleep(150);
	}
}

function ciButton(scope: ParentNode, text: RegExp): HTMLButtonElement | null {
	for (const button of scope.querySelectorAll<HTMLButtonElement>("button")) {
		if (!button.disabled && text.test((button.textContent ?? "").trim())) return button;
	}
	return null;
}

/** Logs the SHOT line, then waits for the runner's screenshot (ack file). */
async function ciShot(ctx: CiContext, name: string): Promise<void> {
	const stage = document.querySelector<HTMLElement>(".cc-preview-stage__canvas");
	const r = stage?.getBoundingClientRect();
	const rect =
		r && r.width > 0 && r.height > 0
			? [r.left, r.top, r.width, r.height].map((v) => v.toFixed(1)).join(",")
			: "none";
	const out = document.querySelector<HTMLCanvasElement>(".cc-preview-stage__render canvas");
	let lit = "n/a";
	if (out) {
		try {
			lit = sampleLitFraction(out).toFixed(3); // advisory: WebKit may clear a WebGPU canvas
		} catch {
			lit = "error";
		}
	}
	// The preview backend, for the log only (true: no GPU, the 2D fallback).
	const renderer = (EditorCore.getInstance() as unknown as { renderer?: { isDegraded?: unknown } }).renderer;
	let degraded: unknown = renderer?.isDegraded;
	try {
		if (typeof degraded === "function") degraded = (degraded as () => unknown).call(renderer);
	} catch {
		degraded = "error";
	}
	// Every canvas in the preview mount, for the log only (a swap from the GPU
	// canvas to the Canvas 2D canvas must leave exactly one).
	const all = [...document.querySelectorAll<HTMLCanvasElement>(".cc-preview-stage__render canvas")].map((c) => {
		try {
			return `${c.width}x${c.height}:${sampleLitFraction(c).toFixed(3)}`;
		} catch {
			return `${c.width}x${c.height}:error`;
		}
	});
	ciLog(
		`SHOT name=${name} rect=${rect} viewport=${window.innerWidth}x${window.innerHeight} ` +
			`dpr=${window.devicePixelRatio} canvas=${out ? `${out.width}x${out.height}` : "none"} canvasLit=${lit} ` +
			`degraded=${String(degraded)} canvases=[${all.join(",")}]`,
	);
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (await ciFileExists(ctx, `ci-ack-${name}`)) return;
		await ciSleep(300);
	}
	ciLog(`SHOT name=${name} NOACK`);
}

/** Saved project names, read the way the home screen reads them. */
async function ciProjects(editor: EditorCore, when: string): Promise<string[]> {
	await editor.project.loadAllProjects();
	const names = editor.project.getSavedProjects().map((p) => p.name);
	ciLog(`PROJECTS when=${when} count=${names.length} names=${JSON.stringify(names)}`);
	return names;
}

function ciProjectCard(name: string): HTMLButtonElement | null {
	for (const card of document.querySelectorAll<HTMLElement>(".kc-home__card")) {
		if ((card.querySelector(".kc-home__name")?.textContent ?? "").trim() !== name) continue;
		const open = card.querySelector<HTMLButtonElement>(".kc-home__card-open");
		return open && !open.disabled ? open : null;
	}
	return null;
}

/** Element counts by type over every track of the active scene. */
function ciCounts(editor: EditorCore): Record<string, number> {
	const counts: Record<string, number> = {};
	const visit = (value: unknown, depth: number): void => {
		if (depth > 3 || value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}
		const elements = (value as { elements?: unknown }).elements;
		if (Array.isArray(elements)) {
			for (const element of elements) {
				const type = String((element as { type?: unknown } | null)?.type ?? "unknown");
				counts[type] = (counts[type] ?? 0) + 1;
			}
			return;
		}
		for (const item of Object.values(value)) visit(item, depth + 1);
	};
	visit(editor.scenes.getActiveSceneOrNull()?.tracks, 0);
	return counts;
}

/** True when the editor is on screen and its preview has a size. Throws when
 *  the home screen shows a message instead (the editor's error guard closed
 *  the editor: "The editor had a problem and closed"). */
function ciEditorMounted(): boolean {
	const homeError = document.querySelector(".kc-home__error")?.textContent?.trim();
	if (homeError) throw new Error(`back on the home screen: ${homeError.slice(0, 200)}`);
	const canvas = document.querySelector<HTMLElement>(".cc-editor-shell .cc-preview-stage__canvas");
	const r = canvas?.getBoundingClientRect();
	return Boolean(r && r.width > 0 && r.height > 0);
}

function ciMainCount(editor: EditorCore): number {
	return editor.scenes.getActiveSceneOrNull()?.tracks.main.elements.length ?? 0;
}

async function ciBack(editor: EditorCore, when: string): Promise<void> {
	const close = await ciWait(
		"Close project button",
		() => document.querySelector<HTMLButtonElement>('button[aria-label="Close project"]'),
		10_000,
	);
	close.click();
	await ciWait("home screen", () => document.querySelector(".kc-home"), 20_000);
	await ciSleep(1500); // onBack saves the project without waiting (app-root.tsx)
	await ciProjects(editor, when);
}

/** After a failed open: leave the crash screen (its button) or the editor, back to home. */
async function ciRecover(): Promise<void> {
	document
		.querySelector<HTMLElement>("[data-kneecap-crash], .kc-crash")
		?.querySelector<HTMLButtonElement>("button")
		?.click();
	await ciSleep(800);
	document.querySelector<HTMLButtonElement>('button[aria-label="Close project"]')?.click();
	await ciWait("home screen", () => document.querySelector(".kc-home"), 15_000, false).catch(() => undefined);
}

/** One editor open (test A). True when the editor opened and stayed healthy for 3 s. */
async function ciOpen(
	ctx: CiContext,
	editor: EditorCore,
	n: number,
	kind: "new" | "reopen",
	name: string | null,
	options: { stay?: boolean; extra?: boolean } = {},
): Promise<boolean> {
	const tag = `OPEN n=${n} kind=${kind}${options.extra ? " extra=1" : ""}`;
	const started = Date.now();
	const problemsBefore = ctx.problems;
	const gpuBefore = ctx.gpuProblems;
	try {
		await ciWait("home screen", () => document.querySelector(".kc-home"), 60_000);
		const target =
			kind === "new"
				? await ciWait(
						"New project button",
						() => ciButton(document.querySelector(".kc-home__header") ?? document, /New project/i),
						20_000,
					)
				: await ciWait(`project card "${name ?? "(none)"}"`, () => (name ? ciProjectCard(name) : null), 20_000);
		target.click();
		await ciSleep(300); // the click clears an old home-screen message first
		await ciWait("editor", () => ciEditorMounted(), 60_000);
		await ciWait("preview renderer", () => ciEditorMounted() && document.querySelector(".cc-preview-stage__render"), 60_000);
		// A crash screen, a GPU error or the editor guard closing the editor
		// can come a moment after the first frame.
		const holdEnd = Date.now() + 3000;
		await ciWait(
			"3 s hold",
			() => {
				if (!ciEditorMounted()) throw new Error("the editor closed during the 3 s hold");
				return Date.now() >= holdEnd;
			},
			10_000,
		);
		if (ctx.gpuProblems > gpuBefore) throw new Error("GPU context not initialized (see PROBLEM line)");
		if (ctx.problems > problemsBefore) throw new Error("uncaught error or crash log (see PROBLEM line)");
		ciLog(`${tag} PASS ms=${Date.now() - started}`);
		await ciShot(ctx, `open-${n}`);
		if (!options.stay) await ciBack(editor, `after-open-${n}`);
		return true;
	} catch (error) {
		ciLog(`${tag} FAIL ${ciDescribe(error)}`);
		await ciShot(ctx, `fail-open-${n}`);
		await ciRecover();
		if (!options.stay) await ciProjects(editor, `after-open-${n}`).catch(() => undefined);
		return false;
	}
}

/** Stable preview for a screenshot: no sheet, no selection, paused at 0 s. */
async function ciSettle(editor: EditorCore, holdMs = 2500): Promise<void> {
	document.querySelector<HTMLElement>(".cc-sheet-scrim")?.click();
	editor.playback.pause();
	editor.selection.setSelectedElements({ elements: [] });
	editor.playback.seek({ time: mediaTimeFromSeconds({ seconds: 0 }) });
	await ciWait(
		"closed sheets and progress overlays",
		() => !document.querySelector('.cc-sheet, [class*="progress-overlay"]'),
		60_000,
	).catch(() => undefined);
	await ciSleep(holdMs);
}

/** The text sheet's "Add text" (the same insert as TextPanel's button). */
async function ciAddText(editor: EditorCore): Promise<"ui" | "direct"> {
	const before = ciCounts(editor).text ?? 0;
	const added = () => (ciCounts(editor).text ?? 0) > before;
	document.querySelector<HTMLButtonElement>('button[aria-label="Add text"]')?.click();
	const add = await ciWait("Add text in the text sheet", () => ciButton(document.querySelector(".cc-sheet") ?? document.createElement("div"), /^Add text$/), 10_000).catch(() => null);
	if (add) {
		add.click();
		const ok = await ciWait("text element", added, 10_000).catch(() => false);
		document.querySelector<HTMLElement>(".cc-sheet-scrim")?.click();
		if (ok) return "ui";
	}
	document.querySelector<HTMLElement>(".cc-sheet-scrim")?.click();
	if (added()) return "ui";
	// Fallback (the sheet changed): the same element TextPanel's button inserts.
	editor.command.execute({
		command: new InsertElementCommand({
			element: buildTextElement({ raw: { params: { content: CI_TEXT } }, startTime: editor.playback.getCurrentTime() }),
			placement: { mode: "auto", trackType: "text" },
		}),
	});
	return "direct";
}

/** The timeline "+" with the OS picker replaced: it returns the planted photo,
 *  with the handle NativeBridgePlugin+Media.swift builds for a picked image. */
async function ciAddPhoto(ctx: CiContext, editor: EditorCore): Promise<{ ok: boolean; via: string; detail: string }> {
	const { bridge, root } = ctx;
	const uri = `${root}/${CI_PHOTO}`;
	let sizeBytes = 0;
	try {
		const res = await fetch(bridge.toPlaybackUri(`file://${uri}`), { cache: "no-store" });
		sizeBytes = (await res.blob()).size;
	} catch {
		// sizeBytes stays 0; the import below reports the real failure
	}
	if (sizeBytes === 0) return { ok: false, via: "none", detail: `the planted photo ${CI_PHOTO} is missing or empty` };
	const handle: MediaHandle = {
		id: crypto.randomUUID().toUpperCase(),
		uri,
		kind: "image",
		fileName: CI_PHOTO.slice(CI_PHOTO.lastIndexOf("/") + 1),
		sizeBytes,
		durationMicros: 0,
		width: 0,
		height: 0,
		rotationDegrees: 0,
		hasAudio: false,
		codec: "jpg",
		frameRate: null,
	};
	const originalPick = bridge.pickMedia;
	bridge.pickMedia = async (opts) => {
		ciLog(`pickMedia stand-in: kinds=${opts.kinds.join(",")} -> ${handle.fileName} (${sizeBytes} bytes)`);
		opts.onProgress?.({ index: 0, total: 1, stage: "loading", fraction: 0 });
		opts.onProgress?.({ index: 0, total: 1, stage: "loaded", fraction: 1 });
		return [handle];
	};
	const before = ciMainCount(editor);
	let via = "ui";
	try {
		const plus = document.querySelector<HTMLButtonElement>('button[aria-label="Add clip"]');
		if (plus) {
			plus.click();
		} else {
			// Fallback (the button changed): the same steps as importAndPlaceMedia (actions.ts).
			via = "direct";
			const { imported } = await importMediaFromNative({
				editor,
				projectId: editor.project.getActive().metadata.id,
				source: bridge,
				kinds: ["video", "image"],
				allowMultiple: true,
			});
			for (const asset of imported) {
				editor.command.execute({
					command: new InsertElementCommand({
						element: buildElementFromMedia({
							mediaId: asset.id,
							mediaType: asset.type,
							name: asset.name,
							duration: mediaTimeFromSeconds({ seconds: asset.duration || 3 }),
							startTime: editor.playback.getCurrentTime(),
						}),
						placement: { mode: "auto", trackType: "video" },
					}),
				});
			}
		}
		const outcome = await ciWait(
			"photo on the main track",
			() => {
				if (ciMainCount(editor) > before) return "placed";
				const error = document
					.querySelector(".cc-chrome-error:not(.cc-chrome-error--notice)")
					?.textContent?.trim();
				return error ? `error: ${error}` : null;
			},
			90_000,
		);
		const asset = editor.media.getAssets().find((a) => a.type === "image");
		const detail = `${outcome} asset=${asset ? `${asset.type} ${asset.width ?? "?"}x${asset.height ?? "?"}` : "none"} timeline=${JSON.stringify(ciCounts(editor))}`;
		return { ok: outcome === "placed", via, detail };
	} catch (error) {
		return { ok: false, via, detail: ciDescribe(error) };
	} finally {
		bridge.pickMedia = originalPick;
	}
}

async function ciPreview(ctx: CiContext, editor: EditorCore): Promise<void> {
	await ciSettle(editor);
	await ciShot(ctx, "empty");

	const textVia = await ciAddText(editor);
	const texts = ciCounts(editor).text ?? 0;
	ciLog(`TEXT ${texts > 0 ? "PASS" : "FAIL"} via=${textVia} timeline=${JSON.stringify(ciCounts(editor))}`);
	await ciSettle(editor);
	await ciShot(ctx, "text");

	const photo = await ciAddPhoto(ctx, editor);
	ciLog(`IMPORT ${photo.ok ? "PASS" : "FAIL"} via=${photo.via} ${photo.detail}`);
	await ciSettle(editor, 4000);
	await ciClipCheck();
	await ciShot(ctx, "photo");
}

/**
 * Blind test item 11: the photo clip on the timeline shows the photo. Logs
 * "CLIP kind=image thumbs=N thumbHeight=H clipHeight=H image=WxH|error|...
 * rect=x,y,w,h": the filmstrip slots, the first slot's height, the clip's
 * height, the slot image (loaded again here), and the clip's on-screen rect.
 * The runner checks the numbers and looks for the photo's colours inside
 * that rect on the "photo" screenshot.
 */
async function ciClipCheck(): Promise<void> {
	const clip = document.querySelector<HTMLElement>(".cc-timeline__clip--image");
	if (!clip) {
		ciLog("CLIP kind=image none (no photo clip on the timeline)");
		return;
	}
	const thumbs = [...clip.querySelectorAll<HTMLElement>(".cc-timeline__clip-thumbnail")];
	const first = thumbs[0];
	const url = first ? /url\(["']?(.*?)["']?\)/.exec(getComputedStyle(first).backgroundImage)?.[1] : undefined;
	let image = "no-url";
	if (url) {
		image = await new Promise<string>((resolve) => {
			const probe = new Image();
			const timer = setTimeout(() => resolve("timeout"), 10_000);
			probe.onload = () => {
				clearTimeout(timer);
				resolve(`${probe.naturalWidth}x${probe.naturalHeight}`);
			};
			probe.onerror = () => {
				clearTimeout(timer);
				resolve("error");
			};
			probe.src = url;
		});
	}
	await ciSleep(500);
	const box = clip.getBoundingClientRect();
	const left = Math.max(0, box.left);
	const right = Math.min(window.innerWidth, box.right);
	const rect = [left, box.top, Math.max(0, right - left), box.height].map((v) => v.toFixed(1)).join(",");
	ciLog(
		`CLIP kind=image thumbs=${thumbs.length} thumbHeight=${(first?.getBoundingClientRect().height ?? 0).toFixed(1)} ` +
			`clipHeight=${box.height.toFixed(1)} image=${image} rect=${rect}`,
	);
}

/** The export sheet's steps when the sheet cannot be driven (export-sheet.tsx startExport). */
async function ciDirectExport(editor: EditorCore, bridge: NativeBridge): Promise<void> {
	const { width, height } = editor.project.getActive().settings.canvasSize;
	if (Math.min(width, height) !== 1080) {
		const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
		const aspect = width / height;
		const canvasSize = aspect >= 1 ? { width: even(1080 * aspect), height: 1080 } : { width: 1080, height: even(1080 / aspect) };
		editor.command.execute({ command: new UpdateProjectSettingsCommand({ canvasSize, canvasSizeMode: "preset" }) });
	}
	const { buildEdl } = await import("@kneecap/editor-core/edl");
	const { toEdlMediaAssets, buildNativeEdlAssetResolver } = await import("@kneecap/mobile-ui");
	const { renderOverlayFrames } = await import("@kneecap/editor-core/export/overlay-frames");
	const edl = buildEdl({
		project: editor.project.getActive(),
		scene: editor.scenes.getActiveScene(),
		mediaAssets: toEdlMediaAssets({ assets: editor.media.getAssets() }),
		resolveAsset: buildNativeEdlAssetResolver(),
		output: {
			container: "mp4",
			videoCodec: "h264",
			audioCodec: "aac",
			bitrate: 10_000_000, // "High"
			includeAudio: true,
			fps: { numerator: 30, denominator: 1 },
		},
	});
	let overlayFrames: Awaited<ReturnType<typeof renderOverlayFrames>> = [];
	try {
		overlayFrames = await renderOverlayFrames({
			tracks: editor.scenes.getActiveScene().tracks,
			mediaAssets: editor.media.getAssets(),
			canvasSize: { width: edl.output.resolution.width, height: edl.output.resolution.height },
			fps: edl.output.fps,
			durationTicks: edl.meta.durationTicks,
			ticksPerSecond: edl.meta.ticksPerSecond,
		});
	} catch (error) {
		ciLog(`overlay prerender failed: ${ciDescribe(error)}`);
	}
	for await (const event of bridge.exportProject({ edl, overlayFrames })) {
		if (event.stage === "done" || event.stage === "error") break;
	}
}

/** The latest end (seconds) over every track of the active scene: the
 *  length the exported file must have (blind test 1.0.5: a text clip that
 *  ended at 00:05 over a 3 s photo exported a 3 s file). */
function ciTimelineEnd(editor: EditorCore): { end: number; detail: string } {
	const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
	if (!tracks) return { end: 0, detail: "no scene" };
	let end = 0;
	const parts: string[] = [];
	const visit = (label: string, elements: readonly { startTime: MediaTime; duration: MediaTime }[]) => {
		if (elements.length === 0) return;
		let trackEnd = 0;
		for (const element of elements) {
			trackEnd = Math.max(
				trackEnd,
				mediaTimeToSeconds({ time: element.startTime }) + mediaTimeToSeconds({ time: element.duration }),
			);
		}
		parts.push(`${label}:${trackEnd.toFixed(3)}`);
		end = Math.max(end, trackEnd);
	};
	visit("main", tracks.main.elements);
	tracks.overlay.forEach((track, index) => visit(`${track.type}${index}`, track.elements));
	tracks.audio.forEach((track, index) => visit(`audio${index}`, track.elements));
	return { end, detail: parts.join(",") || "empty" };
}

interface CiExportOptions {
	resolution: string;
	fps: string;
	quality: string;
	/** The SHOT name after the export. */
	shot: string;
}

/** Test C: 1 photo + 1 text at 1080p / 30 fps / High. */
const CI_MAIN_EXPORT: CiExportOptions = { resolution: "1080p", fps: "30", quality: "High", shot: "export" };
/** Test E: the video sweep, smaller so the simulator's software encoder is quicker. */
const CI_SWEEP_EXPORT: CiExportOptions = { resolution: "720p", fps: "30", quality: "Medium", shot: "sweep-export" };

/** One export through the export sheet (tests C and E). */
async function ciExport(ctx: CiContext, editor: EditorCore, options: CiExportOptions): Promise<void> {
	const { bridge } = ctx;
	let result: ExportProgress | null = null;
	let thrown: string | null = null;
	// Watch the real bridge call; the events pass through unchanged.
	const originalExport = bridge.exportProject;
	bridge.exportProject = (params) => {
		const ticksPerSecond = Number(params.edl.meta.ticksPerSecond);
		const edlSeconds = ticksPerSecond > 0 ? Number(params.edl.meta.durationTicks) / ticksPerSecond : -1;
		ciLog(
			`EXPORT start output=${JSON.stringify(params.edl.output).slice(0, 400)} overlayFrames=${params.overlayFrames?.length ?? 0} edlSeconds=${edlSeconds.toFixed(3)}`,
		);
		const inner = originalExport.call(bridge, params);
		let lastStage = "";
		async function* observed(): AsyncGenerator<ExportProgress> {
			try {
				for await (const event of inner) {
					if (event.stage !== lastStage) {
						lastStage = event.stage;
						ciLog(`EXPORT stage=${event.stage} fraction=${event.fraction.toFixed(2)}`);
					}
					if (event.stage === "done" || event.stage === "error") result = event;
					yield event;
				}
			} catch (error) {
				thrown = ciDescribe(error);
				throw error;
			} finally {
				await inner.return(undefined);
			}
		}
		return observed();
	};

	let via = "sheet";
	try {
		document.querySelector<HTMLButtonElement>(".cc-export-btn")?.click();
		const sheetButton = await ciWait("Export video button", () => ciButton(document, /^Export video$/), 10_000).catch(() => null);
		if (sheetButton) {
			const pick = (group: string, label: string) => {
				const option = [...document.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] button`)].find(
					(b) => (b.textContent ?? "").trim() === label,
				);
				option?.click();
				return option ? "ok" : "missing";
			};
			ciLog(
				`EXPORT settings resolution=${pick("Resolution", options.resolution)} fps=${pick("Frame rate", options.fps)} ` +
					`quality=${pick("Quality", options.quality)}`,
			);
			await ciSleep(500);
			const start = ciButton(document, /^Export video$/);
			if (!start) throw new Error("the Export video button went away");
			const timeline = ciTimelineEnd(editor);
			ciLog(`TIMELINE end=${timeline.end.toFixed(3)} tracks=${timeline.detail} timeline=${JSON.stringify(ciCounts(editor))}`);
			start.click();
		} else {
			via = "direct";
			document.querySelector<HTMLElement>(".cc-sheet-scrim")?.click();
			const timeline = ciTimelineEnd(editor);
			ciLog(`TIMELINE end=${timeline.end.toFixed(3)} tracks=${timeline.detail} timeline=${JSON.stringify(ciCounts(editor))}`);
			void ciDirectExport(editor, bridge).catch((error: unknown) => {
				thrown = ciDescribe(error);
			});
		}
		const sheetError = () =>
			[...document.querySelectorAll(".cc-sheet .cc-panel-note")]
				.map((node) => (node.textContent ?? "").trim())
				.find((text) => text.startsWith("Export failed")) ?? null;
		await ciWait("export result", () => result ?? thrown ?? sheetError(), 600_000);
		const final = result as ExportProgress | null;
		if (final?.stage === "done" && final.outputUri) {
			const marker = "/_capacitor_file_";
			const index = final.outputUri.indexOf(marker);
			const path = index === -1 ? final.outputUri : final.outputUri.slice(index + marker.length);
			ciLog(`EXPORT DONE via=${via} path=${path}`);
		} else {
			const reason = final?.error ?? thrown ?? sheetError() ?? "export ended without a file";
			ciLog(`EXPORT FAIL via=${via} error=${reason}`);
		}
	} catch (error) {
		ciLog(`EXPORT FAIL via=${via} error=${ciDescribe(error)}`);
	} finally {
		bridge.exportProject = originalExport;
	}
	if (via === "sheet") await ciExportSheetEnd();
	await ciShot(ctx, options.shot);
}

/**
 * What the export sheet shows when the export ends (blind test 1.0.5): after
 * a good save "Saved to Photos" with the buttons "Open Photos" and "Share";
 * after a failed export "Export failed. Try again.". The Photos save comes
 * after the native "done" event, so this waits up to 30 s for its words.
 * Logs one line: EXPORT SHEET {"saved":…,"failed":…,"notes":[…],"buttons":[…],"text":"…"}.
 */
async function ciExportSheetEnd(): Promise<void> {
	const sheetText = () => (document.querySelector(".cc-sheet")?.textContent ?? "").replace(/\s+/g, " ").trim();
	await ciWait(
		"the save result in the export sheet",
		() => /Saved to Photos|Could not save|Export failed/i.test(sheetText()),
		30_000,
		false,
	).catch(() => undefined);
	const text = sheetText();
	const notes = [...document.querySelectorAll(".cc-sheet .cc-panel-note")]
		.map((node) => (node.textContent ?? "").trim())
		.filter(Boolean);
	const buttons = [...document.querySelectorAll<HTMLButtonElement>(".cc-sheet button")]
		.map((button) => ((button.textContent ?? "").trim() || button.getAttribute("aria-label") || "").slice(0, 40))
		.filter(Boolean);
	ciLog(
		`EXPORT SHEET ${JSON.stringify({
			saved: /Saved to Photos/i.test(text),
			failed: /Export failed\. Try again\./.test(text),
			notes: notes.slice(0, 4).map((note) => note.slice(0, 80)),
			buttons: buttons.slice(0, 20),
			text: text.slice(0, 120),
		})}`,
	);
}

// ----------------------------------------------------- shared UI helpers (D, E)

/** A button of a toolbar ("Editor tools": the bottom toolbar, "Clip tools":
 *  the selected-clip row), found by its label. */
function ciToolbarButton(toolbar: string, label: RegExp): HTMLButtonElement | null {
	const scope = document.querySelector(`[aria-label="${toolbar}"]`);
	if (!scope) return null;
	for (const button of scope.querySelectorAll<HTMLButtonElement>("button")) {
		const text = (button.querySelector(".cc-toolbar__item-label")?.textContent ?? button.textContent ?? "").trim();
		if (!button.disabled && label.test(text)) return button;
	}
	return null;
}

/** Opens a bottom-toolbar sheet. Null (and a FAIL line) when it does not open. */
async function ciOpenSheet(tool: RegExp, tag: string): Promise<Element | null> {
	document.querySelector<HTMLElement>(".cc-sheet-scrim")?.click();
	await ciSleep(300);
	const button = ciToolbarButton("Editor tools", tool);
	if (!button) {
		ciLog(`${tag} FAIL no ${tool.source} button in the editor tools`);
		return null;
	}
	button.click();
	const sheet = await ciWait(`${tag} sheet`, () => document.querySelector(".cc-sheet"), 10_000).catch(() => null);
	if (!sheet) ciLog(`${tag} FAIL the ${tool.source} sheet did not open`);
	return sheet;
}

async function ciCloseSheet(): Promise<void> {
	document.querySelector<HTMLElement>(".cc-sheet-scrim")?.click();
	await ciWait("closed sheet", () => !document.querySelector(".cc-sheet"), 5_000, false).catch(() => undefined);
}

function ciSheetNotes(): string[] {
	return [...document.querySelectorAll(".cc-sheet .cc-panel-note")].map((node) => (node.textContent ?? "").trim());
}

/** Audio elements of the active scene, with the fields that find their file. */
function ciAudioElements(editor: EditorCore): { id: string; sourceUrl?: string; mediaId?: string; sourceType?: string }[] {
	const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
	if (!tracks) return [];
	return tracks.audio
		.flatMap((track) => track.elements)
		.map((element) => {
			const raw = element as unknown as Record<string, unknown>;
			return {
				id: element.id,
				sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : undefined,
				mediaId: typeof raw.mediaId === "string" ? raw.mediaId : undefined,
				sourceType: typeof raw.sourceType === "string" ? raw.sourceType : undefined,
			};
		});
}

/** The planted file as the handle NativeBridgePlugin+Media.swift builds for a pick. */
async function ciPlantedHandle(
	place: CiPlace,
	relative: string,
	fields: Omit<MediaHandle, "id" | "uri" | "fileName" | "sizeBytes">,
): Promise<MediaHandle | null> {
	const uri = `${place.root}/${relative}`;
	let sizeBytes = 0;
	try {
		const res = await fetch(place.bridge.toPlaybackUri(`file://${uri}`), { cache: "no-store" });
		sizeBytes = (await res.blob()).size;
	} catch {
		// sizeBytes stays 0: the caller reports the missing file
	}
	if (sizeBytes === 0) return null;
	return {
		...fields,
		id: crypto.randomUUID().toUpperCase(),
		uri,
		fileName: relative.slice(relative.lastIndexOf("/") + 1),
		sizeBytes,
	};
}

/** Replaces the OS picker with the planted file. Returns the restore function. */
function ciStubPicker(place: CiPlace, handle: MediaHandle): () => void {
	const { bridge } = place;
	const original = bridge.pickMedia;
	bridge.pickMedia = async (opts) => {
		ciLog(`pickMedia stand-in: kinds=${opts.kinds.join(",")} -> ${handle.fileName} (${handle.sizeBytes} bytes)`);
		opts.onProgress?.({ index: 0, total: 1, stage: "loading", fraction: 0 });
		opts.onProgress?.({ index: 0, total: 1, stage: "loaded", fraction: 1 });
		return [handle];
	};
	return () => {
		bridge.pickMedia = original;
	};
}

// ------------------------------------------------- D: stickers, bundled sound

type CiImageState = "ok" | "broken" | "blank" | "timeout";

/** Loads one image URL again: "broken" when it errors, "blank" when it loads
 *  but draws nothing (an SVG with only a viewBox has no natural size, so its
 *  pixels are checked instead of naturalWidth). */
function ciProbeImage(src: string): Promise<CiImageState> {
	return new Promise((resolve) => {
		const probe = new Image();
		const timer = setTimeout(() => resolve("timeout"), 10_000);
		probe.onload = () => {
			clearTimeout(timer);
			if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
				resolve("ok");
				return;
			}
			try {
				const canvas = document.createElement("canvas");
				canvas.width = 32;
				canvas.height = 32;
				const g = canvas.getContext("2d");
				if (!g) {
					resolve("ok");
					return;
				}
				g.drawImage(probe, 0, 0, 32, 32);
				const data = g.getImageData(0, 0, 32, 32).data;
				let painted = 0;
				for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
				resolve(painted > 0 ? "ok" : "blank");
			} catch {
				resolve("ok"); // the image loaded; a tainted canvas only hides its pixels
			}
		};
		probe.onerror = () => {
			clearTimeout(timer);
			resolve("broken");
		};
		probe.src = src;
	});
}

/** The state of every tile image: waits for them to finish, then checks each. */
async function ciCheckImages(images: HTMLImageElement[]): Promise<Record<CiImageState, number> & { first: string }> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline && images.some((img) => !img.complete)) await ciSleep(200);
	const states = await Promise.all(
		images.map((img): Promise<CiImageState> => {
			const src = img.currentSrc || img.src;
			if (!src) return Promise.resolve("broken");
			if (img.complete && img.naturalWidth > 0) return Promise.resolve("ok");
			return ciProbeImage(src);
		}),
	);
	const counts = { ok: 0, broken: 0, blank: 0, timeout: 0, first: "" };
	states.forEach((state, index) => {
		counts[state]++;
		const img = images[index];
		if (state !== "ok" && !counts.first && img) counts.first = (img.currentSrc || img.src).slice(0, 100);
	});
	return counts;
}

/** The Stickers sheet's tabs (chips, or a tab bar if the sheet uses one). */
function ciStickerTabs(): HTMLButtonElement[] {
	return [...document.querySelectorAll<HTMLButtonElement>('.cc-sheet .cc-chip, .cc-sheet [role="tab"]')];
}

/** Waits until the open tab shows its tiles (or says it has none). */
function ciStickerTilesReady(): Promise<string> {
	return ciWait(
		"sticker tiles",
		() => {
			if (ciSheetNotes().some((text) => /^Loading/i.test(text))) return null;
			if (document.querySelector(".cc-sheet .cc-thumb")) return "tiles";
			return ciSheetNotes().some((text) => /no stickers/i.test(text)) ? "empty" : null;
		},
		30_000,
	).catch(() => "timeout");
}

/**
 * Blind test 1.0.5: the Flags tab showed only broken images (the flag SVGs
 * were not in the mobile bundle). Opens EVERY tab, waits for the tiles and
 * checks every image; then taps one tile. Logs
 *   STICKERS tab="<label>" state=… tiles=N images=N ok=N broken=N blank=N timeout=N [first=<src>]
 *   STICKER PASS|FAIL …
 * Returns 1 when a sticker landed on the timeline (for the undo).
 */
async function ciStickers(ctx: CiContext, editor: EditorCore): Promise<number> {
	if (!(await ciOpenSheet(/^Stickers?$/i, "STICKERS"))) return 0;
	await ciStickerTilesReady();
	const labels = ciStickerTabs().map((tab) => (tab.textContent ?? "").trim());
	ciLog(`STICKERS tabs=${labels.length} names=${JSON.stringify(labels)}`);
	const tabs = labels.length > 0 ? labels : ["(one grid, no tabs)"];
	const good: string[] = [];
	for (let i = 0; i < tabs.length; i++) {
		const label = tabs[i] ?? "";
		if (labels.length > 0) {
			ciStickerTabs()
				.find((tab) => (tab.textContent ?? "").trim() === label)
				?.click();
			await ciSleep(400);
		}
		const state = await ciStickerTilesReady();
		const tiles = document.querySelectorAll(".cc-sheet .cc-thumb").length;
		const images = [...document.querySelectorAll<HTMLImageElement>(".cc-sheet .cc-thumb img")];
		const result = await ciCheckImages(images);
		ciLog(
			`STICKERS tab=${JSON.stringify(label)} state=${state} tiles=${tiles} images=${images.length} ok=${result.ok} ` +
				`broken=${result.broken} blank=${result.blank} timeout=${result.timeout}${result.first ? ` first=${result.first}` : ""}`,
		);
		if (images.length > 0 && result.ok === images.length) good.push(label);
		await ciShot(ctx, `stickers-${i + 1}`);
	}

	// One tile onto the timeline, from a tab whose images all load.
	const stickers = () => {
		const counts = ciCounts(editor);
		return (counts.sticker ?? 0) + (counts.graphic ?? 0);
	};
	const before = stickers();
	const tabName = good[0] ?? tabs[0] ?? "";
	if (labels.length > 0) {
		ciStickerTabs()
			.find((tab) => (tab.textContent ?? "").trim() === tabName)
			?.click();
		await ciSleep(400);
		await ciStickerTilesReady();
	}
	const tile = document.querySelector<HTMLButtonElement>(".cc-sheet .cc-thumb");
	tile?.click();
	const added = tile
		? await ciWait("sticker on the timeline", () => stickers() > before, 10_000).then(
				() => true,
				() => false,
			)
		: false;
	ciLog(
		`STICKER ${added ? "PASS" : "FAIL"} via=ui tab=${JSON.stringify(tabName)} ` +
			`tile=${tile ? JSON.stringify((tile.textContent ?? "").trim().slice(0, 40)) : "none"} timeline=${JSON.stringify(ciCounts(editor))}`,
	);
	await ciCloseSheet();
	if (added) {
		await ciSettle(editor, 1500);
		await ciShot(ctx, "sticker");
	}
	return added ? 1 : 0;
}

/** Fetches a sound and decodes it the way WebAudio would play it. "ok …" or the problem. */
async function ciLoadSound(url: string): Promise<string> {
	try {
		const res = await fetch(url, { cache: "no-store" });
		if (!(res.ok || res.status === 0)) return `http-${res.status}`;
		const bytes = await res.arrayBuffer();
		if (bytes.byteLength < 100) return `only-${bytes.byteLength}-bytes`;
		if (typeof OfflineAudioContext !== "function") return `ok bytes=${bytes.byteLength} decode=n/a`;
		const audio = await new OfflineAudioContext(1, 1, 44_100).decodeAudioData(bytes);
		return `ok bytes=${bytes.byteLength} seconds=${audio.duration.toFixed(2)}`;
	} catch (error) {
		return `error(${ciDescribe(error).slice(0, 120)})`;
	}
}

/**
 * Blind test 1.0.5: a bundled sound from the Audio sheet lands on the
 * timeline and its file loads. Logs SOUND PASS|FAIL … Returns 1 when an
 * audio clip landed (for the undo).
 */
async function ciSound(editor: EditorCore): Promise<number> {
	await ciSettle(editor, 300);
	if (!(await ciOpenSheet(/^Audio$/i, "SOUND"))) return 0;
	const inGroup = [...document.querySelectorAll<HTMLButtonElement>(".cc-sheet .cc-panel-actions button")];
	const anyButton = [...document.querySelectorAll<HTMLButtonElement>(".cc-sheet .cc-sheet__body button")];
	const candidates = (inGroup.length > 0 ? inGroup : anyButton).filter(
		(button) => !button.disabled && (button.textContent ?? "").trim() && !/import|files/i.test(button.textContent ?? ""),
	);
	const sound = candidates[0];
	if (!sound) {
		ciLog(`SOUND FAIL no bundled sound in the Audio sheet (notes=${JSON.stringify(ciSheetNotes())})`);
		await ciCloseSheet();
		return 0;
	}
	const name = (sound.textContent ?? "").trim().slice(0, 40);
	const before = ciCounts(editor).audio ?? 0;
	const known = new Set(ciAudioElements(editor).map((element) => element.id));
	sound.click();
	// The sound goes through the native import (a copy into the media
	// folder and a probe), so it can take some seconds.
	const added = await ciWait("sound on the timeline", () => (ciCounts(editor).audio ?? 0) > before, 30_000).then(
		() => true,
		() => false,
	);
	const element = ciAudioElements(editor).find((candidate) => !known.has(candidate.id));
	const assetUrl = element?.mediaId ? editor.media.getAssets().find((asset) => asset.id === element.mediaId)?.url : undefined;
	const url = element?.sourceUrl ?? assetUrl ?? null;
	const load = url ? await ciLoadSound(url) : element ? `no-file-url(sourceType=${element.sourceType ?? "?"})` : "no-element";
	ciLog(
		`SOUND ${added && load.startsWith("ok") ? "PASS" : "FAIL"} name=${JSON.stringify(name)} added=${added} load=${load} ` +
			`url=${url ? url.slice(0, 48) : "none"} sounds=${candidates.length} timeline=${JSON.stringify(ciCounts(editor))}`,
	);
	await ciCloseSheet();
	return added ? 1 : 0;
}

/** Test D. The inserts are undone at the end, so test C exports photo + text only. */
async function ciStickersAndSound(ctx: CiContext, editor: EditorCore): Promise<void> {
	await ciSettle(editor, 300);
	const start = JSON.stringify(ciCounts(editor));
	let inserted = 0;
	try {
		inserted += await ciStickers(ctx, editor);
		inserted += await ciSound(editor);
	} finally {
		await ciCloseSheet();
		for (let i = 0; i < inserted; i++) {
			editor.command.undo();
			await ciSleep(300);
		}
		const end = JSON.stringify(ciCounts(editor));
		ciLog(`CLEANUP ${end === start ? "PASS" : "FAIL"} undone=${inserted} start=${start} end=${end}`);
		await ciSettle(editor, 500);
	}
}

// ----------------------------------------------------------- E: video sweep

/** Taps a video clip on the timeline (the real pointer path). Returns the selection. */
async function ciSelectVideoClip(
	editor: EditorCore,
	which: "first" | "last",
): Promise<{ trackId: string; elementId: string } | null> {
	editor.selection.setSelectedElements({ elements: [] });
	await ciSleep(300);
	const nodes = [...document.querySelectorAll<HTMLElement>(".cc-timeline__clip--video")];
	const node = which === "first" ? nodes[0] : nodes[nodes.length - 1];
	if (!node) return null;
	const rect = node.getBoundingClientRect();
	const pointer = {
		bubbles: true,
		cancelable: true,
		pointerId: 7,
		pointerType: "touch",
		clientX: rect.left + rect.width / 2,
		clientY: rect.top + rect.height / 2,
	};
	node.dispatchEvent(new PointerEvent("pointerdown", pointer));
	node.dispatchEvent(new PointerEvent("pointerup", pointer));
	await ciSleep(400);
	const selected = editor.selection.getSelectedElements();
	return selected.length === 1 && selected[0] ? selected[0] : null;
}

/** True when the element (or its whole track) is muted in the editor state. */
function ciIsMuted(editor: EditorCore, ref: { trackId: string; elementId: string }): boolean {
	const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
	if (!tracks) return false;
	const track = [tracks.main, ...tracks.overlay, ...tracks.audio].find((candidate) => candidate.id === ref.trackId);
	if (!track) return false;
	if ("muted" in track && track.muted === true) return true;
	const elements = track.elements as readonly { id: string }[];
	const element = elements.find((candidate) => candidate.id === ref.elementId) as Record<string, unknown> | undefined;
	if (!element) return false;
	const params = element.params as Record<string, unknown> | undefined;
	return params?.muted === true || element.isSourceAudioEnabled === false;
}

/** The Mute (or Unmute) control: in the clip tools row, in the open sheet,
 *  or (last) on the timeline. */
function ciMuteControl(): { button: HTMLButtonElement; where: string } | null {
	const scopes: [string, Element | null][] = [
		["clip-tools", document.querySelector('[aria-label="Clip tools"]')],
		["sheet", document.querySelector(".cc-sheet")],
		["timeline", document.querySelector(".cc-editor-shell__timeline")],
	];
	for (const [where, scope] of scopes) {
		if (!scope) continue;
		for (const button of scope.querySelectorAll<HTMLButtonElement>("button")) {
			const text = `${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""}`;
			if (!button.disabled && /\b(un)?mute/i.test(text)) return { button, where };
		}
	}
	return null;
}

/** The planted video through the timeline "+" (only the OS picker is replaced;
 *  the native proxy transcode is real). Logs VIDEO-IMPORT PASS|FAIL … */
async function ciImportVideo(ctx: CiContext, editor: EditorCore): Promise<boolean> {
	const handle = await ciPlantedHandle(ctx, CI_VIDEO, {
		kind: "video",
		durationMicros: CI_VIDEO_SECONDS * 1_000_000,
		width: 1280,
		height: 720,
		rotationDegrees: 0,
		hasAudio: true,
		codec: "avc1",
		frameRate: { numerator: 30, denominator: 1 },
	});
	if (!handle) {
		ciLog(`VIDEO-IMPORT FAIL the planted video ${CI_VIDEO} is missing or empty`);
		return false;
	}
	const plus = await ciWait(
		"Add clip button",
		() => document.querySelector<HTMLButtonElement>('button[aria-label="Add clip"]'),
		10_000,
	).catch(() => null);
	if (!plus) {
		ciLog("VIDEO-IMPORT FAIL no Add clip button on the timeline");
		return false;
	}
	const restore = ciStubPicker(ctx, handle);
	const before = ciCounts(editor).video ?? 0;
	const started = Date.now();
	try {
		plus.click();
		const outcome = await ciWait(
			"video clip on the timeline",
			() => {
				if ((ciCounts(editor).video ?? 0) > before) return "placed";
				const error = document
					.querySelector(".cc-chrome-error:not(.cc-chrome-error--notice)")
					?.textContent?.trim();
				return error ? `error: ${error}` : null;
			},
			240_000,
		).catch((error: unknown) => ciDescribe(error));
		const asset = editor.media.getAssets().find((candidate) => candidate.type === "video");
		const assetText = asset
			? `video ${asset.width ?? "?"}x${asset.height ?? "?"} duration=${asset.duration ?? "?"} hasAudio=${String(asset.hasAudio)}`
			: "none";
		ciLog(
			`VIDEO-IMPORT ${outcome === "placed" ? "PASS" : "FAIL"} ${outcome} ms=${Date.now() - started} asset=${assetText} ` +
				`timeline=${JSON.stringify(ciCounts(editor))}`,
		);
		return outcome === "placed";
	} finally {
		restore();
	}
}

/**
 * Captions "Generate" on the video with sound (a tone, no speech). The sheet
 * must end with captions or with one of the plain messages (CAPTION_MESSAGES
 * in captions-actions.ts); the runner checks the words. Logs
 * CAPTIONS {"state":…,"ms":…,"captions":N,"message":"…","words":"…"}.
 */
async function ciCaptions(ctx: CiContext, editor: EditorCore): Promise<void> {
	await ciSettle(editor, 300);
	const sheet = await ciOpenSheet(/^Captions$/i, "CAPTIONS");
	if (!sheet) return;
	const generate = await ciWait(
		"Generate button",
		() => {
			const open = document.querySelector(".cc-sheet");
			return open ? ciButton(open, /^Generate/) : null;
		},
		10_000,
	).catch(() => null);
	if (!generate) {
		ciLog("CAPTIONS FAIL no Generate button in the Captions sheet");
		await ciCloseSheet();
		return;
	}
	const notesBefore = new Set(ciSheetNotes());
	const captionsBefore = ciCounts(editor).caption ?? 0;
	const started = Date.now();
	generate.click();
	await ciSleep(800);
	const state = await ciWait(
		"the end of Generate",
		() => {
			const open = document.querySelector(".cc-sheet");
			if (!open) return "closed";
			const busy = [...open.querySelectorAll("button")].some((button) => /Generating/i.test(button.textContent ?? ""));
			return busy ? null : "settled";
		},
		300_000,
	).catch(() => "timeout");
	await ciSleep(800);
	const fresh = ciSheetNotes().filter((text) => text && !notesBefore.has(text));
	const chromeError = document.querySelector(".cc-chrome-error")?.textContent?.trim() ?? "";
	const words = getAllCaptions({ editor })
		.flatMap(({ element }) => element.words.map((word) => word.text))
		.join(" ");
	ciLog(
		`CAPTIONS ${JSON.stringify({
			state,
			ms: Date.now() - started,
			captions: (ciCounts(editor).caption ?? 0) - captionsBefore,
			message: (fresh.join(" ") || chromeError).slice(0, 300),
			words: words.slice(0, 120),
		})}`,
	);
	await ciShot(ctx, "captions");
	await ciCloseSheet();
}

/** Split, Duplicate and Delete from the selected-clip row, then Mute.
 *  Logs EDIT op=<split|duplicate|delete|mute> PASS|FAIL … */
async function ciVideoEdits(editor: EditorCore): Promise<void> {
	const videos = () => ciCounts(editor).video ?? 0;
	const edit = async (op: string, which: "first" | "last", label: RegExp, change: number, prepare?: () => void) => {
		await ciSettle(editor, 300);
		const before = videos();
		const ref = await ciSelectVideoClip(editor, which);
		if (!ref) {
			ciLog(`EDIT op=${op} FAIL could not select a video clip (${before} on the timeline)`);
			return;
		}
		prepare?.();
		await ciSleep(400);
		const button = await ciWait(`${op} button`, () => ciToolbarButton("Clip tools", label), 5_000).catch(() => null);
		if (!button) {
			ciLog(`EDIT op=${op} FAIL no ${label.source} button in the clip tools`);
			return;
		}
		button.click();
		const ok = await ciWait(`${op} result`, () => videos() === before + change, 5_000).then(
			() => true,
			() => false,
		);
		ciLog(
			`EDIT op=${op} ${ok ? "PASS" : "FAIL"} video clips ${before}->${videos()} (want ${before + change}) ` +
				`end=${ciTimelineEnd(editor).end.toFixed(2)} timeline=${JSON.stringify(ciCounts(editor))}`,
		);
	};
	// Split the 4 s clip at 2 s, duplicate the first piece, delete the last clip.
	await edit("split", "first", /^Split$/i, 1, () =>
		editor.playback.seek({ time: mediaTimeFromSeconds({ seconds: CI_VIDEO_SECONDS / 2 }) }),
	);
	await edit("duplicate", "first", /^Duplicate$/i, 1);
	await edit("delete", "last", /^Delete$/i, -1);

	// Mute: the control may be on the clip tools row or in the Edit sheet.
	await ciSettle(editor, 300);
	const ref = await ciSelectVideoClip(editor, "first");
	if (!ref) {
		ciLog("EDIT op=mute FAIL could not select a video clip");
		return;
	}
	// The clip tools row first; then the Edit sheet (opened from that row).
	let control = ciMuteControl();
	if (!control || control.where === "timeline") {
		ciToolbarButton("Clip tools", /^Edit$/i)?.click();
		await ciWait("Edit sheet", () => document.querySelector(".cc-sheet"), 5_000).catch(() => null);
		control = ciMuteControl() ?? control;
	}
	if (!control) {
		ciLog(`EDIT op=mute FAIL no Mute control in the clip tools, the Edit sheet or the timeline (muted=${ciIsMuted(editor, ref)})`);
		await ciCloseSheet();
		return;
	}
	const { where } = control;
	const label = `${control.button.textContent ?? ""} ${control.button.getAttribute("aria-label") ?? ""}`.trim().slice(0, 30);
	const start = ciIsMuted(editor, ref);
	control.button.click();
	const muted = await ciWait("muted", () => ciIsMuted(editor, ref), 5_000).then(
		() => true,
		() => false,
	);
	await ciSleep(400);
	// Unmute with the same control (its label may now say Unmute).
	const again = ciMuteControl();
	again?.button.click();
	const unmuted = again
		? await ciWait("unmuted", () => !ciIsMuted(editor, ref), 5_000).then(
				() => true,
				() => false,
			)
		: false;
	ciLog(
		`EDIT op=mute ${!start && muted && unmuted ? "PASS" : "FAIL"} where=${where} muted ${start}->${muted ? "true" : "false"}` +
			`->${unmuted ? "false" : "true"} control=${JSON.stringify(label)}`,
	);
	// The export below needs the sound: undo a mute the control could not undo.
	for (let i = 0; i < 2 && ciIsMuted(editor, ref); i++) {
		editor.command.undo();
		await ciSleep(300);
	}
	await ciCloseSheet();
}

/** The Audio sheet's "Import audio" with the planted audio file. Logs AUDIO-IMPORT PASS|FAIL … */
async function ciImportAudio(ctx: CiContext, editor: EditorCore): Promise<void> {
	await ciSettle(editor, 300);
	const handle = await ciPlantedHandle(ctx, CI_AUDIO, {
		kind: "audio",
		durationMicros: CI_AUDIO_SECONDS * 1_000_000,
		width: 0,
		height: 0,
		rotationDegrees: 0,
		hasAudio: true,
		codec: "m4a",
		frameRate: null,
	});
	if (!handle) {
		ciLog(`AUDIO-IMPORT FAIL the planted audio ${CI_AUDIO} is missing or empty`);
		return;
	}
	if (!(await ciOpenSheet(/^Audio$/i, "AUDIO-IMPORT"))) return;
	const button = await ciWait(
		"Import audio button",
		() => {
			const open = document.querySelector(".cc-sheet");
			return open ? ciButton(open, /import audio/i) : null;
		},
		10_000,
	).catch(() => null);
	if (!button) {
		ciLog("AUDIO-IMPORT FAIL no Import audio button in the Audio sheet");
		await ciCloseSheet();
		return;
	}
	const notesBefore = new Set(ciSheetNotes());
	const before = ciCounts(editor).audio ?? 0;
	const restore = ciStubPicker(ctx, handle);
	const started = Date.now();
	try {
		button.click();
		const outcome = await ciWait(
			"imported audio on the timeline",
			() => {
				if ((ciCounts(editor).audio ?? 0) > before) return "placed";
				const note = ciSheetNotes().find((text) => text && !notesBefore.has(text));
				const error = document.querySelector(".cc-chrome-error:not(.cc-chrome-error--notice)")?.textContent?.trim();
				return note ? `error: ${note}` : error ? `error: ${error}` : null;
			},
			120_000,
		).catch((error: unknown) => ciDescribe(error));
		const asset = editor.media.getAssets().find((candidate) => candidate.type === "audio");
		ciLog(
			`AUDIO-IMPORT ${outcome === "placed" ? "PASS" : "FAIL"} ${outcome} ms=${Date.now() - started} ` +
				`asset=${asset ? `audio duration=${asset.duration ?? "?"}` : "none"} timeline=${JSON.stringify(ciCounts(editor))}`,
		);
	} finally {
		restore();
	}
	await ciCloseSheet();
}

/** Test E (phase 3): a new project with the planted video, every edit, then an export. */
async function ciVideoSweep(ctx: CiContext, editor: EditorCore): Promise<void> {
	ctx.step = "E";
	await ciWait("home screen", () => document.querySelector(".kc-home"), 120_000);
	await ciProjects(editor, "sweep-start");
	// The OPEN line says extra=1: this open does not count for test A.
	const open = await ciOpen(ctx, editor, 8, "new", null, { stay: true, extra: true });
	if (!open) {
		ciLog("E SKIP the editor did not open");
		return;
	}
	if (await ciImportVideo(ctx, editor)) {
		await ciSettle(editor, 500);
		editor.playback.seek({ time: mediaTimeFromSeconds({ seconds: 1 }) });
		await ciSleep(4000);
		await ciShot(ctx, "video");
		await ciCaptions(ctx, editor);
		await ciVideoEdits(editor);
		await ciImportAudio(ctx, editor);
		await ciSettle(editor, 1500);
		await ciShot(ctx, "sweep-timeline");
		await ciExport(ctx, editor, CI_SWEEP_EXPORT);
	} else {
		ciLog("E SKIP the video did not import");
	}
	await ciCloseSheet();
	await ciBack(editor, "sweep-end").catch((error: unknown) => ciLog(`PROBLEM step=E kind=driver back: ${ciDescribe(error)}`));
}

async function ciRun(ctx: CiContext): Promise<void> {
	const editor = EditorCore.getInstance();
	if (ctx.phase === 3) {
		await ciVideoSweep(ctx, editor);
		await ciSleep(3000); // storage writes finish before the runner ends the app
		ciLog("END phase=3");
		return;
	}
	ctx.step = "A";
	await ciWait("home screen", () => document.querySelector(".kc-home"), 120_000);
	const atStart = await ciProjects(editor, "start");

	if (ctx.phase === 1) {
		if (await ciOpen(ctx, editor, 1, "new", null)) {
			const gpu = await Promise.race([ensurePreviewGpu(), ciSleep(5000).then(() => "pending")]);
			ciLog(`INFO step=A preview GPU init=${String(gpu)} (true: GPU, false: no GPU)`);
		}
		const name = editor.project.getSavedProjects().map((p) => p.name)[0] ?? null;
		await ciOpen(ctx, editor, 2, "reopen", name);
		await ciOpen(ctx, editor, 3, "reopen", name);
		await ciSleep(3000); // storage writes finish before the runner ends the app
		ciLog("END phase=1");
		return;
	}

	const name = atStart[0] ?? null;
	await ciOpen(ctx, editor, 4, "reopen", name);
	let open = await ciOpen(ctx, editor, 5, "reopen", name, { stay: true });
	// B and C need an open editor. These extra opens do not count for test A.
	for (let extra = 6; !open && extra <= 7; extra++) {
		const names = await ciProjects(editor, `before-open-${extra}`).catch(() => [] as string[]);
		open = await ciOpen(ctx, editor, extra, names.length ? "reopen" : "new", names[0] ?? null, {
			stay: true,
			extra: true,
		});
	}
	if (!open) {
		ciLog("B SKIP the editor did not open");
		ciLog("D SKIP the editor did not open");
		ciLog("C SKIP the editor did not open");
		ciLog("END phase=2");
		return;
	}
	ctx.step = "B";
	await ciPreview(ctx, editor);
	ctx.step = "D";
	await ciStickersAndSound(ctx, editor);
	ctx.step = "C";
	await ciExport(ctx, editor, CI_MAIN_EXPORT);
	ciLog("END phase=2");
}

async function mountEditorCi(found: CiPlace & { phase: 1 | 2 | 3 }): Promise<void> {
	const ctx: CiContext = { ...found, step: "boot", problems: 0, gpuProblems: 0 };
	ciWatchProblems(ctx);
	ciLog(
		`START phase=${ctx.phase} webgpu=${"gpu" in navigator ? "yes" : "no"} viewport=${window.innerWidth}x${window.innerHeight}`,
	);
	// The real app, mounted the way main.ts mounts it.
	const { mountApp } = await import("./app/app-root");
	mountApp();
	// Not awaited: main.ts marks the app mounted when this returns, as in a normal start.
	void ciRun(ctx).catch((error: unknown) => {
		ciLog(`PROBLEM step=${ctx.step} kind=driver ${ciDescribe(error)}`);
		ciLog(`END phase=${ctx.phase}`);
	});
}
