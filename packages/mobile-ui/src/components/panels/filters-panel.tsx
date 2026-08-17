import { useEffect } from "react";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { ChipRow } from "../chip-row";
import { ParamRow } from "../editor/param-row";
import type { EditorCore } from "@kneecap/editor-core";
import type { ElementRef, VisualElement } from "@kneecap/editor-core/timeline";
import { FILTER_EFFECT_TYPE, FILTER_PRESETS } from "@kneecap/editor-core/effects/definitions/filter";
import { ensureSingleEffect, updateEffectParam } from "../../editor/actions";

interface FiltersPanelProps {
	editor: EditorCore;
	elementRef: ElementRef;
	element: VisualElement;
	onClose: () => void;
}

/**
 * M8 Filters panel — corpus 04 §3.7: "categorized [filters]... an
 * intensity slider." Backed by the real `filter` `EffectDefinition`.
 * Same "derive from the live prop, don't setState in the effect" shape as
 * adjust-panel.tsx — see that file's header comment for why.
 */
export function FiltersPanel({ editor, elementRef, element, onClose }: FiltersPanelProps) {
	const effect = element.effects?.find((e) => e.type === FILTER_EFFECT_TYPE);

	useEffect(() => {
		if (!element.effects?.some((e) => e.type === FILTER_EFFECT_TYPE)) {
			ensureSingleEffect({ editor, ref: elementRef, effectType: FILTER_EFFECT_TYPE });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor, elementRef.trackId, elementRef.elementId]);

	const rawPreset = effect?.params.preset;
	const preset = typeof rawPreset === "string" ? rawPreset : "none";
	const rawIntensity = effect?.params.intensity;
	const intensity = typeof rawIntensity === "number" ? rawIntensity : 100;

	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			{!effect && <p className="cc-panel-note">Setting up filters…</p>}
			{effect && (
				<>
					<ChipRow
						chips={FILTER_PRESETS.map((p) => ({ id: p.value, label: p.label }))}
						activeIds={[preset]}
						onSelect={(value) => updateEffectParam({ editor, ref: elementRef, effectId: effect.id, key: "preset", value })}
					/>
					<ParamRow
						label="Intensity"
						value={intensity}
						min={0}
						max={100}
						step={1}
						onChange={(value) => updateEffectParam({ editor, ref: elementRef, effectId: effect.id, key: "intensity", value })}
					/>
				</>
			)}
		</PanelSheet>
	);
}
