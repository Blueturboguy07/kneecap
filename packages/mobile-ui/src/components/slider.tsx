import { Slider as SliderPrimitive } from "radix-ui";
import { cn } from "../lib/cn";

interface CcSliderProps {
	value: number;
	min?: number;
	max?: number;
	step?: number;
	onChange: (value: number) => void;
	"aria-label": string;
	className?: string;
	disabled?: boolean;
}

/**
 * A thin cyan-filled track + circular thumb, matching every slider-shaped
 * control implied across the corpus (Filters intensity, §3.7; Volume, Fade,
 * Speed, §3.2/4.1/4.3; Overlay opacity, §3.5) — none of which were
 * screenshotted directly, so exact track thickness/thumb size are the same
 * DESIGN DECISION tier as the rest of this kit's un-measurable metrics, not
 * a pixel read. Built on radix-ui's Slider primitive, same import as
 * apps/web/src/components/ui/slider.tsx, restyled with plain CSS classes
 * instead of Tailwind (see components.css header for why).
 */
export function CcSlider({
	value,
	min = 0,
	max = 100,
	step = 1,
	onChange,
	className,
	disabled,
	...rest
}: CcSliderProps) {
	return (
		<SliderPrimitive.Root
			className={cn("cc-slider", className)}
			value={[value]}
			min={min}
			max={max}
			step={step}
			disabled={disabled}
			onValueChange={([v]) => onChange(v)}
			{...rest}
		>
			<SliderPrimitive.Track className="cc-slider__track">
				<SliderPrimitive.Range className="cc-slider__range" />
			</SliderPrimitive.Track>
			<SliderPrimitive.Thumb className="cc-slider__thumb" />
		</SliderPrimitive.Root>
	);
}
