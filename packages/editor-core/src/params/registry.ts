import type {
	ParamDefinition,
	ParamValue,
	ParamValues,
} from "@/params";
import { MIN_TRANSFORM_SCALE } from "@/animation/transform";
import type { BlendMode } from "@/rendering";
import type {
	ElementType,
	TimelineElement,
} from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@/timeline/audio-constants";
import {
	CORNER_RADIUS_MAX,
	CORNER_RADIUS_MIN,
} from "@/text/background";
import { CAPTION_STYLE_PRESETS, getDefaultCaptionStylePreset } from "@/captions/styles";

export type ElementParamDefinition<TKey extends string = string> =
	ParamDefinition<TKey> & {
		read?: ({ element }: { element: TimelineElement }) => ParamValue | null;
		write?: ({
			element,
			value,
		}: {
			element: TimelineElement;
			value: ParamValue;
		}) => TimelineElement;
	};

export function buildDefaultParamValues(
	params: readonly ParamDefinition[],
): ParamValues {
	const values: ParamValues = {};
	for (const param of params) {
		values[param.key] = param.default;
	}
	return values;
}

export class DefinitionRegistry<TKey extends string, TDefinition> {
	private definitions = new Map<TKey, TDefinition>();
	private entityName: string;

	constructor(entityName: string) {
		this.entityName = entityName;
	}

	register({
		key,
		definition,
	}: {
		key: TKey;
		definition: TDefinition;
	}): void {
		this.definitions.set(key, definition);
	}

	has(key: TKey): boolean {
		return this.definitions.has(key);
	}

	get(key: TKey): TDefinition {
		const def = this.definitions.get(key);
		if (!def) {
			throw new Error(`Unknown ${this.entityName}: ${key}`);
		}
		return def;
	}

	getAll(): TDefinition[] {
		return Array.from(this.definitions.values());
	}
}

const BLEND_MODE_OPTIONS: Array<{ value: BlendMode; label: string }> = [
	{ value: "normal", label: "Normal" },
	{ value: "darken", label: "Darken" },
	{ value: "multiply", label: "Multiply" },
	{ value: "color-burn", label: "Color Burn" },
	{ value: "lighten", label: "Lighten" },
	{ value: "screen", label: "Screen" },
	{ value: "plus-lighter", label: "Plus Lighter" },
	{ value: "color-dodge", label: "Color Dodge" },
	{ value: "overlay", label: "Overlay" },
	{ value: "soft-light", label: "Soft Light" },
	{ value: "hard-light", label: "Hard Light" },
	{ value: "difference", label: "Difference" },
	{ value: "exclusion", label: "Exclusion" },
	{ value: "hue", label: "Hue" },
	{ value: "saturation", label: "Saturation" },
	{ value: "color", label: "Color" },
	{ value: "luminosity", label: "Luminosity" },
];

const visualElementParams: ElementParamDefinition[] = [
	{
		key: "transform.positionX",
		label: "Position X",
		type: "number",
		default: DEFAULTS.element.transform.position.x,
		min: -100_000,
		step: 1,
	},
	{
		key: "transform.positionY",
		label: "Position Y",
		type: "number",
		default: DEFAULTS.element.transform.position.y,
		min: -100_000,
		step: 1,
	},
	{
		key: "transform.scaleX",
		label: "Scale X",
		type: "number",
		default: DEFAULTS.element.transform.scaleX,
		min: MIN_TRANSFORM_SCALE,
		step: 0.01,
	},
	{
		key: "transform.scaleY",
		label: "Scale Y",
		type: "number",
		default: DEFAULTS.element.transform.scaleY,
		min: MIN_TRANSFORM_SCALE,
		step: 0.01,
	},
	{
		key: "transform.rotate",
		label: "Rotate",
		type: "number",
		default: DEFAULTS.element.transform.rotate,
		min: -360,
		max: 360,
		step: 1,
	},
	{
		key: "opacity",
		label: "Opacity",
		type: "number",
		default: DEFAULTS.element.opacity,
		min: 0,
		max: 1,
		step: 0.01,
	},
	{
		key: "blendMode",
		label: "Blend Mode",
		type: "select",
		default: DEFAULTS.element.blendMode,
		keyframable: false,
		options: BLEND_MODE_OPTIONS,
	},
];

const audioElementParams: ElementParamDefinition[] = [
	{
		key: "volume",
		label: "Volume",
		type: "number",
		default: DEFAULTS.element.volume,
		min: VOLUME_DB_MIN,
		max: VOLUME_DB_MAX,
		step: 0.01,
	},
	{
		key: "muted",
		label: "Muted",
		type: "boolean",
		default: false,
		keyframable: false,
	},
	{
		// M8 Edit panel's "Reverse" control writes here. Real, persisted,
		// undoable state — but `@/retime/rate.ts` (`clampRetimeRate`) only
		// accepts rate > 0, and the inherited engine has no negative-rate or
		// playback-direction concept anywhere in the Rust/wasm compositor.
		// This param is therefore the same category of honest partial-engine
		// gap as `EdlTransition` being frozen at `[]` (see M7 handoff): the
		// UI control is fully wired and the state genuinely round-trips, but
		// nothing downstream (preview or export) reads it yet. Closing that
		// requires either a compositor change or a source-side sample-reversal
		// pass — out of scope for M8 (panels/toolbars), tracked for whoever
		// owns preview/export playback next.
		key: "reversed",
		label: "Reverse",
		type: "boolean",
		default: false,
		keyframable: false,
	},
];

const textElementParams: ElementParamDefinition[] = [
	{
		key: "content",
		label: "Content",
		type: "text",
		default: "Default text",
		keyframable: false,
	},
	{
		key: "fontFamily",
		label: "Font Family",
		type: "font",
		default: "Arial",
		keyframable: false,
	},
	{
		key: "fontSize",
		label: "Font Size",
		type: "number",
		default: 15,
		min: 1,
		step: 1,
	},
	{
		key: "color",
		label: "Color",
		type: "color",
		default: "#ffffff",
	},
	{
		key: "textAlign",
		label: "Text Align",
		type: "select",
		default: "center",
		keyframable: false,
		options: [
			{ value: "left", label: "Left" },
			{ value: "center", label: "Center" },
			{ value: "right", label: "Right" },
		],
	},
	{
		key: "fontWeight",
		label: "Font Weight",
		type: "select",
		default: "normal",
		keyframable: false,
		options: [
			{ value: "normal", label: "Normal" },
			{ value: "bold", label: "Bold" },
		],
	},
	{
		key: "fontStyle",
		label: "Font Style",
		type: "select",
		default: "normal",
		keyframable: false,
		options: [
			{ value: "normal", label: "Normal" },
			{ value: "italic", label: "Italic" },
		],
	},
	{
		key: "textDecoration",
		label: "Text Decoration",
		type: "select",
		default: "none",
		keyframable: false,
		options: [
			{ value: "none", label: "None" },
			{ value: "underline", label: "Underline" },
			{ value: "line-through", label: "Line Through" },
		],
	},
	{
		key: "letterSpacing",
		label: "Letter Spacing",
		type: "number",
		default: DEFAULTS.text.letterSpacing,
		min: -100,
		step: 0.1,
	},
	{
		key: "lineHeight",
		label: "Line Height",
		type: "number",
		default: DEFAULTS.text.lineHeight,
		min: 0.1,
		step: 0.1,
	},
	{
		key: "background.enabled",
		label: "Background Enabled",
		type: "boolean",
		default: DEFAULTS.text.background.enabled,
		keyframable: false,
	},
	{
		key: "background.color",
		label: "Background Color",
		type: "color",
		default: DEFAULTS.text.background.color,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.cornerRadius",
		label: "Background Radius",
		type: "number",
		default: DEFAULTS.text.background.cornerRadius,
		min: CORNER_RADIUS_MIN,
		max: CORNER_RADIUS_MAX,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.paddingX",
		label: "Background Padding X",
		type: "number",
		default: DEFAULTS.text.background.paddingX,
		min: 0,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.paddingY",
		label: "Background Padding Y",
		type: "number",
		default: DEFAULTS.text.background.paddingY,
		min: 0,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.offsetX",
		label: "Background Offset X",
		type: "number",
		default: DEFAULTS.text.background.offsetX,
		min: -100_000,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.offsetY",
		label: "Background Offset Y",
		type: "number",
		default: DEFAULTS.text.background.offsetY,
		min: -100_000,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
];

/**
 * Caption params — plan M10 items 5/6. Deliberately its own set rather than
 * reusing `textElementParams`: captions are generated (never hand-typed) and
 * carry a `stylePresetId` bookkeeping field plus karaoke-specific keys
 * (`highlightColor`, `activeWordBackground.*`, `animationStyle`) that a plain
 * text clip has no use for. Defaults come from `getDefaultCaptionStylePreset()`
 * (`captions/styles.ts`) so a caption inserted with zero explicit params
 * already renders as the "Classic" preset — there is exactly one place
 * (`captions/styles.ts`) that defines what "Classic" looks like.
 */
const defaultCaptionStyle = getDefaultCaptionStylePreset();

function captionDefault({ key, fallback }: { key: string; fallback: ParamValue }): ParamValue {
	return defaultCaptionStyle.params[key] ?? fallback;
}

const captionElementParams: ElementParamDefinition[] = [
	{
		key: "stylePresetId",
		label: "Style Preset",
		type: "select",
		default: defaultCaptionStyle.id,
		keyframable: false,
		options: CAPTION_STYLE_PRESETS.map((preset) => ({
			value: preset.id,
			label: preset.name,
		})),
	},
	{
		key: "fontFamily",
		label: "Font Family",
		type: "font",
		default: String(captionDefault({ key: "fontFamily", fallback: "Arial" })),
		keyframable: false,
	},
	{
		key: "fontSize",
		label: "Font Size",
		type: "number",
		default: Number(captionDefault({ key: "fontSize", fallback: 22 })),
		min: 1,
		step: 1,
		// Not keyframable: `resolveCaptionNode` (services/renderer/resolve.ts)
		// reads this as a static param, matching every other caption style key
		// below. Unlike text's `color`/`opacity`, caption params are not run
		// through `resolveXAtTime` in this pass — offering keyframing here
		// would be a UI affordance the renderer silently ignores.
		keyframable: false,
	},
	{
		key: "fontWeight",
		label: "Font Weight",
		type: "select",
		default: String(captionDefault({ key: "fontWeight", fallback: "bold" })),
		keyframable: false,
		options: [
			{ value: "normal", label: "Normal" },
			{ value: "bold", label: "Bold" },
		],
	},
	{
		key: "color",
		label: "Text Color",
		type: "color",
		default: String(captionDefault({ key: "color", fallback: "#ffffff" })),
		keyframable: false,
	},
	{
		key: "highlightColor",
		label: "Active Word Color",
		type: "color",
		default: String(captionDefault({ key: "highlightColor", fallback: "#FFDE59" })),
		keyframable: false,
	},
	{
		key: "strokeColor",
		label: "Stroke Color",
		type: "color",
		default: String(captionDefault({ key: "strokeColor", fallback: "#000000" })),
		keyframable: false,
	},
	{
		key: "strokeWidth",
		label: "Stroke Width",
		type: "number",
		default: Number(captionDefault({ key: "strokeWidth", fallback: 6 })),
		min: 0,
		max: 40,
		step: 1,
		keyframable: false,
	},
	{
		key: "background.enabled",
		label: "Background Enabled",
		type: "boolean",
		default: captionDefault({ key: "background.enabled", fallback: false }) === true,
		keyframable: false,
	},
	{
		key: "background.color",
		label: "Background Color",
		type: "color",
		default: String(captionDefault({ key: "background.color", fallback: "#000000" })),
		dependencies: [{ param: "background.enabled", equals: true }],
		keyframable: false,
	},
	{
		key: "activeWordBackground.enabled",
		label: "Active Word Pill",
		type: "boolean",
		default:
			captionDefault({ key: "activeWordBackground.enabled", fallback: false }) === true,
		keyframable: false,
	},
	{
		key: "activeWordBackground.color",
		label: "Active Word Pill Color",
		type: "color",
		default: String(
			captionDefault({ key: "activeWordBackground.color", fallback: "#FFDE59" }),
		),
		dependencies: [{ param: "activeWordBackground.enabled", equals: true }],
		keyframable: false,
	},
	{
		key: "position",
		label: "Position",
		type: "select",
		default: String(captionDefault({ key: "position", fallback: "bottom" })),
		keyframable: false,
		options: [
			{ value: "top", label: "Top" },
			{ value: "center", label: "Center" },
			{ value: "bottom", label: "Bottom" },
		],
	},
	{
		key: "uppercase",
		label: "Uppercase",
		type: "boolean",
		default: captionDefault({ key: "uppercase", fallback: false }) === true,
		keyframable: false,
	},
	{
		key: "animationStyle",
		label: "Word Animation",
		type: "select",
		default: String(captionDefault({ key: "animationStyle", fallback: "karaoke" })),
		keyframable: false,
		options: [
			{ value: "karaoke", label: "Karaoke" },
			{ value: "pop", label: "Pop" },
			{ value: "none", label: "None" },
		],
	},
];

export const elementParamRegistry = new DefinitionRegistry<
	ElementType,
	readonly ElementParamDefinition[]
>("element params");

elementParamRegistry.register({
	key: "video",
	definition: [...visualElementParams, ...audioElementParams],
});
elementParamRegistry.register({ key: "image", definition: visualElementParams });
elementParamRegistry.register({
	key: "text",
	definition: [...textElementParams, ...visualElementParams],
});
elementParamRegistry.register({
	key: "caption",
	definition: [...captionElementParams, ...visualElementParams],
});
elementParamRegistry.register({
	key: "sticker",
	definition: visualElementParams,
});
elementParamRegistry.register({
	key: "graphic",
	definition: visualElementParams,
});
elementParamRegistry.register({ key: "audio", definition: audioElementParams });
elementParamRegistry.register({ key: "effect", definition: [] });

export function getElementParams({
	element,
}: {
	element: TimelineElement;
}): readonly ElementParamDefinition[] {
	return elementParamRegistry.has(element.type)
		? elementParamRegistry.get(element.type)
		: [];
}

export function getBuiltInElementParams({
	type,
}: {
	type: ElementType;
}): readonly ElementParamDefinition[] {
	return elementParamRegistry.has(type) ? elementParamRegistry.get(type) : [];
}

export function getElementParam({
	element,
	key,
}: {
	element: TimelineElement;
	key: string;
}): ElementParamDefinition | null {
	return (
		getElementParams({ element }).find((param) => param.key === key) ?? null
	);
}

export function readElementParamValue({
	element,
	param,
}: {
	element: TimelineElement;
	param: ElementParamDefinition;
}): ParamValue | null {
	if (param.read) {
		return param.read({ element });
	}
	if ("params" in element) {
		return element.params[param.key] ?? param.default;
	}
	return null;
}

export function writeElementParamValue({
	element,
	param,
	value,
}: {
	element: TimelineElement;
	param: ElementParamDefinition;
	value: ParamValue;
}): TimelineElement {
	if (param.write) {
		return param.write({ element, value });
	}
	if ("params" in element) {
		return {
			...element,
			params: {
				...element.params,
				[param.key]: value,
			},
		};
	}
	return element;
}

export function buildElementParamValues({
	element,
}: {
	element: TimelineElement;
}): ParamValues {
	const values: ParamValues = {};
	for (const param of getElementParams({ element })) {
		const value = readElementParamValue({ element, param });
		if (value !== null) {
			values[param.key] = value;
		}
	}
	return values;
}

