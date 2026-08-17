package dev.kneecap.app.export

/**
 * THE cross-fade math (plan M9 risk #4 — "Media3 has no cross-clip
 * transitions... build the transition compositor FIRST, not last").
 *
 * Kept 100% framework-free (no `androidx.media3.*`, no Android types) on
 * purpose: this is the one piece of the transition compositor whose
 * correctness can be fully verified on a plain JVM without a device or
 * emulator (`TransitionAlphaMathTest`). Everything downstream of this file
 * (`CrossfadeCompositorSettings`, wired into a real Media3
 * `VideoCompositorSettings`) is a thin adapter that cannot itself be
 * unit-tested without a GL context — see that file's doc comment.
 *
 * The compositing model (matches Media3's own `OverlaySettings.alphaScale` /
 * `DefaultVideoCompositor` semantics — index 0 is the opaque "primary"
 * background, every other registered index is alpha-blended on top of it
 * with the standard `src-over` operator: `out = overlay*alpha +
 * primary*(1-alpha)`):
 *
 *   base sequence (index 0): every main-track clip, hard-cut, in order —
 *     this is the "no transitions" render and is ALWAYS fully opaque.
 *   one short overlay sequence per transition (index 1..N): just the head
 *     of the INCOMING clip, trimmed to the transition's duration, positioned
 *     (via a leading gap) so it plays exactly across the transition window,
 *     with `alphaScale` ramping 0 -> 1 linearly across that window.
 *
 * At window-start the overlay is invisible (base clip A shows through
 * untouched); at window-end alpha=1 exactly when the base sequence's clip A
 * -> clip B hard cut happens underneath, so the seam is fully covered by the
 * incoming clip B at full opacity — no visible cut, no double-exposure past
 * the window edges. This is the standard `src-over` crossfade identity,
 * expressed with primitives Media3 documents as public API (`08` §8's own
 * framing: "manually cross-fading alpha via a custom OverlayEffect/shader
 * across the transition window") rather than a hand-rolled GLSL blend pass.
 */
object TransitionAlphaMath {
    /** `startUs`/`endUs` are the transition window on the OUTPUT timeline (in
     * the base sequence's presentation-time space); `endUs > startUs`
     * required. `alphaAt` is undefined (and unused) outside `[startUs,
     * endUs]` — callers are expected to only invoke it while the overlay
     * sequence is actually producing frames, which by construction is
     * exactly that window (see the gap+trim math in
     * `EdlToComposition.buildTransitionOverlaySequence`). */
    data class Window(val startUs: Long, val endUs: Long) {
        init {
            require(endUs > startUs) { "transition window must have endUs > startUs, got [$startUs, $endUs)" }
        }

        val durationUs: Long get() = endUs - startUs
    }

    /**
     * Linear alpha ramp, 0 at `window.startUs`, 1 at `window.endUs`, clamped
     * to `[0,1]` for any `presentationTimeUs` outside the window (defensive:
     * Media3 may query a frame a few microseconds either side of the exact
     * boundary due to frame-timestamp rounding, so clamping — not throwing —
     * is the correct behavior here).
     */
    fun alphaAt(window: Window, presentationTimeUs: Long): Float {
        if (presentationTimeUs <= window.startUs) return 0f
        if (presentationTimeUs >= window.endUs) return 1f
        val elapsed = (presentationTimeUs - window.startUs).toDouble()
        return (elapsed / window.durationUs.toDouble()).toFloat()
    }

    /** v1 scope (plan §2.3 rule 4): cross-fade is the only transition kind
     * with a real alpha curve. Everything else maps to a hard cut (the base
     * sequence's own natural behavior) rather than shipping a transition
     * that only half-works — same "cut, don't ship inconsistent" posture as
     * the golden-frame gate (plan §2.3 rule 3). Wipe/slide are listed in the
     * plan's v1 effect surface but need a position-ramp, not an alpha-ramp;
     * out of scope for this pass (see `not_done`). */
    enum class TransitionKind { CROSSFADE, UNSUPPORTED_HARD_CUT }

    fun classify(rawKind: String): TransitionKind = when (rawKind.lowercase()) {
        "crossfade", "cross-fade", "cross_fade", "dissolve" -> TransitionKind.CROSSFADE
        else -> TransitionKind.UNSUPPORTED_HARD_CUT
    }
}
