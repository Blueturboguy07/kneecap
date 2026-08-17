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
 */
export function PreviewStage({ canvasWidth, canvasHeight, backgroundColor, children, className }: PreviewStageProps) {
	const aspectRatio = canvasWidth / canvasHeight;
	return (
		<div className={cn("cc-preview-stage", className)}>
			<div className="cc-preview-stage__canvas" style={{ aspectRatio, background: backgroundColor }}>
				{children}
			</div>
		</div>
	);
}
