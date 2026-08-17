import Foundation

/// kneecap M9 — main-track transition placement math.
///
/// PURE integer arithmetic, zero AVFoundation/Foundation-date dependencies
/// (only `Int64`) — deliberately factored out of `CompositionBuilder.swift`
/// so this, the single most novel piece of M9 (corpus 07/10 both flag "no
/// precedent found" for this exact bridge, and plan §5 risk #4 calls the
/// hand-built transition compositor "the largest single unknown... schedule
/// it first, not last"), is unit-testable without a simulator, a real
/// video file, or even AVFoundation being linked at all.
///
/// THE DESIGN DECISION THIS FILE ENCODES (no existing precedent to copy —
/// see corpus `07-ios-webview.md` §8 "Precedent search — honest result"):
/// a transition of `durationTicks = d` placed `afterClipId = A` (immediately
/// followed by clip `B` on the main track) is realized by inserting `B`'s
/// FULL, untruncated media `d` ticks before `A`'s nominal (untruncated) end,
/// so the two overlap for exactly `d` ticks. Neither clip's OWN inserted
/// media is shortened — the overlap comes entirely from where `B` starts,
/// never from cutting frames out of `A`. This is why `insertDuration(i)`
/// below is always the clip's full nominal `durationTicks`: only
/// `insertStart` ever moves. This matches how CapCut/most consumer NLEs
/// present a transition dragged onto a cut — it "eats into" existing
/// footage on both sides, costs no extra source frames, and the total
/// exported duration shrinks by `d` per transition versus naive
/// concatenation. Downstream (non-adjacent) clips ripple left by the
/// cumulative sum of every `d` before them, so contiguity is preserved
/// everywhere a transition doesn't touch.
public struct ClipPlacement: Equatable {
	public var clipId: String
	/// Position in the OUTPUT composition timeline, in ticks. Always
	/// `<=` the clip's own nominal `startTicks` (only ever pulled earlier,
	/// never later, and only by an INCOMING transition + upstream ripple).
	public var insertStartTicks: Int64
	/// The clip's own, UNCHANGED nominal on-timeline duration. Never
	/// shortened — see the file header.
	public var insertDurationTicks: Int64
	/// Ticks trimmed off the front of this clip's single-source (no other
	/// clip visible) instruction span, because an INCOMING transition
	/// overlaps the start of `[insertStartTicks, insertStartTicks +
	/// insertDurationTicks)` with the previous clip.
	public var leadingOverlapTicks: Int64
	/// Ticks trimmed off the back of this clip's single-source span,
	/// because an OUTGOING transition overlaps the end of that range with
	/// the next clip.
	public var trailingOverlapTicks: Int64

	public var insertEndTicks: Int64 { insertStartTicks + insertDurationTicks }
	/// The portion of this clip's timeline presence where it is the ONLY
	/// visible main-track clip (i.e. outside any transition window).
	public var soloRange: (start: Int64, end: Int64) {
		(insertStartTicks + leadingOverlapTicks, insertEndTicks - trailingOverlapTicks)
	}
}

public struct TransitionWindow: Equatable {
	public var kind: String
	/// Index into the sorted clips array of the OUTGOING (fading-out) clip.
	public var outgoingIndex: Int
	/// Index of the INCOMING (fading-in) clip.
	public var incomingIndex: Int
	public var startTicks: Int64
	public var durationTicks: Int64
	public var endTicks: Int64 { startTicks + durationTicks }
}

public enum MainTrackPlacementError: Error, CustomStringConvertible {
	case transitionTargetsUnknownClip(String)
	case transitionNotBetweenAdjacentClips(String)

	public var description: String {
		switch self {
		case .transitionTargetsUnknownClip(let id):
			return "transition.afterClipId \"\(id)\" does not match any main-track clip"
		case .transitionNotBetweenAdjacentClips(let id):
			return "transition after clip \"\(id)\" is not immediately followed by another main-track clip (transitions only apply between adjacent main-track clips, plan §2.3)"
		}
	}
}

public enum MainTrackPlacement {
	/// `clips` MUST already be the main track's clips; caller filters by
	/// track kind. Clips are processed in `startTicks` order regardless of
	/// input order (mirrors the EDL's own "tracks[] is normative,
	/// z-ordered" but clips within a track are positional, not
	/// pre-sorted-guaranteed by every producer).
	public static func computePlacements(
		clips: [EdlClip],
		transitions: [EdlTransition]
	) throws -> (placements: [ClipPlacement], windows: [TransitionWindow]) {
		let sorted = clips.sorted { $0.startTicks < $1.startTicks }
		guard !sorted.isEmpty else { return ([], []) }

		var indexByClipId: [String: Int] = [:]
		for (i, c) in sorted.enumerated() { indexByClipId[c.clipId] = i }

		// afterClipId -> the transition record, validated to sit between
		// two genuinely adjacent main-track clips.
		var transitionAfterIndex: [Int: EdlTransition] = [:]
		for t in transitions {
			guard let i = indexByClipId[t.afterClipId] else {
				throw MainTrackPlacementError.transitionTargetsUnknownClip(t.afterClipId)
			}
			guard i + 1 < sorted.count else {
				throw MainTrackPlacementError.transitionNotBetweenAdjacentClips(t.afterClipId)
			}
			transitionAfterIndex[i] = t
		}

		var placements: [ClipPlacement] = []
		placements.reserveCapacity(sorted.count)
		var windows: [TransitionWindow] = []

		var cursorStart = sorted[0].startTicks
		for (i, clip) in sorted.enumerated() {
			var insertStart = i == 0 ? clip.startTicks : cursorStart
			var leading: Int64 = 0
			if i > 0, let prevT = transitionAfterIndex[i - 1] {
				let prevDuration = sorted[i - 1].durationTicks
				let d = clampedTransitionDuration(
					requested: prevT.durationTicks,
					prevDuration: prevDuration,
					nextDuration: clip.durationTicks
				)
				if d > 0 {
					insertStart = placements[i - 1].insertEndTicks - d
					leading = d
					placements[i - 1].trailingOverlapTicks = d
					windows.append(TransitionWindow(
						kind: prevT.kind,
						outgoingIndex: i - 1,
						incomingIndex: i,
						startTicks: insertStart,
						durationTicks: d
					))
				}
			}
			let placement = ClipPlacement(
				clipId: clip.clipId,
				insertStartTicks: insertStart,
				insertDurationTicks: clip.durationTicks,
				leadingOverlapTicks: leading,
				trailingOverlapTicks: 0
			)
			placements.append(placement)
			cursorStart = placement.insertEndTicks
		}

		return (placements, windows)
	}

	/// Never let a transition consume an entire clip (a `d == duration`
	/// transition would leave that clip with a zero-length solo range and,
	/// worse, could invert ordering if `d > duration`). Clamped to at most
	/// half of the SHORTER neighbor, minus one tick, which guarantees both
	/// neighbors keep a non-empty solo range. This clamp is a documented v1
	/// safety net, not a claim that the plan specifies this exact ratio —
	/// no source specifies one (see file header).
	/// SYNC FIX: transitions compress the main track (plan file header —
	/// each transition shortens the overall timeline by its `durationTicks`
	/// vs. naive concatenation), but text/sticker overlay clips and
	/// secondary-audio clips carry their OWN `startTicks` authored against
	/// the ORIGINAL, pre-compression EDL timeline (there is exactly one
	/// producer of this document, `buildEdl`, and it has no idea the native
	/// exporter will later compress the main track — see the plan's own
	/// note that `buildEdl` never populates `transitions[]` yet at all).
	/// Left unaddressed, any overlay/audio clip positioned AT OR AFTER a
	/// transition would drift out of sync with the (now-earlier) main-track
	/// content by exactly that transition's `durationTicks` — a real,
	/// easy-to-miss cross-track sync bug, not a hypothetical one.
	///
	/// This builds a monotonic step function mapping a NOMINAL (EDL-authored)
	/// tick to its OUTPUT (post-compression) tick: flat at `shift == 0`
	/// until the first transition's incoming clip begins, then increases by
	/// that transition's `durationTicks` at each subsequent transition
	/// boundary. `remapNominalTick` looks up the applicable shift for any
	/// given nominal tick and subtracts it.
	///
	/// Known approximation (documented, not silently wrong): only a clip's
	/// `startTicks` is remapped, not independently its `startTicks +
	/// durationTicks`. An overlay/audio clip whose span straddles a
	/// transition boundary keeps its ORIGINAL duration after its start is
	/// shifted, so it can end up to one transition's `durationTicks` too
	/// long or short at that boundary. For v1's transition durations
	/// (sub-second) this is a minor edge case; a fully exact remap would
	/// need to split such a clip at the boundary, which is out of scope
	/// here.
	public static func buildNominalToOutputRemap(
		nominalClipsSorted: [EdlClip],
		windows: [TransitionWindow]
	) -> [(nominalStart: Int64, shift: Int64)] {
		var breakpoints: [(nominalStart: Int64, shift: Int64)] = [(0, 0)]
		var cumulative: Int64 = 0
		for window in windows.sorted(by: { $0.startTicks < $1.startTicks }) {
			guard window.incomingIndex < nominalClipsSorted.count else { continue }
			cumulative += window.durationTicks
			breakpoints.append((nominalClipsSorted[window.incomingIndex].startTicks, cumulative))
		}
		return breakpoints
	}

	public static func remapNominalTick(_ nominalTick: Int64, breakpoints: [(nominalStart: Int64, shift: Int64)]) -> Int64 {
		var shift: Int64 = 0
		for bp in breakpoints where bp.nominalStart <= nominalTick { shift = bp.shift }
		return max(0, nominalTick - shift)
	}

	static func clampedTransitionDuration(
		requested: Int64,
		prevDuration: Int64,
		nextDuration: Int64
	) -> Int64 {
		guard requested > 0 else { return 0 }
		let shorter = min(prevDuration, nextDuration)
		let maxAllowed = max(0, shorter / 2 - 1)
		return min(requested, maxAllowed)
	}
}
