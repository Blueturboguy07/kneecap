import { cn } from "../lib/cn";

interface ProgressOverlayProps {
	/** 0-100. */
	percent: number;
	label: string;
	onCancel?: () => void;
	className?: string;
}

const RADIUS = 40;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Full-bleed export/transcode progress overlay. [NEEDS-CAPTURE]: no
 * screenshot in the corpus shows CapCut's actual export-in-progress
 * treatment (corpus 04 §5 flags the whole mobile export sheet as thinly
 * documented). This is a generic, functionally-reasonable circular-progress
 * placeholder built from this kit's own tokens, not a CapCut measurement.
 */
export function ProgressOverlay({ percent, label, onCancel, className }: ProgressOverlayProps) {
	const clamped = Math.max(0, Math.min(100, percent));
	const offset = CIRCUMFERENCE * (1 - clamped / 100);
	return (
		<div className={cn("cc-progress-overlay", className)} role="alertdialog" aria-label={label}>
			<svg width={96} height={96} viewBox="0 0 96 96">
				<circle
					cx="48"
					cy="48"
					r={RADIUS}
					fill="none"
					stroke="var(--cc-bg-raised)"
					strokeWidth={6}
				/>
				<circle
					cx="48"
					cy="48"
					r={RADIUS}
					fill="none"
					stroke="var(--cc-accent)"
					strokeWidth={6}
					strokeLinecap="round"
					strokeDasharray={CIRCUMFERENCE}
					strokeDashoffset={offset}
					transform="rotate(-90 48 48)"
				/>
				<text
					x="48"
					y="54"
					textAnchor="middle"
					className="cc-progress-overlay__percent"
					fill="var(--cc-text-primary)"
				>
					{Math.round(clamped)}%
				</text>
			</svg>
			<span className="cc-progress-overlay__label">{label}</span>
			{onCancel && (
				<button type="button" className="cc-progress-overlay__cancel" onClick={onCancel}>
					Cancel
				</button>
			)}
		</div>
	);
}
