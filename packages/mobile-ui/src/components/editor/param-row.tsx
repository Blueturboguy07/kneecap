import { CcSlider } from "../slider";
import { cn } from "../../lib/cn";

/** Narrows a `ParamValue`/`unknown` to `number` without an unsafe `as`
 *  cast — narrowing a freshly-bound local via `typeof` inside the ternary
 *  is what actually lets TS narrow it, an `as number` on a repeated
 *  property/index access does not. Shared by every panel that reads a
 *  numeric param off `element.params`/`effect.params`. */
export function readNumberParam({ raw, fallback }: { raw: unknown; fallback: number }): number {
	return typeof raw === "number" ? raw : fallback;
}

interface ParamRowProps {
	label: string;
	value: number;
	min?: number;
	max?: number;
	step?: number;
	onChange: (value: number) => void;
	formatValue?: (value: number) => string;
	className?: string;
}

/**
 * Shared label + slider + live numeric readout row, used by every
 * slider-driven M8 panel (Adjust's 7 sliders, Filter intensity, Overlay
 * opacity, Speed rate). One row = one real engine param write per drag
 * frame via the caller's `onChange`.
 */
export function ParamRow({ label, value, min = 0, max = 100, step = 1, onChange, formatValue, className }: ParamRowProps) {
	return (
		<div className={cn("cc-param-row", className)}>
			<div className="cc-param-row__head">
				<span className="cc-param-row__label">{label}</span>
				<span className="cc-param-row__value">{formatValue ? formatValue(value) : value}</span>
			</div>
			<CcSlider value={value} min={min} max={max} step={step} onChange={onChange} aria-label={label} />
		</div>
	);
}

interface ToggleRowProps {
	label: string;
	active: boolean;
	onToggle: () => void;
	className?: string;
}

/** Shared label + pill toggle row (Maintain Pitch, Reverse, effect enable). */
export function ToggleRow({ label, active, onToggle, className }: ToggleRowProps) {
	return (
		<button
			type="button"
			className={cn("cc-toggle-row", active && "cc-toggle-row--active", className)}
			onClick={onToggle}
			aria-pressed={active}
		>
			<span>{label}</span>
			<span className="cc-toggle-row__pill" aria-hidden="true">
				<span className="cc-toggle-row__pill-knob" />
			</span>
		</button>
	);
}
