import {
	masksRegistry,
	type MaskDefinitionForRegistration,
} from "../../registry";
import { cinematicBarsMaskDefinition } from "./cinematic-bars";
import { diamondMaskDefinition } from "./diamond";
import { ellipseMaskDefinition } from "./ellipse";
import { heartMaskDefinition } from "./heart";
import { rectangleMaskDefinition } from "./rectangle";
import { splitMaskDefinition } from "./split";
import { starMaskDefinition } from "./star";
import { textMaskDefinition } from "./text";
import { freeformMaskDefinition } from "../../freeform/definition";

// kneecap M2: icon *data* used to be imported here from
// `@hugeicons/core-free-icons` and passed to `registerMask`. That put a UI asset
// package in the engine's import closure. Definitions now register icon-less and
// the host installs icons via `masksRegistry.setIcon()` — see
// `apps/web/src/masks/builtin/icons.ts`.

function registerDefaultMask({
	definition,
}: {
	definition: MaskDefinitionForRegistration;
}) {
	if (masksRegistry.has(definition.type)) {
		return;
	}

	masksRegistry.registerMask({ definition });
}

export function registerDefaultMasks(): void {
	registerDefaultMask({ definition: splitMaskDefinition });
	registerDefaultMask({ definition: cinematicBarsMaskDefinition });
	registerDefaultMask({ definition: rectangleMaskDefinition });
	registerDefaultMask({ definition: ellipseMaskDefinition });
	registerDefaultMask({ definition: heartMaskDefinition });
	registerDefaultMask({ definition: diamondMaskDefinition });
	registerDefaultMask({ definition: starMaskDefinition });
	registerDefaultMask({ definition: textMaskDefinition });
	registerDefaultMask({ definition: freeformMaskDefinition });
}
