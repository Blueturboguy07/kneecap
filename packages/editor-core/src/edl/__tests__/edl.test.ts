// Tests deliberately reach into the document with narrowing casts: they poke
// invalid values into a valid EDL to prove `validateEdl` catches them, and they
// hand raw imported JSON to the schema checker. Both are the point of the file.
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { describe, expect, test } from "bun:test";
import edlSchema from "../../../schema/edl-v1.json";
import goldenEdl from "./golden-edl-v1.json";
import {
	buildEdl,
	parseEdl,
	serializeEdl,
	type Edl,
	EDL_SCHEMA_ID,
	EDL_VERSION,
	rationalFromNumber,
	rationalToNumber,
	reduceRational,
	scaleTicks,
	validateEdl,
} from "../index";
import { TICKS_PER_SECOND } from "@/wasm";
import type { TimelineElement } from "@/timeline/types";
import {
	buildFixtureMediaAssets,
	buildFixtureProject,
	buildFixtureScene,
	fixtureAssetResolver,
	FIXTURE_OUTPUT,
} from "./fixture";
import { validateAgainstSchema } from "./json-schema";

const TPS = 120_000;

function buildFixtureEdl(): Edl {
	return buildEdl({
		project: buildFixtureProject(),
		scene: buildFixtureScene(),
		mediaAssets: buildFixtureMediaAssets(),
		output: FIXTURE_OUTPUT,
		resolveAsset: fixtureAssetResolver,
	});
}

// ---------------------------------------------------------------------------
// Tick and rational math — the invariant the whole bridge rests on.
// ---------------------------------------------------------------------------
describe("EDL tick math", () => {
	test("the engine's tick rate is what the EDL advertises", () => {
		expect(TICKS_PER_SECOND).toBe(TPS);
		expect(buildFixtureEdl().meta.ticksPerSecond).toBe(TPS);
	});

	test("rationalFromNumber is exact for every speed the UI can produce", () => {
		// retime/rate.ts clamps to [0.01, 5]; these are the preset stops.
		for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5]) {
			const r = rationalFromNumber({ value: rate });
			expect(Number.isInteger(r.numerator)).toBe(true);
			expect(Number.isInteger(r.denominator)).toBe(true);
			expect(rationalToNumber(r)).toBe(rate);
		}
	});

	test("rationalFromNumber recovers the drop-frame rates exactly", () => {
		expect(rationalFromNumber({ value: 30000 / 1001 })).toEqual({
			numerator: 30000,
			denominator: 1001,
		});
		expect(rationalFromNumber({ value: 24000 / 1001 })).toEqual({
			numerator: 24000,
			denominator: 1001,
		});
	});

	test("rationalFromNumber rejects values the bridge cannot carry", () => {
		expect(() => rationalFromNumber({ value: 0 })).toThrow();
		expect(() => rationalFromNumber({ value: -1 })).toThrow();
		expect(() => rationalFromNumber({ value: Number.NaN })).toThrow();
		expect(() => rationalFromNumber({ value: Number.POSITIVE_INFINITY })).toThrow();
	});

	test("reduceRational normalises sign and common factors", () => {
		expect(reduceRational({ numerator: 60, denominator: 24 })).toEqual({
			numerator: 5,
			denominator: 2,
		});
		expect(reduceRational({ numerator: -3, denominator: -6 })).toEqual({
			numerator: 1,
			denominator: 2,
		});
	});

	test("scaleTicks always returns an integer and rounds half away from zero", () => {
		expect(scaleTicks({ ticks: 100, rate: { numerator: 3, denominator: 2 } })).toBe(150);
		// 5 * 1/2 = 2.5 -> 3, matching roundMediaTime, not Math.round's -0 quirk.
		expect(scaleTicks({ ticks: 5, rate: { numerator: 1, denominator: 2 } })).toBe(3);
		expect(scaleTicks({ ticks: -5, rate: { numerator: 1, denominator: 2 } })).toBe(-3);
		expect(scaleTicks({ ticks: 0, rate: { numerator: 7, denominator: 3 } })).toBe(0);
	});

	test("every time-shaped value in a built EDL is an integer", () => {
		const edl = buildFixtureEdl();
		const offenders: string[] = [];

		const walk = ({ value, path }: { value: unknown; path: string }): void => {
			if (Array.isArray(value)) {
				value.forEach((item, i) => walk({ value: item, path: `${path}[${i}]` }));
				return;
			}
			if (value === null || typeof value !== "object") return;
			for (const [key, child] of Object.entries(value)) {
				const childPath = `${path}.${key}`;
				const looksTemporal =
					key.endsWith("Ticks") ||
					key === "ticksPerSecond" ||
					key === "numerator" ||
					key === "denominator";
				if (looksTemporal && typeof child === "number" && !Number.isInteger(child)) {
					offenders.push(`${childPath} = ${child}`);
				}
				walk({ value: child, path: childPath });
			}
		};

		walk({ value: edl, path: "$" });
		expect(offenders).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// buildEdl: the project graph -> EDL mapping
// ---------------------------------------------------------------------------
describe("buildEdl", () => {
	test("carries the project frame rate as an exact rational, not a float", () => {
		const edl = buildFixtureEdl();
		expect(edl.meta.frameRate).toEqual({ numerator: 30000, denominator: 1001 });
		// The trap: 30000/1001 is 29.970029..., and 29.97 is not the same number.
		expect(rationalToNumber(edl.meta.frameRate)).not.toBe(29.97);
	});

	test("z-orders tracks bottom-to-top with the main track at the bottom", () => {
		// scene-builder composites [...overlay, main].reverse(), so main paints
		// first (bottom) and overlay[0] paints last (top). The EDL states that
		// outright instead of making each native mapper re-derive it.
		const edl = buildFixtureEdl();
		const composited = edl.tracks.filter((t) => t.zIndex !== null);
		expect(composited.map((t) => [t.trackId, t.zIndex])).toEqual([
			["track-main", 0],
			["track-text", 1],
		]);
		const audio = edl.tracks.filter((t) => t.kind === "audio");
		expect(audio).toHaveLength(1);
		expect(audio[0].zIndex).toBeNull();
	});

	test("a 1x clip consumes exactly its timeline duration of source", () => {
		const edl = buildFixtureEdl();
		const clip = edl.tracks[0].clips.find((c) => c.clipId === "clip-a");
		if (!clip) throw new Error("clip-a missing");
		expect(clip.speed).toEqual({ numerator: 1, denominator: 1 });
		expect(clip.startTicks).toBe(0);
		expect(clip.durationTicks).toBe(2 * TPS);
		expect(clip.sourceStartTicks).toBe(TPS / 2);
		expect(clip.sourceEndTicks).toBe(TPS / 2 + 2 * TPS);
	});

	test("a retimed clip's source span is durationTicks x speed, in integers", () => {
		const edl = buildFixtureEdl();
		const clip = edl.tracks[0].clips.find((c) => c.clipId === "clip-b");
		if (!clip) throw new Error("clip-b missing");
		// 1.5x stored as a float in RetimeConfig becomes 3/2 on the bridge.
		expect(clip.speed).toEqual({ numerator: 3, denominator: 2 });
		expect(clip.maintainPitch).toBe(true);
		expect(clip.durationTicks).toBe(2 * TPS);
		// 2 s of timeline at 1.5x consumes 3 s of source.
		expect(clip.sourceEndTicks - clip.sourceStartTicks).toBe(3 * TPS);
	});

	test("converts the asset's seconds-valued duration into ticks", () => {
		const edl = buildFixtureEdl();
		const asset = edl.assets.find((a) => a.assetId === "asset-video-1");
		expect(asset?.durationTicks).toBe(6 * TPS);
		expect(asset?.hasAudio).toBe(true);
		expect(asset?.sourceUri).toBe("kneecap-media://sandbox/asset-video-1");
	});

	test("leaves asset URIs null when the host supplies no resolver", () => {
		const edl = buildEdl({
			project: buildFixtureProject(),
			scene: buildFixtureScene(),
			mediaAssets: buildFixtureMediaAssets(),
			output: FIXTURE_OUTPUT,
		});
		expect(edl.assets.every((a) => a.sourceUri === null)).toBe(true);
		// Fine for the preview renderer, useless to a native exporter.
		expect(validateEdl({ edl }).ok).toBe(true);
		expect(validateEdl({ edl, options: { strict: true } }).ok).toBe(false);
	});

	test("flattens animations into sorted channels with clip-relative ticks", () => {
		const edl = buildFixtureEdl();
		const title = edl.tracks
			.flatMap((t) => t.clips)
			.find((c) => c.clipId === "clip-title");
		if (!title) throw new Error("clip-title missing");
		expect(title.animations).toHaveLength(1);
		const channel = title.animations[0];
		expect(channel.propertyPath).toBe("opacity");
		expect(channel.componentKey).toBeNull();
		expect(channel.keyframes.map((k) => k.timeTicks)).toEqual([0, TPS / 2]);
		expect(channel.keyframes.map((k) => k.interpolation)).toEqual([
			"linear",
			"hold",
		]);
	});

	test("derives overlays[] consistently with tracks[]", () => {
		const edl = buildFixtureEdl();
		expect(edl.overlays).toHaveLength(1);
		expect(edl.overlays[0]).toMatchObject({
			kind: "text",
			trackId: "track-text",
			clipId: "clip-title",
			zIndex: 1,
			startTicks: TPS / 2,
			durationTicks: 3 * TPS,
		});
	});

	test("emits no transitions — the engine has no transition model yet", () => {
		expect(buildFixtureEdl().transitions).toEqual([]);
	});

	test("is deterministic: two builds of the same graph are byte-identical", () => {
		const a = serializeEdl({ edl: buildFixtureEdl() });
		const b = serializeEdl({ edl: buildFixtureEdl() });
		expect(a).toBe(b);
	});
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------
describe("EDL round-trip", () => {
	test("project graph -> EDL -> JSON -> EDL is lossless", () => {
		const edl = buildFixtureEdl();
		const json = serializeEdl({ edl });
		const reparsed = parseEdl({ json });
		expect(reparsed).toEqual(edl);
		expect(serializeEdl({ edl: reparsed })).toBe(json);
	});

	test("clip timings in the EDL reproduce the source graph exactly", () => {
		const scene = buildFixtureScene();
		const edl = buildFixtureEdl();
		const byId = new Map(
			edl.tracks.flatMap((t) => t.clips).map((c) => [c.clipId, c]),
		);

		const sourceElements: TimelineElement[] = [
			...scene.tracks.main.elements,
			...scene.tracks.overlay.flatMap((t) => t.elements as TimelineElement[]),
			...scene.tracks.audio.flatMap((t) => t.elements as TimelineElement[]),
		];

		expect(byId.size).toBe(sourceElements.length);
		for (const element of sourceElements) {
			const clip = byId.get(element.id);
			if (!clip) throw new Error(`clip ${element.id} missing from EDL`);
			expect(clip.startTicks).toBe(element.startTime);
			expect(clip.durationTicks).toBe(element.duration);
			expect(clip.sourceStartTicks).toBe(element.trimStart);
			expect(clip.trimEndTicks).toBe(element.trimEnd);
			expect(clip.kind).toBe(element.type);
		}
	});

	test("the round-tripped document still validates", () => {
		const edl = parseEdl({ json: serializeEdl({ edl: buildFixtureEdl() }) });
		const result = validateEdl({ edl, options: { strict: true } });
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// validateEdl
// ---------------------------------------------------------------------------
describe("validateEdl", () => {
	test("accepts the fixture in strict mode", () => {
		const result = validateEdl({ edl: buildFixtureEdl(), options: { strict: true } });
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
	});

	test("rejects a float tick value", () => {
		const edl = buildFixtureEdl();
		(edl.tracks[0].clips[0] as { startTicks: number }).startTicks = 1.5;
		const result = validateEdl({ edl });
		expect(result.ok).toBe(false);
		expect(result.errors[0].path).toBe("tracks[0].clips[0].startTicks");
		expect(result.errors[0].message).toContain("integer tick count");
	});

	test("rejects a float frame rate smuggled in as a rational", () => {
		const edl = buildFixtureEdl();
		edl.meta.frameRate = { numerator: 29.97, denominator: 1 };
		const result = validateEdl({ edl });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.path === "meta.frameRate")).toBe(true);
	});

	test("rejects a source span inconsistent with duration x speed", () => {
		const edl = buildFixtureEdl();
		const clip = edl.tracks[0].clips[1];
		clip.sourceEndTicks = clip.sourceStartTicks + 1;
		const result = validateEdl({ edl });
		expect(result.ok).toBe(false);
		expect(
			result.errors.some((e) => e.message.includes("durationTicks x speed")),
		).toBe(true);
	});

	test("rejects a blob: URL, which means nothing to a native exporter", () => {
		const edl = buildFixtureEdl();
		edl.assets[0].sourceUri = "blob:http://localhost/abc";
		const result = validateEdl({ edl });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.message.includes("blob:"))).toBe(true);
	});

	test("rejects an overlay that disagrees with its clip", () => {
		const edl = buildFixtureEdl();
		edl.overlays[0].startTicks += 1;
		const result = validateEdl({ edl });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.path === "overlays[0]")).toBe(true);
	});

	test("rejects a non-dense z-order", () => {
		const edl = buildFixtureEdl();
		edl.tracks[1].zIndex = 7;
		const result = validateEdl({ edl });
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.path === "tracks[].zIndex")).toBe(true);
	});

	test("rejects a transition attached to a non-main-track clip", () => {
		const edl = buildFixtureEdl();
		edl.transitions.push({
			transitionId: "t1",
			afterClipId: "clip-title",
			kind: "crossfade",
			durationTicks: TPS / 2,
		});
		const result = validateEdl({ edl });
		expect(result.ok).toBe(false);
		expect(
			result.errors.some((e) => e.message.includes("main-track only")),
		).toBe(true);
	});

	test("rejects an unknown edlVersion outright", () => {
		const edl = buildFixtureEdl();
		(edl.meta as { edlVersion: number }).edlVersion = 2;
		const result = validateEdl({ edl });
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toBe("meta.edlVersion");
	});

	test("warns, rather than fails, on post-v1 features", () => {
		const edl = buildFixtureEdl();
		edl.tracks[0].clips[0].masks.push({
			maskId: "m1",
			type: "ellipse",
			params: {},
		});
		edl.tracks[0].clips[0].effects.push({
			effectId: "fx-x",
			type: "body-slim",
			enabled: true,
			params: {},
		});
		const result = validateEdl({ edl });
		expect(result.ok).toBe(true);
		expect(result.warnings.some((w) => w.message.includes("mask"))).toBe(true);
		expect(result.warnings.some((w) => w.message.includes("body-slim"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The frozen artefacts: JSON Schema + golden fixture
// ---------------------------------------------------------------------------
describe("EDL v1 frozen artefacts", () => {
	test("a built EDL validates against schema/edl-v1.json", () => {
		const errors = validateAgainstSchema({
			value: buildFixtureEdl() as unknown,
			schema: edlSchema as unknown as Record<string, unknown>,
		});
		expect(errors).toEqual([]);
	});

	test("the golden fixture validates against the schema", () => {
		const errors = validateAgainstSchema({
			value: goldenEdl as unknown,
			schema: edlSchema as unknown as Record<string, unknown>,
		});
		expect(errors).toEqual([]);
	});

	test("the golden fixture is exactly what buildEdl produces today", () => {
		// If this fails, the EDL contract changed. That is allowed — but it is a
		// deliberate act: update golden-edl-v1.json, bump docs/EDL.md's changelog,
		// and tell the iOS and Android mapper owners. It must never be a silent
		// side effect of an unrelated engine change.
		expect(buildFixtureEdl()).toEqual(goldenEdl as unknown as Edl);
	});

	test("the golden fixture passes strict validation", () => {
		const result = validateEdl({
			edl: goldenEdl as unknown as Edl,
			options: { strict: true },
		});
		expect(result.errors).toEqual([]);
	});

	test("schema $id and version constants agree with the code", () => {
		expect((edlSchema as { $id: string }).$id).toBe(EDL_SCHEMA_ID);
		expect(
			(edlSchema as { $defs: { meta: { properties: { edlVersion: { const: number } } } } })
				.$defs.meta.properties.edlVersion.const,
		).toBe(EDL_VERSION);
		expect(buildFixtureEdl().$schema).toBe(EDL_SCHEMA_ID);
	});
});
