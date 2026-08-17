import { ArrowLeft, Redo2, Undo2 } from "lucide-react";
import { CC_ICON_STROKE } from "../../tokens";
import { ExportButton } from "../export-button";
import { cn } from "../../lib/cn";

interface TopBarProps {
	title: string;
	onBack?: () => void;
	onUndo?: () => void;
	onRedo?: () => void;
	canUndo?: boolean;
	canRedo?: boolean;
	onExport?: () => void;
	className?: string;
}

/**
 * Plan M8 item 1: "top bar (back, undo, redo, export at top-right —
 * undo/redo are tap-repeatable single-step)." Undo/redo call
 * `editor.command.undo()`/`redo()` directly on every tap — no batching, no
 * dedicated history panel — matching "tap-repeatable single-step."
 */
export function TopBar({ title, onBack, onUndo, onRedo, canUndo, canRedo, onExport, className }: TopBarProps) {
	return (
		<div className={cn("cc-topbar", className)}>
			<button type="button" className="cc-topbar__icon-btn" onClick={onBack} aria-label="Back">
				<ArrowLeft size={22} strokeWidth={CC_ICON_STROKE} />
			</button>
			<span className="cc-topbar__title">{title}</span>
			<div className="cc-topbar__right">
				<button
					type="button"
					className="cc-topbar__icon-btn"
					onClick={onUndo}
					disabled={!canUndo}
					aria-label="Undo"
				>
					<Undo2 size={20} strokeWidth={CC_ICON_STROKE} />
				</button>
				<button
					type="button"
					className="cc-topbar__icon-btn"
					onClick={onRedo}
					disabled={!canRedo}
					aria-label="Redo"
				>
					<Redo2 size={20} strokeWidth={CC_ICON_STROKE} />
				</button>
				<ExportButton onClick={() => onExport?.()} />
			</div>
		</div>
	);
}
