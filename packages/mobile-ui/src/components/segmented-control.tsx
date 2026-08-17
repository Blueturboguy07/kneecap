import { cn } from "../lib/cn";

export interface SegmentDef {
	id: string;
	label: string;
}

interface SegmentedControlProps {
	segments: SegmentDef[];
	activeId: string;
	onSelect: (id: string) => void;
	className?: string;
	"aria-label": string;
}

/**
 * Pill-shaped multi-option switch — no direct screenshot evidence (corpus
 * 04 doesn't picture one), but structurally implied by every either/or
 * picker in the inventory (aspect-ratio §1.4, Speed "Normal vs Curve"
 * §4.1, transition duration bounds §2.1). Active segment fills with
 * --cc-accent per this kit's accent-usage convention everywhere else
 * (CTA button, tab underline).
 */
export function SegmentedControl({
	segments,
	activeId,
	onSelect,
	className,
	...rest
}: SegmentedControlProps) {
	return (
		<div className={cn("cc-segmented", className)} role="radiogroup" {...rest}>
			{segments.map((segment) => {
				const active = segment.id === activeId;
				return (
					<button
						key={segment.id}
						type="button"
						role="radio"
						aria-checked={active}
						className={cn("cc-segmented__option", active && "cc-segmented__option--active")}
						onClick={() => onSelect(segment.id)}
					>
						{segment.label}
					</button>
				);
			})}
		</div>
	);
}
