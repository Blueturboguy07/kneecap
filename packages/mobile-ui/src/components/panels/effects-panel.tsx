import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { ThumbnailGrid } from "../thumbnail-grid";
import { ParamRow, ToggleRow, readNumberParam } from "../editor/param-row";
import type { EditorCore } from "@kneecap/editor-core";
import type { ElementRef, VisualElement } from "@kneecap/editor-core/timeline";
import { effectsRegistry } from "@kneecap/editor-core/effects";
import { ADJUST_EFFECT_TYPE } from "@kneecap/editor-core/effects/definitions/adjust";
import { FILTER_EFFECT_TYPE } from "@kneecap/editor-core/effects/definitions/filter";
import {
	ensureSingleEffect,
	removeEffect,
	toggleEffectEnabled,
	updateEffectParam,
} from "../../editor/actions";

interface EffectsPanelProps {
	editor: EditorCore;
	elementRef: ElementRef;
	element: VisualElement;
	onClose: () => void;
}

/**
 * M8 Effects panel — corpus 04 §3.6. Adjust and Filter are modeled as
 * their own dedicated `EffectDefinition`s with their own panels (matching
 * how CapCut treats them as separate top-level tools, corpus 04 §3.7/§3.8)
 * so they're excluded from this generic list. Built directly off
 * `effectsRegistry` — currently just `blur` (ported from opencut-classic,
 * the only pre-existing effect with a real Rust WGSL pass), but this panel
 * renders whatever IS registered generically, param-by-param, rather than
 * hardcoding "blur" — a future-added effect needs no UI change here.
 */
export function EffectsPanel({ editor, elementRef, element, onClose }: EffectsPanelProps) {
	const catalog = effectsRegistry
		.getAll()
		.filter((def) => def.type !== ADJUST_EFFECT_TYPE && def.type !== FILTER_EFFECT_TYPE);
	const activeEffect = element.effects?.find((e) => catalog.some((def) => def.type === e.type));
	const activeDefinition = activeEffect ? effectsRegistry.get(activeEffect.type) : null;

	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			<ThumbnailGrid
				items={catalog.map((def) => ({ id: def.type, label: def.name }))}
				selectedId={activeEffect?.type ?? null}
				onSelect={(effectType) => {
					if (activeEffect && activeEffect.type === effectType) {
						removeEffect({ editor, ref: elementRef, effectId: activeEffect.id });
						return;
					}
					if (activeEffect) {
						removeEffect({ editor, ref: elementRef, effectId: activeEffect.id });
					}
					ensureSingleEffect({ editor, ref: elementRef, effectType });
				}}
			/>
			{activeEffect && activeDefinition && (
				<>
					<ToggleRow
						label={`${activeDefinition.name} enabled`}
						active={activeEffect.enabled}
						onToggle={() => toggleEffectEnabled({ editor, ref: elementRef, effectId: activeEffect.id })}
					/>
					{activeDefinition.params.map((param) =>
						param.type === "number" ? (
							<ParamRow
								key={param.key}
								label={param.label}
								value={readNumberParam({ raw: activeEffect.params[param.key], fallback: param.default })}
								min={param.min}
								max={param.max ?? 100}
								step={param.step}
								onChange={(value) =>
									updateEffectParam({ editor, ref: elementRef, effectId: activeEffect.id, key: param.key, value })
								}
							/>
						) : null,
					)}
				</>
			)}
		</PanelSheet>
	);
}
