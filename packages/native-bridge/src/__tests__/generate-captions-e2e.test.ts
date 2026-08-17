/**
 * The real cross-package "generate" step, end to end: the web-fallback
 * bridge's actual `transcribe()` call (not a hand-copied duplicate of its
 * fixture data) feeding directly into `@kneecap/editor-core`'s actual
 * `buildCaptionElementsFromTranscript()`. This is the exact call sequence a
 * UI host makes — `await getNativeBridge()` then `.transcribe()`, then hand
 * the yielded segments to editor-core — with only the `EditorCore`/`Command`
 * layer omitted (see `caption-pipeline-integration.test.ts` in editor-core
 * for why: importing `@kneecap/editor-core/commands` or `/core` pulls in the
 * WASM compositor, which the repo's test-support stub does not cover).
 */
import { describe, expect, test } from "bun:test";
import { createWebFallbackBridge } from "../web-fallback";
import { DEV_FIXTURE_MEDIA_HANDLE } from "../dev-fixtures/sample-transcript";
import { buildCaptionElementsFromTranscript } from "@kneecap/editor-core/captions";
import { ZERO_MEDIA_TIME } from "@kneecap/editor-core/wasm";

describe("NativeBridge.transcribe() -> buildCaptionElementsFromTranscript()", () => {
	test("the web-fallback bridge's fixture transcript builds real, well-formed caption elements", async () => {
		const bridge = createWebFallbackBridge();

		const segments = [];
		for await (const segment of bridge.transcribe({
			handle: DEV_FIXTURE_MEDIA_HANDLE,
			opts: { modelSize: "tiny" },
		})) {
			segments.push(segment);
		}
		expect(segments.length).toBeGreaterThan(0);

		const elements = buildCaptionElementsFromTranscript({
			segments,
			timelineStartTime: ZERO_MEDIA_TIME,
		});

		expect(elements).toHaveLength(segments.length);
		expect(elements.every((el) => el.type === "caption")).toBe(true);
		expect(elements.every((el) => el.words.length > 0)).toBe(true);

		// First element's first/last word match the fixture's own text —
		// proves the microseconds -> ticks conversion ran on the REAL
		// transcribe() output, not a copy of it.
		expect(elements[0].words[0].text).toBe("kneecap");
		const lastWordOfFirstSegment = elements[0].words[elements[0].words.length - 1];
		expect(lastWordOfFirstSegment.text).toBe("editor");

		// Every word's span is inside its own element's [0, duration] — the
		// same invariant `getVisibleCaptionWords`/`getActiveCaptionWordIndex`
		// (editor-core) rely on for an UNSPLIT, freshly generated element.
		for (const element of elements) {
			for (const word of element.words) {
				expect(word.startTime).toBeGreaterThanOrEqual(0);
				expect(word.endTime).toBeLessThanOrEqual(element.duration);
				expect(word.endTime).toBeGreaterThan(word.startTime);
			}
		}
	});
});
