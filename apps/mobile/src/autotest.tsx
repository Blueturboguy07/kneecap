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
	registerNativeAudioRouter,
	mediaTimeFromSeconds,
	videoCache,
	type NativeMediaHandle,
	type NativeMediaSource,
} from "@kneecap/editor-core";
import { buildElementFromMedia, buildTextElement } from "@kneecap/editor-core/timeline";
import { InsertElementCommand, UpdateElementsCommand } from "@kneecap/editor-core/commands";
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
