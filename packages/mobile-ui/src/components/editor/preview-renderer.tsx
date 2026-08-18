/**
 * Live preview rendering for the mobile editor — closes the "chrome-only
 * placeholder, does not render frame content" gap PreviewStage's own header
 * disclosed (and the founder hit on device: playback ran over a black
 * preview, 2026-08-18).
 *
 * Same architecture as apps/web's preview (apps/web/src/preview/components/
 * index.tsx, RenderTreeController + PreviewCanvas), deliberately minus the
 * web-only chrome (zoom/pan viewport, overlay handles, context menus):
 *   1. a scene-sync effect maps live engine state -> buildScene() ->
 *      editor.renderer.setRenderTree()
 *   2. a CanvasRenderer draws the tree into its output canvas (wgpu/wasm
 *      compositor underneath — WebGPU preferred, WebGL2 fallback)
 *   3. a rAF loop renders the frame under the playhead, skipping when
 *      neither the frame index nor the tree changed (same guard as web).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TICKS_PER_SECOND } from "@kneecap/editor-core";
import { useEditor } from "@kneecap/editor-core/react";
import { CanvasRenderer } from "@kneecap/editor-core/services/renderer/canvas-renderer";
import { buildScene } from "@kneecap/editor-core/services/renderer/scene-builder";
import type { RootNode } from "@kneecap/editor-core/services/renderer/nodes/root-node";
import { initializeGpu } from "opencut-wasm";

/** Same contract as apps/web's `initializeGpuRenderer()`: init once per
 *  process, NEVER reject — a GPU-less environment degrades (the compositor
 *  falls back off the wgpu path) instead of crashing. Constructing
 *  `CanvasRenderer` before this resolves was CRITICAL finding #1 of the
 *  2026-08-18 test sweep: `initializeGpu()` had never been called on the
 *  mobile shell, the first render threw "GPU context not initialized"
 *  inside React render, and the entire app unmounted to a black screen. */
let gpuInitPromise: Promise<boolean> | null = null;
export function ensurePreviewGpu(): Promise<boolean> {
	return ensureGpu();
}
function ensureGpu(): Promise<boolean> {
	if (!gpuInitPromise) {
		gpuInitPromise = initializeGpu()
			.then(() => true)
			.catch((error: unknown) => {
				console.warn(
					`GPU renderer unavailable: ${error instanceof Error ? error.message : String(error)}`,
				);
				return false;
			});
	}
	return gpuInitPromise;
}

export function PreviewRenderer() {
	const editor = useEditor();
	const [gpuReady, setGpuReady] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void ensureGpu().then((ok) => {
			if (cancelled) return;
			editor.renderer.setDegraded(!ok);
			setGpuReady(true);
		});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- editor is the process singleton.
	}, []);

	if (!gpuReady) return null;
	return <PreviewRendererInner />;
}

function PreviewRendererInner() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const tracks = useEditor(
		(e) => e.timeline.getPreviewTracks() ?? e.scenes.getActiveScene().tracks,
	);
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const renderTree = useEditor((e) => e.renderer.getRenderTree());

	const { width, height } = activeProject.settings.canvasSize;
	const background = activeProject.settings.background;
	const fps = activeProject.settings.fps;

	// Scene sync — rebuild the render tree whenever timeline/media/canvas
	// state changes. Reference identity on `tracks`/`mediaAssets` is the
	// engine's own change signal (managers notify with fresh snapshots).
	useEffect(() => {
		const duration = editor.timeline.getTotalDuration();
		const tree = buildScene({
			tracks,
			mediaAssets,
			duration,
			canvasSize: { width, height },
			background,
			isPreview: true,
		});
		editor.renderer.setRenderTree({ renderTree: tree });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `editor` is the process-wide singleton; the deps that matter are the state snapshots.
	}, [tracks, mediaAssets, background, width, height]);

	const renderer = useMemo(
		() => new CanvasRenderer({ width, height, fps }),
		[width, height, fps],
	);

	const mountRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const mount = mountRef.current;
		if (!mount) return;
		const outputCanvas = renderer.getOutputCanvas();
		outputCanvas.style.display = "block";
		outputCanvas.style.width = "100%";
		outputCanvas.style.height = "100%";
		mount.appendChild(outputCanvas);
		return () => {
			if (outputCanvas.parentElement === mount) {
				mount.removeChild(outputCanvas);
			}
		};
	}, [renderer]);

	const lastFrameRef = useRef(-1);
	const lastTreeRef = useRef<RootNode | null>(null);
	const renderingRef = useRef(false);

	const renderFrame = useCallback(() => {
		if (!renderTree || renderingRef.current) return;
		const renderTime = Math.min(
			editor.playback.getCurrentTime(),
			editor.timeline.getLastFrameTime(),
		);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * renderer.fps.denominator) / renderer.fps.numerator,
		);
		const frame = Math.floor(renderTime / ticksPerFrame);
		if (frame === lastFrameRef.current && renderTree === lastTreeRef.current) return;
		renderingRef.current = true;
		lastFrameRef.current = frame;
		lastTreeRef.current = renderTree;
		renderer
			.render({ node: renderTree, time: renderTime })
			.catch((error: unknown) => {
				// A single bad frame must not kill the loop; log and move on.
				console.error("preview render failed:", error);
			})
			.finally(() => {
				renderingRef.current = false;
			});
	}, [editor.playback, editor.timeline, renderTree, renderer]);

	useEffect(() => {
		let rafId: number;
		const tick = () => {
			renderFrame();
			rafId = requestAnimationFrame(tick);
		};
		rafId = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafId);
	}, [renderFrame]);

	return <div ref={mountRef} className="cc-preview-stage__render" />;
}
