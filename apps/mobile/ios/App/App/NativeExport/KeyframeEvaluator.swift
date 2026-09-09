import Foundation

/// kneecap round 47 — keyframe EVALUATION for native export, a line-for-line
/// port of the engine's `animation/interpolation.ts` + `bezier.ts`
/// (`getScalarChannelValueAtTime`): sort keys, clamp handles to their
/// segment, hold / linear / bezier segments (default handles = a third of
/// the span when a key carries none), hold-or-linear edge extrapolation, and
/// the same 20-iteration bisection the preview uses to turn a time into a
/// bezier progress.
///
/// WHY A PORT AND NOT AN APPROXIMATION: the exported frame has to put a
/// keyframed clip exactly where the preview drew it. Any "close enough"
/// easing here would be the two-implementations drift that cost the
/// text/caption path half a dozen rounds. The contract is machine-checked:
/// `packages/editor-core/src/animation/__tests__/fixtures/keyframe-eval-
/// parity.json` holds the engine's value at 160+ sample ticks across every
/// branch, and `verify-export-pipeline` fails unless this file reproduces
/// each one to 1e-6.
///
/// Times are CLIP-LOCAL ticks (`EdlKeyframe.timeTicks`, relative to the
/// clip's own start, speed-independent) — the caller maps composition time
/// to local ticks; see `SourcePlacement.resolved(atCompositionTicks:)`.
public enum KeyframeEvaluator {
	/// The six paths one mobile "clip keyframe" writes (mobile-ui
	/// `CLIP_KEYFRAME_PATHS`) — also exactly what `SourcePlacement` can act on.
	public static let visualPropertyPaths: Set<String> = [
		"transform.positionX", "transform.positionY",
		"transform.scaleX", "transform.scaleY",
		"transform.rotate", "opacity",
	]

	private static let bezierSolveIterations = 20

	/// `normalizeScalarKey` + `normalizeScalarChannel`: a key with its handles
	/// already clamped against its neighbours.
	struct Key {
		var time: Int64
		var value: Double
		/// "linear" | "step" | "bezier" — the engine's `segmentToNext`.
		var segment: String
		var leftDt: Double?
		var leftDv: Double?
		var rightDt: Double?
		var rightDv: Double?
	}

	static func normalizedKeys(_ channel: EdlAnimationChannel) -> [Key] {
		// JS `Array.prototype.sort` is stable; Swift's `sorted` is not
		// guaranteed to be, so sort (time, original index) explicitly.
		var order: [Int] = Array(channel.keyframes.indices)
		order.sort { (a: Int, b: Int) -> Bool in
			let ta = channel.keyframes[a].timeTicks
			let tb = channel.keyframes[b].timeTicks
			if ta != tb { return ta < tb }
			return a < b
		}
		var keys: [Key] = []
		keys.reserveCapacity(order.count)
		for index in order {
			let k = channel.keyframes[index]
			let segment: String
			switch k.interpolation {
			case "hold": segment = "step"
			case "bezier": segment = "bezier"
			default: segment = "linear"
			}
			var key = Key(time: k.timeTicks, value: k.value.asDouble ?? .nan, segment: segment, leftDt: nil, leftDv: nil, rightDt: nil, rightDv: nil)
			if let lh = k.leftHandle {
				key.leftDt = Double(lh.dtTicks)
				key.leftDv = lh.dv
			}
			if let rh = k.rightHandle {
				key.rightDt = Double(rh.dtTicks)
				key.rightDv = rh.dv
			}
			keys.append(key)
		}
		for i in keys.indices {
			// leftHandle only meaningful with a previous key; clamped to
			// [-span, 0]. rightHandle only with a next key; clamped to [0, span].
			if i > 0, let dt = keys[i].leftDt {
				let span = Double(max(1, keys[i].time - keys[i - 1].time))
				keys[i].leftDt = max(-span, min(0, dt))
			} else {
				keys[i].leftDt = nil
				keys[i].leftDv = nil
			}
			if i + 1 < keys.count, let dt = keys[i].rightDt {
				let span = Double(max(1, keys[i + 1].time - keys[i].time))
				keys[i].rightDt = min(span, max(0, dt))
			} else {
				keys[i].rightDt = nil
				keys[i].rightDv = nil
			}
		}
		return keys
	}

	static func bezierPoint(progress: Double, p0: Double, p1: Double, p2: Double, p3: Double) -> Double {
		let mt = 1 - progress
		return mt * mt * mt * p0
			+ 3 * mt * mt * progress * p1
			+ 3 * mt * progress * progress * p2
			+ progress * progress * progress * p3
	}

	/// `getDefaultRightHandle` / `getDefaultLeftHandle`: a third of the span
	/// in both axes (float division, exactly like the TS).
	private static func handles(left: Key, right: Key) -> (rightDt: Double, rightDv: Double, leftDt: Double, leftDv: Double) {
		let span = Double(right.time - left.time)
		let valueDelta = right.value - left.value
		let rightDt = left.rightDt ?? span / 3
		let rightDv = left.rightDt != nil ? (left.rightDv ?? 0) : valueDelta / 3
		let leftDt = right.leftDt ?? -span / 3
		let leftDv = right.leftDt != nil ? (right.leftDv ?? 0) : -valueDelta / 3
		return (rightDt, rightDv, leftDt, leftDv)
	}

	/// `solveBezierProgressForTime`: bisection on the TIME curve.
	static func solveBezierProgress(time: Double, left: Key, right: Key) -> Double {
		var lower = 0.0
		var upper = 1.0
		let h = handles(left: left, right: right)
		let lt = Double(left.time)
		let rt = Double(right.time)
		for _ in 0..<bezierSolveIterations {
			let mid = (lower + upper) / 2
			let estimate = bezierPoint(progress: mid, p0: lt, p1: lt + h.rightDt, p2: rt + h.leftDt, p3: rt)
			if estimate < time {
				lower = mid
			} else {
				upper = mid
			}
		}
		return (lower + upper) / 2
	}

	private static func extrapolate(mode: String, edge: Key, neighbor: Key?, time: Double) -> Double {
		guard mode == "linear", let neighbor else { return edge.value }
		let span = Double(neighbor.time - edge.time)
		if span == 0 { return edge.value }
		return edge.value + ((time - Double(edge.time)) / span) * (neighbor.value - edge.value)
	}

	/// The channel's value at a clip-local tick — `getScalarChannelValueAtTime`.
	public static func value(channel: EdlAnimationChannel, atTicks tick: Int64, fallback: Double) -> Double {
		let keys = normalizedKeys(channel)
		guard let first = keys.first, let last = keys.last else { return fallback }
		let time = Double(tick)
		if tick <= first.time {
			if tick < first.time {
				return extrapolate(mode: channel.extrapolationBefore, edge: first, neighbor: keys.count > 1 ? keys[1] : nil, time: time)
			}
			return first.value
		}
		if tick >= last.time {
			if tick > last.time {
				return extrapolate(mode: channel.extrapolationAfter, edge: last, neighbor: keys.count > 1 ? keys[keys.count - 2] : nil, time: time)
			}
			return last.value
		}
		for i in 0..<(keys.count - 1) {
			let left = keys[i]
			let right = keys[i + 1]
			if tick == right.time { return right.value }
			if !(tick >= left.time && tick <= right.time) { continue }
			if left.segment == "step" { return left.value }
			let span = Double(right.time - left.time)
			if span == 0 { return right.value }
			let progress = min(1, max(0, (time - Double(left.time)) / span))
			if left.segment == "linear" {
				return left.value + (right.value - left.value) * progress
			}
			let curveProgress = solveBezierProgress(time: time, left: left, right: right)
			let h = handles(left: left, right: right)
			return bezierPoint(
				progress: curveProgress,
				p0: left.value,
				p1: left.value + h.rightDv,
				p2: right.value + h.leftDv,
				p3: right.value
			)
		}
		return last.value
	}

	// MARK: - Clip-level helpers

	/// Channels on the six visual paths, keyed by path. Composite channels
	/// (`componentKey != nil`, i.e. colours) never occur on these paths.
	public static func visualChannels(clip: EdlClip) -> [String: EdlAnimationChannel] {
		var out: [String: EdlAnimationChannel] = [:]
		for channel in clip.animations
		where visualPropertyPaths.contains(channel.propertyPath) && channel.componentKey == nil && !channel.keyframes.isEmpty {
			out[channel.propertyPath] = channel
		}
		return out
	}

	public static func resolveTransform(base: EdlTransform, channels: [String: EdlAnimationChannel], localTicks: Int64) -> EdlTransform {
		func v(_ path: String, _ fallback: Double) -> Double {
			guard let channel = channels[path] else { return fallback }
			return value(channel: channel, atTicks: localTicks, fallback: fallback)
		}
		return EdlTransform(
			positionX: v("transform.positionX", base.positionX),
			positionY: v("transform.positionY", base.positionY),
			scaleX: v("transform.scaleX", base.scaleX),
			scaleY: v("transform.scaleY", base.scaleY),
			rotateDegrees: v("transform.rotate", base.rotateDegrees)
		)
	}

	public static func resolveOpacity(base: Double, channels: [String: EdlAnimationChannel], localTicks: Int64) -> Double {
		guard let channel = channels["opacity"] else { return base }
		return value(channel: channel, atTicks: localTicks, fallback: base)
	}
}
