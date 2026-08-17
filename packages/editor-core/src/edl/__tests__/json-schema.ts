/**
 * A deliberately small JSON Schema checker, used ONLY by the EDL tests.
 *
 * Why not a library: the plan's zero-cost / offline-first directive means every
 * added dependency is a liability, and the schema at
 * `packages/editor-core/schema/edl-v1.json` is written to a fixed, boring
 * subset of draft 2020-12 on purpose — so that a Swift or Kotlin mapper author
 * can also read it without an AJV-equivalent. This checker supports exactly
 * that subset, and it FAILS LOUDLY on any keyword it does not implement, so the
 * schema can never quietly grow a construct that isn't actually being checked.
 *
 * Supported: $ref (local), $defs, type (incl. arrays and "integer"), enum,
 * const, required, properties, additionalProperties, items, oneOf, minimum,
 * maximum, exclusiveMinimum, title, description, $schema, $id.
 */

// A schema walker over `unknown` is, unavoidably, a pile of narrowing casts:
// every node is `Json` until a keyword check proves otherwise. The casts here
// are all guarded by a preceding `typeof`/`Array.isArray` check, and the whole
// file is test-only support code.
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */

type Json = unknown;

interface SchemaNode {
	[keyword: string]: Json;
}

const SUPPORTED_KEYWORDS = new Set([
	"$ref",
	"$defs",
	"$schema",
	"$id",
	"title",
	"description",
	"type",
	"enum",
	"const",
	"required",
	"properties",
	"additionalProperties",
	"items",
	"oneOf",
	"minimum",
	"maximum",
	"exclusiveMinimum",
]);

function typeOf(value: Json): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function matchesType({ value, type }: { value: Json; type: string }): boolean {
	if (type === "integer") {
		return typeof value === "number" && Number.isInteger(value);
	}
	if (type === "number") return typeof value === "number";
	return typeOf(value) === type;
}

function resolveRef({ root, ref }: { root: SchemaNode; ref: string }): SchemaNode {
	if (!ref.startsWith("#/")) {
		throw new Error(`json-schema: only local #/ refs are supported, got "${ref}"`);
	}
	let node: Json = root;
	for (const rawSegment of ref.slice(2).split("/")) {
		const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
		if (typeof node !== "object" || node === null) {
			throw new Error(`json-schema: cannot resolve "${ref}"`);
		}
		node = (node as Record<string, Json>)[segment];
	}
	if (typeof node !== "object" || node === null) {
		throw new Error(`json-schema: "${ref}" did not resolve to a schema`);
	}
	return node as SchemaNode;
}

export function validateAgainstSchema({
	value,
	schema,
	root,
	path = "$",
	errors = [],
}: {
	value: Json;
	schema: SchemaNode;
	root?: SchemaNode;
	path?: string;
	errors?: string[];
}): string[] {
	const schemaRoot = root ?? schema;

	for (const keyword of Object.keys(schema)) {
		if (!SUPPORTED_KEYWORDS.has(keyword)) {
			throw new Error(
				`json-schema: unsupported keyword "${keyword}" at ${path}. ` +
					"Either implement it in __tests__/json-schema.ts or stop using it in edl-v1.json — " +
					"an unchecked keyword is worse than no keyword.",
			);
		}
	}

	if (typeof schema.$ref === "string") {
		// Sibling keywords alongside $ref are ignored by design here; edl-v1.json
		// only ever pairs $ref with `description`.
		return validateAgainstSchema({
			value,
			schema: resolveRef({ root: schemaRoot, ref: schema.$ref }),
			root: schemaRoot,
			path,
			errors,
		});
	}

	if (schema.const !== undefined && value !== schema.const) {
		errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
	}

	if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
		errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
	}

	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!types.some((t) => matchesType({ value, type: String(t) }))) {
			errors.push(`${path}: expected type ${types.join("|")}, got ${typeOf(value)}`);
			return errors;
		}
	}

	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) {
			errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
		}
		if (typeof schema.maximum === "number" && value > schema.maximum) {
			errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
		}
		if (
			typeof schema.exclusiveMinimum === "number" &&
			value <= schema.exclusiveMinimum
		) {
			errors.push(`${path}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
		}
	}

	if (Array.isArray(schema.oneOf)) {
		const matches = schema.oneOf.filter((sub) => {
			const subErrors = validateAgainstSchema({
				value,
				schema: sub as SchemaNode,
				root: schemaRoot,
				path,
				errors: [],
			});
			return subErrors.length === 0;
		});
		if (matches.length !== 1) {
			errors.push(`${path}: matched ${matches.length} of ${schema.oneOf.length} oneOf branches (expected exactly 1)`);
		}
	}

	if (Array.isArray(value) && schema.items) {
		value.forEach((item, index) => {
			validateAgainstSchema({
				value: item,
				schema: schema.items as SchemaNode,
				root: schemaRoot,
				path: `${path}[${index}]`,
				errors,
			});
		});
	}

	if (typeOf(value) === "object") {
		const object = value as Record<string, Json>;
		const properties = (schema.properties ?? {}) as Record<string, SchemaNode>;

		if (Array.isArray(schema.required)) {
			for (const key of schema.required) {
				if (!(String(key) in object)) {
					errors.push(`${path}: missing required property "${String(key)}"`);
				}
			}
		}

		for (const [key, child] of Object.entries(object)) {
			const childSchema = properties[key];
			if (childSchema) {
				validateAgainstSchema({
					value: child,
					schema: childSchema,
					root: schemaRoot,
					path: `${path}.${key}`,
					errors,
				});
				continue;
			}
			if (schema.additionalProperties === false) {
				errors.push(`${path}: unexpected property "${key}" (additionalProperties: false)`);
			} else if (
				typeof schema.additionalProperties === "object" &&
				schema.additionalProperties !== null
			) {
				validateAgainstSchema({
					value: child,
					schema: schema.additionalProperties as SchemaNode,
					root: schemaRoot,
					path: `${path}.${key}`,
					errors,
				});
			}
		}
	}

	return errors;
}
