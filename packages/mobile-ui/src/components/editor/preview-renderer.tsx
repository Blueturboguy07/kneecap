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
 *      compositor underneath — WebGPU preferred, WebGL2 fallback; Canvas 2D
 *      when there is no GPU)
 *   3. a rAF loop renders the frame under the playhead, skipping when
 *      neither the frame index nor the tree changed (same guard as web).
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
	NO_SNAP,
	SNAP_CAPTURE_PX,
	SNAP_RELEASE_PX,
	pulseSnapHaptic,
	snapToCenterAxes,
	type AxisSnapFlags,
} from "../../editor/axis-snap";
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { RotateCw } from "lucide-react";
import { TICKS_PER_SECOND, type MediaTime } from "@kneecap/editor-core";
import { useEditor } from "@kneecap/editor-core/react";
import { isVisualElement, type ElementRef, type TimelineElement } from "@kneecap/editor-core/timeline";
import type { ParamValues } from "@kneecap/editor-core/params";
import { getVisibleElementsWithBounds } from "@kneecap/editor-core/preview/element-bounds";
import {
	clipLocalTime,
	hasClipKeyframes,
	resolveClipValuesAtTime,
	snapLocalTimeToFrame,
	upsertClipAnimationValues,
	type ClipKeyframeValues,
} from "../../editor/keyframes";
import { useCurrentTimeSeconds, useSelectedElement } from "../../editor/use-live-editor";
import { getElement, selectElement } from "../../editor/actions";
import {
	clientToCanvas,
	cornerResizeFactor,
	elementHasHandles,
	handleRotation,
	selectionHandleLayout,
	topmostElementAt,
	tracksWithOnlyElement,
	withStickerSourceSizes,
	type PreviewBounds,
} from "../../editor/preview-geometry";
import { useElementSize } from "../../timeline/use-element-size";
import {
	CanvasRenderer,
	ensureGpu,
	type RendererBackend,
} from "@kneecap/editor-core/services/renderer/canvas-renderer";
import { buildScene } from "@kneecap/editor-core/services/renderer/scene-builder";
import type { RootNode } from "@kneecap/editor-core/services/renderer/nodes/root-node";

/** Starts the GPU once per process and never rejects (false: the preview
 *  draws with Canvas 2D). Do NOT import `initializeGpu` from `opencut-wasm`
 *  in this package: the bundle then holds a second wasm copy, the GPU starts
 *  in that copy, and the compositor (in editor-core's copy) throws "GPU
 *  context not initialized" on every editor open. editor-core starts it in
 *  its own copy. */
export function ensurePreviewGpu(): Promise<boolean> {
	return ensureGpu();
}

export function PreviewRenderer() {
	const [gpuSettled, setGpuSettled] = useState(false);

	useEffect(() => {
		let cancelled = false;
		// Wait for the GPU start (it has a time limit) so the renderer can
		// pick the GPU when there is one; else it draws with Canvas 2D.
		void ensureGpu().then(() => {
			if (!cancelled) setGpuSettled(true);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	if (!gpuSettled) return null;
	return (
		<PreviewErrorBoundary>
			<PreviewRendererInner />
		</PreviewErrorBoundary>
	);
}

/** A preview failure must not close the editor: log it and show only the
 *  stage background. The rest of the editor keeps working. */
class PreviewErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch(error: unknown) {
		console.error("preview failed:", error);
	}

	render() {
		return this.state.failed ? null : this.props.children;
	}
}

function PreviewRendererInner() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	// Render tracks = preview-overlay tracks + main-track transitions applied
	// (memoized in the manager, so this snapshot is referentially stable).
	const tracks = useEditor(
		(e) => e.timeline.getRenderTracks() ?? e.scenes.getActiveScene().tracks,
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

	const lastFrameRef = useRef(-1);
	const lastTreeRef = useRef<RootNode | null>(null);
	const renderingRef = useRef(false);
	// Bumped when the renderer moves from the GPU to Canvas 2D, so the new
	// output canvas replaces the old one on screen.
	const [canvasVersion, setCanvasVersion] = useState(0);
	const mountedBackendRef = useRef<RendererBackend | null>(null);

	// Blind test round 4, item 3b: the mount's CSS width converts the handle offsets (CSS
	// px) to canvas px.
	const { ref: mountRef, width: mountWidth } = useElementSize<HTMLDivElement>();
	useEffect(() => {
		const mount = mountRef.current;
		if (!mount) return;
		const outputCanvas = renderer.getOutputCanvas();
		const backend = renderer.getBackend();
		mountedBackendRef.current = backend;
		editor.renderer.setDegraded(backend !== "gpu");
		console.info(`preview renderer: ${backend}`);
		outputCanvas.style.display = "block";
		outputCanvas.style.width = "100%";
		outputCanvas.style.height = "100%";
		mount.appendChild(outputCanvas);
		// Draw the current frame again into this canvas.
		lastFrameRef.current = -1;
		return () => {
			if (outputCanvas.parentElement === mount) {
				mount.removeChild(outputCanvas);
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `editor` is the process-wide singleton.
	}, [renderer, canvasVersion]);

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
				if (renderer.getBackend() !== mountedBackendRef.current) {
					setCanvasVersion((version) => version + 1);
				}
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

	const gestureHandlers = usePreviewTransformGesture({
		mountRef,
		canvasWidth: width,
		canvasHeight: height,
	});

	const { snapGuides, beginHandleGesture, ...pointerHandlers } = gestureHandlers;

	// Blind test round 4, item 3b: the selected sticker, shape, text or picture-in-picture
	// clip shows its box, four corner handles (resize) and one rotate handle. A child
	// component draws them: it follows the playhead, so only it re-renders on each
	// playback tick, and only while such an element is selected.
	const [selectedRef, selectedElement] = useSelectedElement();
	const showHandles =
		selectedRef !== null &&
		selectedElement !== null &&
		mountWidth > 0 &&
		elementHasHandles({ element: selectedElement, isMainTrack: tracks.main.id === selectedRef.trackId });

	return (
		<div
			ref={mountRef}
			className="cc-preview-stage__render"
			style={{ touchAction: "none" }}
			{...pointerHandlers}
		>
			{/* The detent has to be SEEN, not just felt: without a line on
			    screen a snapped element just looks like it stopped tracking
			    the finger. Drawn only while a drag holds the axis, and marked
			    inert so it can never intercept the gesture that spawned it. */}
			{snapGuides.x && (
				<div
					className="cc-preview-guide cc-preview-guide--v"
					aria-hidden="true"
				/>
			)}
			{snapGuides.y && (
				<div
					className="cc-preview-guide cc-preview-guide--h"
					aria-hidden="true"
				/>
			)}
			{showHandles && selectedRef && (
				<PreviewSelectionHandles
					selectedRef={selectedRef}
					tracks={tracks}
					mediaAssets={mediaAssets}
					canvasWidth={width}
					canvasHeight={height}
					mountWidth={mountWidth}
					beginHandleGesture={beginHandleGesture}
				/>
			)}
		</div>
	);
}

type BoundsInput = Parameters<typeof getVisibleElementsWithBounds>[0];

/**
 * Round 4, item 3b: the selection box, the four corner handles and the rotate handle of the
 * selected element. The bounds come from the render tracks (they follow a drag frame by
 * frame) at the playhead (useCurrentTimeSeconds re-renders this on each playback tick and
 * seek). Everything turns with the element.
 */
function PreviewSelectionHandles({
	selectedRef,
	tracks,
	mediaAssets,
	canvasWidth: width,
	canvasHeight: height,
	mountWidth,
	beginHandleGesture,
}: {
	selectedRef: ElementRef;
	tracks: BoundsInput["tracks"];
	mediaAssets: BoundsInput["mediaAssets"];
	canvasWidth: number;
	canvasHeight: number;
	mountWidth: number;
	beginHandleGesture: ReturnType<typeof usePreviewTransformGesture>["beginHandleGesture"];
}) {
	const editor = useEditor();
	useCurrentTimeSeconds();
	const selection = (() => {
		let bounds: PreviewBounds | null = null;
		try {
			const [item] = getVisibleElementsWithBounds({
				tracks: withStickerSourceSizes({ tracks: tracksWithOnlyElement({ tracks, ...selectedRef }) }),
				currentTime: editor.playback.getCurrentTime(),
				canvasSize: { width, height },
				mediaAssets,
			});
			bounds = item?.bounds ?? null;
		} catch (error) {
			console.error("preview selection bounds failed:", error);
		}
		if (!bounds) return null;
		const layout = selectionHandleLayout({
			bounds,
			canvasWidth: width,
			canvasHeight: height,
			rotateOffset: (ROTATE_HANDLE_OFFSET_CSS_PX * width) / mountWidth,
		});
		return { bounds, layout };
	})();
	if (!selection) return null;
	/** A box centred on a canvas point, in % of the mount (the mount is the canvas box). */
	const atCanvasPoint = ({ x, y, rotation }: { x: number; y: number; rotation: number }): CSSProperties => ({
		left: `${(x / width) * 100}%`,
		top: `${(y / height) * 100}%`,
		transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
	});

	return (
		<>
			<div
				className="cc-preview-selection"
				aria-hidden="true"
				style={{
					...atCanvasPoint({ x: selection.bounds.cx, y: selection.bounds.cy, rotation: selection.bounds.rotation }),
					width: `${(Math.abs(selection.bounds.width) / width) * 100}%`,
					height: `${(Math.abs(selection.bounds.height) / height) * 100}%`,
				}}
			/>
			{selection.layout.corners.map(({ corner, x, y }) => (
				<div
					key={corner}
					className={`cc-preview-handle cc-preview-handle--resize cc-preview-handle--${corner}`}
					data-handle={corner}
					aria-hidden="true"
					style={atCanvasPoint({ x, y, rotation: selection.bounds.rotation })}
					onPointerDown={(event) => beginHandleGesture({ event, kind: "resize", bounds: selection.bounds })}
				>
					<span className="cc-preview-handle__dot" />
				</div>
			))}
			<div
				className={`cc-preview-handle cc-preview-handle--rotate cc-preview-handle--rotate-${selection.layout.rotate.side}`}
				data-handle="rotate"
				aria-hidden="true"
				style={atCanvasPoint({ x: selection.layout.rotate.x, y: selection.layout.rotate.y, rotation: selection.bounds.rotation })}
				onPointerDown={(event) => beginHandleGesture({ event, kind: "rotate", bounds: selection.bounds })}
			>
				<span className="cc-preview-handle__dot">
					<RotateCw size={12} strokeWidth={2.5} />
				</span>
			</div>
		</>
	);
}

/** Item 3b: how far (CSS px) the rotate handle sits out from the element's top edge. */
const ROTATE_HANDLE_OFFSET_CSS_PX = 30;
/** Item 3b: the smallest drawn side (CSS px on the preview) that a corner drag can make. */
const MIN_HANDLE_RESIZE_CSS_PX = 24;

/**
 * SELECTION-GATED manipulation on the preview (round 23, founder: "maybe
 * this is bc video is hyper sensitive, how about these things are only
 * adjustable if they are selected in the timeline") — this supersedes
 * round 18's direct-grab hit-testing, which made the full-frame video
 * swallow every touch and left text/captions practically unreachable.
 *
 * The rule is one line: preview drags and pinches apply to the element
 * currently selected in the TIMELINE, and only then. One finger moves
 * (`transform.positionX/Y`, canvas units), two fingers pinch to scale
 * (`transform.scaleX/Y`) anywhere on the preview. Nothing selected →
 * touches do nothing at all (stage tap-to-play was REMOVED 2026-08-22:
 * the toggle also fired on the pointer-up ending a gesture — releasing a
 * caption resize started playback; play/pause is the PlaybackBar button
 * only).
 *
 * CAPTIONS MOVE AS ONE (round 23, founder: "if i can move one caption it
 * should move all of it around to same position and sizing — sync all
 * caption sizing and positioning"): when the selected element is a
 * caption, the session fans the same transform out to EVERY caption
 * element, and the commit lands them all in one undo step.
 *
 * Mid-gesture frames ride the engine's preview overlay
 * (`timeline.previewElements`); release commits ONE undoable
 * TracksSnapshotCommand (`timeline.commitPreview`). Tap semantics: only
 * real drags swallow the up-event; plain taps bubble but nothing above
 * listens anymore (see the stage-tap removal note in the header).
 *
 * BLIND TEST ROUND 4 (1.0.8), item 2: the tester dragged on a flag sticker and the
 * selected text moved. Now the first finger selects the TOP-MOST visible element under
 * it (the order the preview draws: later tracks on top, captions on top of all;
 * `topmostElementAt`), and the drag moves that element. Text and captions are
 * hit-testable now (editor-core `getVisibleElementsWithBounds` measures them). A touch
 * on empty canvas keeps the selection-gated rule above. Pinch (a second finger) and the
 * item 3b handles act on the selected element.
 *
 * Item 3b: a corner handle resizes the selected element uniformly about its centre, and
 * the rotate handle turns it. They use the same preview overlay + one commit, so one
 * handle drag is one undo step, the same as a pinch.
 */
const DRAG_SLOP_PX = 6;

type GestureMode = "move" | "resize" | "rotate";

/** One element a preview gesture writes to: the selection, or every caption
 *  when a caption is selected (they move as one). Round 47: a target that
 *  already has clip keyframes is `keyed` — the gesture then writes a
 *  keyframe at the playhead (auto-add once a clip is keyed) instead
 *  of the base params, which the animation would override anyway. */
interface GestureTarget {
	trackId: string;
	elementId: string;
	/** PRE-gesture element: every frame's params/animations build from it. */
	element: TimelineElement;
	keyed: boolean;
	/** Frame-snapped clip-local playhead at gesture start. */
	localTime: MediaTime;
	/** The keyframe group's values at `localTime` — the drag anchors here
	 *  (so a keyed clip is grabbed where it IS at this time, not at its base
	 *  params) and rotate/opacity ride along unchanged so the keyframe the
	 *  drag writes is complete. */
	baseValues: ClipKeyframeValues;
}

function usePreviewTransformGesture({
	mountRef,
	canvasWidth,
	canvasHeight,
}: {
	mountRef: RefObject<HTMLDivElement | null>;
	canvasWidth: number;
	canvasHeight: number;
}) {
	const editor = useEditor();
	const [selectedRef, selectedElement] = useSelectedElement();
	/** Which centre lines to draw. React state (not the session ref) because
	 *  this one piece of gesture state has to reach the render. */
	const [snapGuides, setSnapGuides] = useState<AxisSnapFlags>(NO_SNAP);

	// Anchor values are the element's transform at the LAST pointer-topology
	// change (gesture start, finger added, finger lifted); deltas are always
	// measured from the geometry captured at that same moment, so adding or
	// removing a finger never makes the element jump.
	const sessionRef = useRef<{
		pointers: Map<number, { x: number; y: number }>;
		startCentroid: { x: number; y: number };
		startDistance: number | null;
		anchorPositionX: number;
		anchorPositionY: number;
		anchorScaleX: number;
		anchorScaleY: number;
		dragging: boolean;
		/** Which axes are currently held by the centre-line detent. Lives on
		 *  the session because the snap decision is hysteretic: it depends on
		 *  whether the axis was ALREADY snapped a frame ago. */
		snapped: AxisSnapFlags;
		/** The selection alone, or every caption in the scene when a caption
		 *  is selected — the shared transform fans out to all of them per
		 *  frame, each written its own way (params vs keyframe). */
		targets: GestureTarget[];
		/** "move": one finger drags, two fingers pinch. "resize" / "rotate": a handle
		 *  drag (round 4, item 3b), one finger only. */
		mode: GestureMode;
		/** The rotation at the start of the gesture (a rotate-handle drag changes it). */
		anchorRotate: number;
		/** Handle drags: the element centre (client px) and the element's drawn size
		 *  (canvas px) at the start. */
		handle: { center: { x: number; y: number }; startWidth: number; startHeight: number } | null;
	} | null>(null);

	const centroidAndDistance = (pointers: Map<number, { x: number; y: number }>) => {
		const points = [...pointers.values()];
		const centroid = {
			x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
			y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
		};
		const distance =
			points.length >= 2
				? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
				: null;
		return { centroid, distance };
	};

	const pxToCanvas = () => {
		const rect = mountRef.current?.getBoundingClientRect();
		// The mount is rendered at the canvas's own aspect ratio (PreviewStage
		// sizes it), so one uniform factor maps CSS px -> canvas units.
		return rect && rect.width > 0 ? canvasWidth / rect.width : 0;
	};

	type Session = NonNullable<typeof sessionRef.current>;

	/**
	 * The element's effective transform under the current pointer deltas,
	 * with the centre-axis detent applied.
	 *
	 * The snap is applied HERE rather than at commit time on purpose: the
	 * whole point is that the element visibly leaves the finger and sits on
	 * the axis during the drag. Snapping only on release would land in the
	 * same place while showing the user nothing.
	 */
	const currentTransform = (session: Session) => {
		const scale = pxToCanvas();
		const { centroid, distance } = centroidAndDistance(session.pointers);
		if (session.mode !== "move" && session.handle) {
			// Item 3b: a handle drag. The position stays; resize scales both axes by the same
			// factor (about the centre), rotate turns about the centre.
			const start = session.startCentroid;
			const factor =
				session.mode === "resize"
					? cornerResizeFactor({
							center: session.handle.center,
							start,
							current: centroid,
							startWidth: session.handle.startWidth,
							startHeight: session.handle.startHeight,
							minSizePx: MIN_HANDLE_RESIZE_CSS_PX * scale,
						})
					: 1;
			return {
				positionX: session.anchorPositionX,
				positionY: session.anchorPositionY,
				scaleX: session.anchorScaleX * factor,
				scaleY: session.anchorScaleY * factor,
				rotate:
					session.mode === "rotate"
						? handleRotation({
								center: session.handle.center,
								start,
								current: centroid,
								startRotation: session.anchorRotate,
							})
						: session.anchorRotate,
				snapped: NO_SNAP,
			};
		}
		const factor =
			distance !== null && session.startDistance && session.startDistance > 0
				? distance / session.startDistance
				: 1;
		const rawX = session.anchorPositionX + (centroid.x - session.startCentroid.x) * scale;
		const rawY = session.anchorPositionY + (centroid.y - session.startCentroid.y) * scale;
		// Thresholds are authored in CSS px and converted with the same
		// px -> canvas factor the drag itself uses, so the detent is the same
		// physical size on any preview size or project resolution.
		const snap = snapToCenterAxes({
			x: rawX,
			y: rawY,
			wasSnapped: session.snapped,
			capture: SNAP_CAPTURE_PX * scale,
			release: SNAP_RELEASE_PX * scale,
		});
		return {
			positionX: snap.x,
			positionY: snap.y,
			scaleX: session.anchorScaleX * factor,
			scaleY: session.anchorScaleY * factor,
			rotate: session.anchorRotate,
			snapped: snap.snapped,
		};
	};

	/** Re-anchor after a finger joins/leaves: bank the current transform and
	 *  restart deltas from the new pointer geometry. */
	const reanchor = (session: Session) => {
		const current = currentTransform(session);
		session.anchorPositionX = current.positionX;
		session.anchorPositionY = current.positionY;
		session.anchorScaleX = current.scaleX;
		session.anchorScaleY = current.scaleY;
		const { centroid, distance } = centroidAndDistance(session.pointers);
		session.startCentroid = centroid;
		session.startDistance = distance;
	};

	const applySessionUpdate = () => {
		const session = sessionRef.current;
		if (!session || session.pointers.size === 0 || pxToCanvas() === 0) return;
		const current = currentTransform(session);
		// Feedback fires on the RISING edge only — a tick every frame while
		// the element rides the line would be a buzz, not a detent.
		if (
			(current.snapped.x && !session.snapped.x) ||
			(current.snapped.y && !session.snapped.y)
		) {
			pulseSnapHaptic();
		}
		session.snapped = current.snapped;
		setSnapGuides(current.snapped);
		// A move or resize writes position + scale (as before); a rotate-handle drag writes
		// only the rotation.
		const transformPatch: Partial<ClipKeyframeValues> =
			session.mode === "rotate"
				? { "transform.rotate": current.rotate }
				: {
						"transform.positionX": current.positionX,
						"transform.positionY": current.positionY,
						"transform.scaleX": current.scaleX,
						"transform.scaleY": current.scaleY,
					};
		editor.timeline.previewElements({
			updates: session.targets.map((t) => ({
				trackId: t.trackId,
				elementId: t.elementId,
				updates: t.keyed
					? {
							// Auto-keyframe: the whole group at the playhead, built
							// from the PRE-gesture animations so re-writing the same
							// time every frame replaces one key instead of stacking.
							animations: upsertClipAnimationValues({
								element: t.element,
								localTime: t.localTime,
								values: { ...t.baseValues, ...transformPatch },
							}),
						}
					: { params: { ...t.element.params, ...(transformPatch as ParamValues) } },
			})),
		});
	};

	const endSession = (commit: boolean) => {
		const session = sessionRef.current;
		if (!session) return null;
		sessionRef.current = null;
		setSnapGuides(NO_SNAP);
		if (session.dragging && commit) {
			editor.timeline.commitPreview();
		} else if (session.dragging) {
			editor.timeline.discardPreview();
		}
		return session;
	};

	/** Snapshot one element as a gesture target at the current playhead. */
	const makeTarget = ({ trackId, element }: { trackId: string; element: TimelineElement }): GestureTarget => {
		const localTime = snapLocalTimeToFrame({
			localTime: clipLocalTime({ element, timelineTime: editor.playback.getCurrentTime() }),
			fps: editor.project.getActive().settings.fps,
			duration: element.duration,
		});
		return {
			trackId,
			elementId: element.id,
			element,
			keyed: hasClipKeyframes({ animations: element.animations }),
			localTime,
			baseValues: resolveClipValuesAtTime({ element, localTime }),
		};
	};

	/** All caption elements in the active scene — the "captions move as one"
	 *  fan-out list. */
	const collectCaptionFanout = (): GestureTarget[] => {
		const tracks = editor.scenes.getActiveScene().tracks;
		const out: GestureTarget[] = [];
		for (const track of tracks.overlay) {
			if (track.type !== "caption") continue;
			for (const element of track.elements) {
				if (element.type === "caption") {
					out.push(makeTarget({ trackId: track.id, element }));
				}
			}
		}
		return out;
	};

	const openSession = ({
		pointers,
		element,
		target,
		isCaption,
		mode = "move",
		handle = null,
	}: {
		pointers: Map<number, { x: number; y: number }>;
		element: TimelineElement;
		target: { trackId: string; elementId: string };
		isCaption: boolean;
		mode?: GestureMode;
		handle?: Session["handle"];
	}) => {
		const { centroid, distance } = centroidAndDistance(pointers);
		const targets = isCaption ? collectCaptionFanout() : [];
		if (!targets.some((t) => t.elementId === target.elementId)) {
			targets.unshift(makeTarget({ trackId: target.trackId, element }));
		}
		const primary = targets.find((t) => t.elementId === target.elementId) ?? targets[0];
		// Anchor on the RESOLVED values: for a keyed clip that is where the
		// element is at the playhead (grabbing it must not snap it back to its
		// base params); for an un-keyed clip it equals the params/defaults.
		sessionRef.current = {
			pointers,
			startCentroid: centroid,
			startDistance: distance,
			anchorPositionX: primary.baseValues["transform.positionX"],
			anchorPositionY: primary.baseValues["transform.positionY"],
			anchorScaleX: primary.baseValues["transform.scaleX"],
			anchorScaleY: primary.baseValues["transform.scaleY"],
			dragging: false,
			snapped: NO_SNAP,
			targets,
			mode,
			anchorRotate: primary.baseValues["transform.rotate"],
			handle,
		};
	};

	/** Round 4, item 2: the top-most visible element under a touch (client px), as the
	 *  NOMINAL scene element (the one commands and the gesture write to), or null on
	 *  empty canvas. The bounds come from the render tracks at the playhead: what is on
	 *  the screen. */
	const pickElementAt = (point: { x: number; y: number }): { ref: ElementRef; element: TimelineElement } | null => {
		const rect = mountRef.current?.getBoundingClientRect();
		if (!rect) return null;
		const at = clientToCanvas({ clientX: point.x, clientY: point.y, rect, canvasWidth, canvasHeight });
		const tracks = editor.timeline.getRenderTracks() ?? editor.scenes.getActiveSceneOrNull()?.tracks ?? null;
		if (!at || !tracks) return null;
		try {
			const painted = getVisibleElementsWithBounds({
				tracks: withStickerSourceSizes({ tracks }),
				currentTime: editor.playback.getCurrentTime(),
				canvasSize: { width: canvasWidth, height: canvasHeight },
				mediaAssets: editor.media.getAssets(),
			});
			const hit = topmostElementAt({
				bottomToTop: painted.map((item) => ({ ...item, isCaption: item.element.type === "caption" })),
				x: at.x,
				y: at.y,
			});
			if (!hit) return null;
			const ref = { trackId: hit.trackId, elementId: hit.elementId };
			const element = getElement({ editor, ref });
			return element && isVisualElement(element) ? { ref, element } : null;
		} catch (error) {
			// A failed measure must not kill the touch: it falls back to the selection.
			console.error("preview hit test failed:", error);
			return null;
		}
	};

	const selectionIsManipulable =
		selectedRef !== null &&
		selectedElement !== null &&
		isVisualElement(selectedElement);

	const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
		const point = { x: event.clientX, y: event.clientY };
		const existing = sessionRef.current;
		if (existing) {
			// A handle drag is one finger; another finger does not change it.
			if (existing.mode !== "move") return;
			existing.pointers.set(event.pointerId, point);
			reanchor(existing);
			return;
		}

		// Round 4, item 2: the touch selects the top-most element under the finger, and
		// the drag moves THAT element (not the one selected before).
		const picked = pickElementAt(point);
		if (picked) {
			if (selectedRef?.trackId !== picked.ref.trackId || selectedRef?.elementId !== picked.ref.elementId) {
				selectElement({ editor, ref: picked.ref });
			}
			openSession({
				pointers: new Map([[event.pointerId, point]]),
				element: picked.element,
				target: picked.ref,
				isCaption: picked.element.type === "caption",
			});
			return;
		}

		// Empty canvas (no element under the finger): unchanged. Selection-gated: a touch
		// only manipulates the element selected in the timeline. No selection → the touch is
		// fully inert (the stage has no tap handler anymore — see the header note).
		if (selectionIsManipulable && selectedRef && selectedElement) {
			openSession({
				pointers: new Map([[event.pointerId, point]]),
				element: selectedElement,
				target: selectedRef,
				isCaption: selectedElement.type === "caption",
			});
		}
	};

	return {
		snapGuides,
		onPointerDown,
		/** Round 4, item 3b: a finger down on a corner handle ("resize") or on the rotate
		 *  handle ("rotate") of the selected element. `bounds` is the element's drawn box
		 *  (canvas px) that the handles show. The mount takes the pointer, so the drag goes
		 *  on when the finger leaves the small handle. */
		beginHandleGesture: ({
			event,
			kind,
			bounds,
		}: {
			event: ReactPointerEvent<HTMLElement>;
			kind: "resize" | "rotate";
			bounds: PreviewBounds;
		}) => {
			// The mount's own pointer-down must not pick the element under the handle.
			event.stopPropagation();
			if (sessionRef.current) {
				// A second finger on a handle during a pinch: it is part of the pinch.
				onPointerDown(event);
				return;
			}
			const mount = mountRef.current;
			const rect = mount?.getBoundingClientRect();
			if (!mount || !rect || !(rect.width > 0) || !selectedRef || !selectedElement) return;
			if (!isVisualElement(selectedElement)) return;
			openSession({
				pointers: new Map([[event.pointerId, { x: event.clientX, y: event.clientY }]]),
				element: selectedElement,
				target: selectedRef,
				isCaption: false,
				mode: kind,
				handle: {
					center: {
						x: rect.left + (bounds.cx * rect.width) / canvasWidth,
						y: rect.top + (bounds.cy * rect.height) / canvasHeight,
					},
					startWidth: bounds.width,
					startHeight: bounds.height,
				},
			});
			try {
				mount.setPointerCapture(event.pointerId);
			} catch {
				// Best-effort, as in onPointerMove below.
			}
		},
		onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
			const session = sessionRef.current;
			if (!session || !session.pointers.has(event.pointerId)) return;
			session.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (!session.dragging) {
				const { centroid } = centroidAndDistance(session.pointers);
				const moved = Math.hypot(
					centroid.x - session.startCentroid.x,
					centroid.y - session.startCentroid.y,
				);
				if (moved < DRAG_SLOP_PX && session.pointers.size < 2) return;
				session.dragging = true;
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch {
					// Defensive: an invalid/stale pointerId (synthetic events,
					// odd webview states) must not kill the drag — capture is
					// an optimization, not a correctness requirement.
				}
			}
			applySessionUpdate();
		},
		onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
			const session = sessionRef.current;
			if (!session || !session.pointers.has(event.pointerId)) return;
			session.pointers.delete(event.pointerId);
			if (session.pointers.size > 0) {
				if (session.mode === "move") reanchor(session);
				return;
			}
			const ended = endSession(true);
			// Only a real drag swallows the up-event; a plain tap (session
			// opened but never moved) bubbles — harmlessly, now that the
			// stage has no tap-to-play handler.
			if (ended?.dragging) {
				event.stopPropagation();
			}
		},
		onPointerCancel: () => {
			endSession(false);
		},
	};
}
