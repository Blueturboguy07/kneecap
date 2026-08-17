import type { ReactNode } from "react";
import { cn } from "../lib/cn";

interface ExportButtonProps {
	onClick: () => void;
	children?: ReactNode;
	disabled?: boolean;
	className?: string;
}

/**
 * The top-right export CTA — corpus 04 §2 anatomy: "← Back  [title]
 * Export" top bar. Solid --cc-accent fill (the real measured cyan,
 * #00CAE0 — corpus 06 §2.2, this session's own re-sampled confirmation)
 * with --cc-accent-contrast ink, WCAG-AA-checked in
 * src/__tests__/contrast-audit.test.ts.
 */
export function ExportButton({ onClick, children = "Export", disabled, className }: ExportButtonProps) {
	return (
		<button
			type="button"
			className={cn("cc-export-btn", className)}
			onClick={onClick}
			disabled={disabled}
		>
			{children}
		</button>
	);
}
