import { useEffect } from "react";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { ParamRow, readNumberParam } from "../editor/param-row";
import type { EditorCore } from "@kneecap/editor-core";
import type { ElementRef, VisualElement } from "@kneecap/editor-core/timeline";
import { ADJUST_EFFECT_TYPE } from "@kneecap/editor-core/effects/definitions/adjust";
import { ensureSingleEffect, updateEffectParam } from "../../editor/actions";

interface AdjustPanelProps {
	editor: EditorCore;
	elementRef: ElementRef;
	element: VisualElement;
	onClose: () => void;
}

const SLIDERS: Array<{ key: string; label: string; min: number; max: number }> = [
	{ key: "brightness", label: "Brightness", min: -100, max: 100 },
	{ key: "contrast", label: "Contrast", min: -100, max: 100 },
	{ key: "saturation", label: "Saturation", min: -100, max: 100 },
	{ key: "temperature", label: "Temperature", min: -100, max: 100 },
	{ key: "tint", label: "Tint", min: -100, max: 100 },
	{ key: "sharpen", label: "Sharpen", min: 0, max: 100 },
	{ key: "vignette", label: "Vignette", min: 0, max: 100 },
];

/**
 * M8 Adjust panel — task scope: "basic sliders ONLY: brightness/contrast/
 * saturation/temperature/tint/sharpen/vignette" (plan §8.0 item 4). Backed
 * by the real `adjust` `EffectDefinition` (`effects/definitions/adjust.ts`)
 * — every drag writes through `UpdateClipEffectParamsCommand`. See that
 * definition's header for the honest scope note: the state is real, the
 * GPU pass is not implemented yet, so the preview will not visibly change.
 *
 * `effect` is derived directly from the live `element` prop every render —
 * NOT held in local component state — so that after `ensureSingleEffect`'s
 * command executes, the next render (driven by `useSelectedElement`'s own
 * subscription to the engine) already reflects it with no extra setState
 * call needed inside the effect body.
 */
export function AdjustPanel({ editor, elementRef, element, onClose }: AdjustPanelProps) {
	const effect = element.effects?.find((e) => e.type === ADJUST_EFFECT_TYPE);

	useEffect(() => {
		if (!element.effects?.some((e) => e.type === ADJUST_EFFECT_TYPE)) {
			ensureSingleEffect({ editor, ref: elementRef, effectType: ADJUST_EFFECT_TYPE });
		}
		// Re-run only when the selected element changes, not on every effects
		// array mutation (that would re-check/re-add on our own writes).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor, elementRef.trackId, elementRef.elementId]);

	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			{!effect && <p className="cc-panel-note">Setting up adjustments…</p>}
			{effect &&
				SLIDERS.map((slider) => (
					<ParamRow
						key={slider.key}
						label={slider.label}
						value={readNumberParam({ raw: effect.params[slider.key], fallback: 0 })}
						min={slider.min}
						max={slider.max}
						step={1}
						onChange={(value) =>
							updateEffectParam({ editor, ref: elementRef, effectId: effect.id, key: slider.key, value })
						}
					/>
				))}
		</PanelSheet>
	);
}
