import { MAX_FEATHER } from "@/masks/feather";
import type { ParamDefinition } from "@/params";
import type {
	BaseMaskParams,
	Mask,
	MaskDefaultContext,
	MaskDefinition,
	MaskParamUpdateArgs,
	MaskRenderer,
	MaskType,
} from "@/masks/types";
import { DefinitionRegistry } from "@/params/registry";

/**
 * Structural mirror of `@hugeicons/react`'s `IconSvgElement` — a plain array of
 * `[tagName, attributes]` pairs.
 *
 * kneecap M2: the engine must not import a React icon library (not even for a
 * type), so the shape is restated here. It stays assignable in both directions
 * with the real `IconSvgElement`, so `<HugeiconsIcon {...definition.icon} />`
 * in the UI keeps type-checking. Icon *data* is supplied by the host via
 * `masksRegistry.setIcon()`; the engine never interprets it.
 */
export type MaskIconSvgElement = readonly (readonly [
	string,
	{ readonly [key: string]: string | number },
])[];

export type MaskIconProps = {
	icon: MaskIconSvgElement;
	strokeWidth?: number;
};

/** Renders as nothing. Used until the host installs real icon data. */
export const EMPTY_MASK_ICON: MaskIconProps = { icon: [] };

type RegisteredMaskWithoutId = Mask extends infer TMask
	? TMask extends Mask
		? Omit<TMask, "id">
		: never
	: never;

export type MaskDefinitionForRegistration = {
	[TType in MaskType]: MaskDefinition<TType>;
}[MaskType];

export const BASE_MASK_PARAM_DEFINITIONS: ParamDefinition<
	keyof BaseMaskParams & string
>[] = [
	{
		key: "feather",
		label: "Feather",
		type: "number",
		default: 0,
		min: 0,
		max: MAX_FEATHER,
		step: 1,
		unit: "percent",
	},
	{
		key: "strokeWidth",
		label: "Stroke width",
		type: "number",
		default: 0,
		min: 0,
		max: 100,
		step: 1,
	},
	{
		key: "strokeColor",
		label: "Stroke color",
		type: "color",
		default: "#ffffff",
	},
];

export interface RegisteredMaskDefinition {
	type: MaskType;
	name: string;
	features: MaskDefinition["features"];
	params: ParamDefinition<string>[];
	renderer: MaskRenderer<BaseMaskParams>;
	interaction: MaskDefinition["interaction"];
	isActive?(params: BaseMaskParams): boolean;
	buildDefault(context: MaskDefaultContext): RegisteredMaskWithoutId;
	computeParamUpdate(
		args: MaskParamUpdateArgs<BaseMaskParams>,
	): Partial<BaseMaskParams>;
	icon: MaskIconProps;
}

export class MasksRegistry extends DefinitionRegistry<
	MaskType,
	RegisteredMaskDefinition
> {
	constructor() {
		super("mask");
	}

	registerMask({
		definition,
		icon = EMPTY_MASK_ICON,
	}: {
		definition: MaskDefinitionForRegistration;
		icon?: MaskIconProps;
	}): void {
		const withBaseParams: RegisteredMaskDefinition = {
			type: definition.type,
			name: definition.name,
			features: definition.features,
			params: [...definition.params, ...BASE_MASK_PARAM_DEFINITIONS],
			renderer: definition.renderer,
			interaction: definition.interaction,
			isActive: definition.isActive,
			buildDefault: definition.buildDefault,
			computeParamUpdate: definition.computeParamUpdate,
			icon,
		};
		this.register({
			key: definition.type,
			definition: withBaseParams,
		});
	}

	/**
	 * Host-side icon injection. Called by the UI layer after the engine has
	 * registered the (icon-less) definitions. No-ops for unknown mask types so
	 * an icon pack can lag behind the engine's mask set.
	 */
	setIcon({ type, icon }: { type: MaskType; icon: MaskIconProps }): void {
		if (!this.has(type)) {
			return;
		}
		this.get(type).icon = icon;
	}
}

export const masksRegistry = new MasksRegistry();
