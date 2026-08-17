# EDL v1 — the kneecap edit-decision-list bridge contract

**Status: FROZEN, 2026-08-17 (plan M2).**
Build mappers against this document. It will not change under you without a
version bump and a note in the changelog at the bottom.

| | |
|---|---|
| TypeScript types | `packages/editor-core/src/edl/types.ts` |
| JSON Schema (draft 2020-12) | `packages/editor-core/schema/edl-v1.json` |
| Serialiser | `packages/editor-core/src/edl/build.ts` — `buildEdl`, `serializeEdl`, `parseEdl` |
| Checker | `packages/editor-core/src/edl/validate.ts` — `validateEdl`, `assertValidEdl` |
| Golden fixture | `packages/editor-core/src/edl/__tests__/golden-edl-v1.json` |
| Tests | `packages/editor-core/src/edl/__tests__/edl.test.ts` (35 tests) |

---

## 1. What it is and why it exists

kneecap edits in a WebView and exports natively. Everything the user decides —
trims, order, speed, transforms, text, keyframes — lives in the TypeScript
engine's project graph. Nothing about how to turn that into an H.264 file lives
there. The EDL is the one document that carries the first across to the second.

Plan §2.2 states the rule the whole architecture rests on:

> **Nothing crosses the JS↔native bridge except JSON control messages, progress
> events, and URLs. No video bytes on the bridge — ever.**

So the EDL references media by URI and never embeds it.

Plan §2.1 Amendment 3 is the reason this file is long: lane 07 §8 searched and
found **no publicly documented production app** doing "JS/WebView timeline
engine → JSON EDL → native AVFoundation export". The individual pieces are
mature; this combination is not. The schema and the two mappers are first-class
design work, not glue.

```
                    EditorCore project graph  (TProject + TScene + SceneTracks)
                                 │
                                 │  buildEdl()          ← the ONLY producer
                                 ▼
                          EDL v1 JSON document
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
      preview renderer     iOS mapper          Android mapper
      (webview, WASM)      AVMutableComposition Media3 Composition
                           + AVVideoCompositing + VideoCompositor
```

`validateEdl()` runs on every one of those three consumers. That is how "preview
and export read the same graph" (plan §2.3 rule 2) stops being an aspiration.

---

## 2. The rule that matters most: integer ticks, rational rates

**Every time value in an EDL is an integer count of ticks. Every rate is a
rational pair of integers. There are no float seconds and no float frame rates
anywhere in the document.**

- `meta.ticksPerSecond` is **120 000** today. It comes from the Rust/WASM core
  (`opencut-wasm`'s `TICKS_PER_SECOND`, mirroring
  `rust/crates/time/src/media_time.rs`), chosen because it divides evenly into
  24, 25, 30, 48, 50, 60 **and** into the 1001-denominator drop-frame rates.
  **Read it from the document. Do not hardcode it.**
- `meta.frameRate` and `output.fps` are `{numerator, denominator}`. 29.97 is
  `{30000, 1001}`, not `29.97`. Collapsing it to 30.0 drifts a ten-minute export
  by about 18 frames.
- Clip `speed` is `{numerator, denominator}` — see §5.

`validateEdl()` checks this field by field. Every key ending in `Ticks`, plus
`ticksPerSecond`, plus every `numerator`/`denominator`, must be an integer or
the document is rejected with the offending path. It is a checked invariant, not
a convention.

Mapper note: this is the shape both native sides already want.
`CMTime(value:timescale:)` is a rational. Media3's frame-rate handling is
rational. Neither of them wants your float.

---

## 3. Document shape

```
Edl
├─ $schema      "https://kneecap.dev/schema/edl-v1.json"
├─ meta         { edlVersion, generator, ticksPerSecond, frameRate{num,den},
│                 canvas{w,h}, background, projectId, projectName,
│                 sceneId, sceneName, durationTicks }
├─ assets[]     { assetId, kind, name, sourceUri, proxyUri, codec,
│                 width, height, durationTicks, rotationDegrees, hasAudio }
├─ tracks[]     NORMATIVE, z-ordered
│   └─ clips[]  { clipId, kind, assetId, startTicks, durationTicks,
│                 sourceStartTicks, sourceEndTicks, trimEndTicks,
│                 speed{num,den}, maintainPitch, volumeDb, muted, hidden,
│                 transform, opacity, blendMode, effects[], masks[],
│                 animations[], params }
├─ transitions[] main-track only; always [] in v1 (see §8)
├─ overlays[]   DERIVED index of the non-media visual clips (see §7)
└─ output       { container, videoCodec, audioCodec, bitrate,
                  fps{num,den}, resolution, includeAudio }
```

**One EDL describes exactly one scene.** The engine's `TProject` holds
`scenes[]`; export operates on the active one
(`RendererManager.exportProject` reads `editor.scenes.getActiveScene().tracks`),
so the EDL does too. `meta.sceneId` says which.

---

## 4. Z-order — read this before writing a compositor

`tracks[]` is ordered and each composited track carries an integer `zIndex`.
**`zIndex: 0` is the bottom-most layer; higher paints on top.** Audio tracks are
not composited and carry `zIndex: null`.

This exists because the engine's own ordering is counter-intuitive.
`services/renderer/scene-builder.ts::buildScene` does:

```ts
const visibleTracks = [...tracks.overlay, tracks.main];
const orderedTracksBottomToTop = visibleTracks.slice().reverse();
```

which means **the main track is at the BOTTOM** and **`overlay[0]` is at the
TOP**. Any mapper re-deriving that from `SceneTracks` has a coin-flip chance of
inverting the whole composite. The EDL states the answer instead of restating
the puzzle.

`validateEdl()` requires the composited `zIndex` values to be a dense
`0..n-1` range, so "paint in ascending zIndex" is unambiguous.

---

## 5. Clip timing — the part that is easy to get subtly wrong

A clip has two independent time spans.

**On the timeline:** `startTicks` … `startTicks + durationTicks`.
**In the source:** `sourceStartTicks` … `sourceEndTicks`.

They are related by `speed`:

```
sourceEndTicks = sourceStartTicks + round(durationTicks × speed.num / speed.den)
```

`speed` is **source ticks consumed per timeline tick**. `2/1` is double speed
(the clip occupies half the timeline it otherwise would). `1/2` is slow motion.

Worked example from the golden fixture (`clip-b`):

```
speed             = 3/2          (the UI's "1.5×")
startTicks        = 240000       (2.0 s in)
durationTicks     = 240000       (2.0 s of timeline)
sourceStartTicks  = 360000       (3.0 s into the source)
sourceEndTicks    = 720000       (6.0 s into the source)
→ 3.0 s of source played across 2.0 s of timeline
```

Three things to know:

1. **`durationTicks` is already retimed.** The engine shrinks a clip's duration
   when you speed it up (`timeline/update-pipeline.ts`: rate 1.5 on a 10-tick
   clip yields duration 7). Do not apply `speed` to `durationTicks` again.
2. **`sourceEndTicks` is emitted explicitly** so no mapper redoes that multiply
   in a different rounding mode. `validateEdl` re-derives it and fails if the
   two differ by more than one tick — because if they do, preview and export are
   reading different source frames, which is exactly the class of bug the
   golden-frame tests in plan §2.3 rule 3 exist to catch.
3. **`trimEndTicks` is bookkeeping, not geometry.** It records trim taken off
   the tail. The source span above is the truth; the engine's own renderer
   (`services/renderer/resolve.ts`) computes source time as
   `trimStart + clipTime × rate` and never consults `trimEnd`.

Rounding everywhere is **half away from zero** (`2.5 → 3`, `-2.5 → -3`),
matching Rust's `.round()` and the engine's `roundMediaTime`. Not
`Math.round`, whose `-0.5 → -0` behaviour leaks `-0` into stored data.

### Where the float goes

`RetimeConfig.rate` is a float in the engine (clamped to `[0.01, 5]` by
`retime/rate.ts`). `buildEdl` is the single place it becomes a rational, via a
bounded continued-fraction expansion (`edl/rational.ts`, max denominator
100 000). This is exact for every preset the UI can produce — 0.25, 0.5, 0.75,
1, 1.25, 1.5, 2, 3, 4, 5 all round-trip bit-for-bit, and there is a test that
says so.

---

## 6. Assets and media custody

```json
{
  "assetId": "asset-video-1",
  "kind": "video",
  "sourceUri": "kneecap-media://sandbox/asset-video-1",
  "proxyUri": "kneecap-media://proxy/asset-video-1",
  "durationTicks": 720000,
  "rotationDegrees": 0,
  "hasAudio": true
}
```

- **`sourceUri` is the original.** Native export reads this. It is a native file
  handle or content URI — never a `blob:` URL. `validateEdl` rejects `blob:`
  outright, because it is meaningless outside the WebView.
- **`proxyUri` is the downscaled short-GOP preview proxy** (plan Amendment 4).
  Preview only. **Never export from the proxy.**
- The engine does not know where bytes live and must not. `buildEdl` takes a
  `resolveAsset` hook that the host fills in; M4's `NativeMediaStore` is the
  real implementation. Without it every asset gets `sourceUri: null`, which is
  fine for the preview renderer and useless to an exporter — hence:

```ts
validateEdl({ edl })                        // ok:true  — preview can use this
validateEdl({ edl, options: { strict } })   // ok:false — no sourceUri
```

**Native exporters must use `strict: true`.**

- `durationTicks` on an asset is the one place the seconds→ticks boundary is
  crossed: `MediaAssetData.duration` comes off the decoder probe in seconds and
  goes through the WASM helper, never a bare multiply.

---

## 7. `overlays[]` is a derived view, not a second source of truth

`tracks[]` is normative. `overlays[]` is a flat, z-ordered index of the
non-media visual clips (`text`, `sticker`, `graphic`, and `caption` from M10),
each carrying `trackId` + `clipId` + `zIndex` back into `tracks[]`.

It exists because both native overlay paths — `AVVideoCompositing` and Media3's
overlay effects — are structured as "a list of things drawn over the A/V
composition", and walking the whole track tree to rebuild that list in the right
order is busywork every mapper would otherwise repeat.

`validateEdl()` fails if the two disagree on track, timing or z-index. If you
find yourself wanting to change a clip, change it in `tracks[]`.

---

## 8. What v1 deliberately does not do

**Transitions: the slot is frozen, the producer is empty.** `transitions[]` is
always `[]` today, because the inherited engine has no transition model —
there is no `transitions` field anywhere in `timeline/types.ts`. The field is
frozen into v1 anyway so that adding transitions later is a producer change
rather than a schema break that invalidates both mappers. **Implement it now,
expect `[]` until the engine grows one.** `validateEdl` already enforces the
CapCut rule that transitions are main-track only.

**Masks are post-v1 for native export** (plan §2.3 rule 4). They are carried in
the document so preview and export read the same graph, but `validateEdl` emits
a warning for every non-empty `masks` array, and a v1 mapper should **refuse the
export** rather than silently drop them.

**Effects are a short list on purpose.** `EDL_V1_SUPPORTED_EFFECT_TYPES` in
`validate.ts` is what a v1 mapper is expected to implement; anything else
warns. Plan §2.3 rule 3: every v1 effect ships with a golden-frame test
(render frame N in the WebView, export frame N natively, perceptual-diff under
a fixed threshold), and anything that cannot pass is **cut from v1 rather than
shipped inconsistent**. We cannot share shader code across WGSL-in-WASM, Metal
and GLSL ES the way Media3 shares `GlShaderProgram` between its own preview and
export paths, so parity has to be measured rather than assumed.

**Multi-scene.** One EDL, one scene. Concatenating scenes is a host concern.

---

## 9. Using it

```ts
import { buildEdl, serializeEdl, validateEdl } from "@kneecap/editor-core/edl";

const edl = buildEdl({
  project,                  // TProject
  scene,                    // TScene — the one being exported
  mediaAssets,              // MediaAssetData[]
  output: {
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    bitrate: 12_000_000,
    includeAudio: true,
  },
  resolveAsset: ({ mediaId }) => nativeMediaStore.uris({ mediaId }),
});

const result = validateEdl({ edl, options: { strict: true } });
if (!result.ok) throw new Error(result.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));

await NativeBridge.exportProject(serializeEdl({ edl }));
```

`buildEdl` is **deterministic**: assets sort by id, clips by
`(startTicks, clipId)`, animation channels by `(propertyPath, componentKey)`.
Two builds of the same graph produce byte-identical JSON. That is what makes
the golden fixture — and the future golden-frame comparison — mean anything.

On the receiving side, always `validateEdl` a document you parsed. `parseEdl` is
a `JSON.parse` plus a cast; it trusts nothing on its own.

---

## 10. Changing this contract

**Additive-only within v1.** A new optional field may be appended to v1 if and
only if every existing mapper keeps working unchanged when it is absent and when
it is ignored. Anything else — a renamed field, a changed unit, a narrowed
enum, a new required field — is **v2**, with `meta.edlVersion: 2`, and
`validateEdl` will reject a v2 document outright rather than half-read it.

To make any change:

1. Edit `src/edl/types.ts` **and** `schema/edl-v1.json`. A test asserts the
   schema's `$id` and `edlVersion` const agree with the code, and the schema
   checker throws on any JSON Schema keyword it does not actually implement — so
   the schema cannot quietly grow an unchecked construct.
2. Regenerate the golden fixture:
   `cd packages/editor-core && bun run generate:golden-edl`
3. Review the diff in `golden-edl-v1.json`. **A diff here is a deliberate act.**
   The test "the golden fixture is exactly what buildEdl produces today" is
   there to make sure a contract change can never be a silent side effect of an
   unrelated engine change.
4. Tell the iOS and Android mapper owners, and add a row below.

### Changelog

| Version | Date | Change |
|---|---|---|
| 1 | 2026-08-17 | Frozen. Initial contract (plan M2). |

---

## 11. Testing notes for mapper authors

The golden fixture is built to exercise the things that are easy to get wrong,
and it is worth running your mapper against it before anything real:

- **29.97 fps** as `{30000, 1001}` — catches float collapse.
- **A retimed clip** at 3/2 with `maintainPitch: true` — catches speed handling.
- **A trimmed clip** starting 0.5 s into its source — catches source-offset
  handling.
- **An overlay track above the main track** — catches the z-order inversion
  in §4.
- **A text overlay with a two-key `opacity` animation**, one `linear` segment
  and one `hold` — catches keyframe flattening and the fact that keyframe times
  are **clip-relative**, not timeline-relative.
- **An audio track with `zIndex: null`** — catches "everything has a z-index"
  assumptions.
- **An asset whose duration only exists in seconds upstream** — catches the
  seconds→ticks boundary.

One caveat about running the engine's own tests: `opencut-wasm`'s published
bindgen glue throws under Bun's test runtime, so `bunfig.toml` preloads a
pure-TS stand-in (`packages/editor-core/src/test-support/wasm-stub.ts`). The
stub is a faithful port of the Rust tick math, but it **is** a stub — tick
values in test output are produced by it, not by the real WASM core. Anything
that needs to be true of the real core should be checked in the browser or in
the golden-frame harness.
