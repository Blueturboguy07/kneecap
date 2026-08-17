import { cn } from "../lib/cn";

export interface ChipDef {
	id: string;
	label: string;
}

interface ChipRowProps {
	chips: ChipDef[];
	activeIds?: string[];
	onSelect?: (id: string) => void;
	className?: string;
}

/**
 * Horizontal pill-chip filter row — corpus 04 §3.3: "filter chips
 * Trending | Title | Social media | Vlog | Fo[od?]…" inside the Text ->
 * Templates tab. Active chips use --cc-bg-raised, never --cc-text-secondary
 * (see tokens.ts's contrast-audit comment for why).
 */
export function ChipRow({ chips, activeIds = [], onSelect, className }: ChipRowProps) {
	return (
		<div className={cn("cc-chiprow", className)}>
			{chips.map((chip) => {
				const active = activeIds.includes(chip.id);
				return (
					<button
						key={chip.id}
						type="button"
						className={cn("cc-chip", active && "cc-chip--active")}
						aria-pressed={active}
						onClick={() => onSelect?.(chip.id)}
					>
						{chip.label}
					</button>
				);
			})}
		</div>
	);
}
