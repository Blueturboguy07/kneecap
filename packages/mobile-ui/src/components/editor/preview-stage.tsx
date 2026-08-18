import type { CSSProperties } from "react";
import { cn } from "../../lib/cn";

interface PreviewStageProps {
	canvasWidth: number;
	canvasHeight: number;
	backgroundColor: string;
	children?: React.ReactNode;
	className?: string;
}

/**
 * Plan M8 item 1: "preview canvas at project aspect ratio." Plan M8 item 6
 * says preview should render "through the existing CanvasRenderer ->
 * wasmCompositor path unchanged" — that compositor requires the
 * `opencut-wasm` wgpu module to actually initialize inside a webview
 * (`services/renderer/canvas-renderer.ts`'s `wasmCompositor`), which is a
 * rendering-engine integration, not panel/toolbar UI wiring. Wiring a live
 * GPU-composited preview into this NEW mobile dev harness is out of scope
 * for M8 — this is a chrome-only placeholder that reflects REAL project
 * state (aspect ratio + background color both read live off
 * `project.settings`), not a static mockup, but it does not render frame
 * content. Closing this gap is tracked for whoever owns preview
 * integration next.
 *
 * Fixer pass: `--cc-preview-ratio` is a CSS custom property carrying the
 * SAME ratio as the inline `aspect-ratio` below, consumed by
 * `.cc-preview-stage__canvas`'s `width`/`height` in components.css via
 * `cqw`/`cqh` container-query units. This isn't decorative — plain
 * `aspect-ratio` on a non-replaced box with no other definite dimension
 * renders 0x0 (verified live: an empty div with only `aspect-ratio` +
 * `max-width`/`max-height` measures `{w:0,h:0}`, reproduced in isolation
 * outside this component too), and giving it a definite height via flex
 * stretch instead just trades that for a DIFFERENT bug — flexbox shrinks
 * an aspect-ratio item's main-axis size to fit without re-deriving the
 * (now stretched-definite) cross-axis size from the ratio, silently
 * distorting it (also verified live, isolated: a 300x200 flex-centered
 * parent with a `height:100%; aspect-ratio:16/9` child renders at
 * 300x200, ratio 1.5, not 1.778). See components.css's own comment on
 * `.cc-preview-stage` / `.cc-preview-stage__canvas` for the full
 * before/after measurements.
 */
export function PreviewStage({ canvasWidth, canvasHeight, backgroundColor, children, className }: PreviewStageProps) {
	const aspectRatio = canvasWidth / canvasHeight;
	return (
		<div className={cn("cc-preview-stage", className)}>
			<div
				className="cc-preview-stage__canvas"
				style={
					{
						aspectRatio,
						background: backgroundColor,
						"--cc-preview-ratio": aspectRatio,
					} as CSSProperties
				}
			>
				{children}
			</div>
		</div>
	);
}
