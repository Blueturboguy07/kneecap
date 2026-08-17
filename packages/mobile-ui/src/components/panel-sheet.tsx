import type { ReactNode } from "react";
import { cn } from "../lib/cn";

interface PanelSheetProps {
	children: ReactNode;
	header?: ReactNode;
	onScrimClick?: () => void;
	className?: string;
}

/**
 * The bottom sheet every CapCut mobile tool panel opens as (Text, Effects,
 * Filters, Captions style-picker, Transitions...). Generously rounded top
 * corners per --cc-radius-sheet (corpus 06 §5, [NEEDS-CAPTURE] exact
 * value — see tokens.css header for why this session couldn't isolate a
 * trustworthy number from the marketing screenshots).
 *
 * The scrim is deliberately `position: fixed; inset: 0` (see
 * components.css), so it covers the entire real viewport — not just this
 * component's own local container. That's correct for the real app (a
 * full-screen mobile editor, where a modal sheet should dim everything
 * behind it, top bar included). It's only visible as a gotcha inside a
 * demo harness that renders a fixed-size "phone frame" box smaller than
 * the real browser viewport (apps/web/src/app/dev/mobile-ui/page.tsx):
 * the scrim will visually dim content OUTSIDE that demo box too, because
 * there is no real viewport boundary to clip it to outside a real device.
 * Verified in-browser this session — do not "fix" this into
 * `position: absolute` without re-checking that assumption.
 */
export function PanelSheet({ children, header, onScrimClick, className }: PanelSheetProps) {
	return (
		<>
			<div className="cc-sheet-scrim" onClick={onScrimClick} aria-hidden="true" />
			<div className={cn("cc-sheet", className)} role="dialog" aria-modal="true">
				{header}
				<div className="cc-sheet__body">{children}</div>
			</div>
		</>
	);
}
