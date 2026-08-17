import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { adjustEffectDefinition } from "./adjust";
import { filterEffectDefinition } from "./filter";

// M8: adjust + filter registered alongside blur. See each definition's own
// header for the honest scope note (real params/state, no Rust WGSL pass
// yet — preview does not visibly change).
const defaultEffects = [
	blurEffectDefinition,
	adjustEffectDefinition,
	filterEffectDefinition,
];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (effectsRegistry.has(definition.type)) {
			continue;
		}
		effectsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}
