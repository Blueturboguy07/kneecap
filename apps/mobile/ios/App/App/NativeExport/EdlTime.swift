import CoreMedia

/// kneecap M9 — the ONLY place an EDL tick count becomes a `CMTime`.
///
/// The exactness argument: `CMTime(value:timescale:)` stores a rational
/// (numerator=value, denominator=timescale) internally — it does not round
/// to a float. Using `meta.ticksPerSecond` directly AS the `CMTime` timescale
/// means an EDL tick count maps to a `CMTime` with ZERO rounding error: tick
/// 1 at 120000 ticks/sec becomes exactly `CMTime(value: 1, timescale:
/// 120000)`, not an approximation of 1/120000 seconds. This is what plan
/// §2.2's "Time values crossing the EDL bridge are integer ticks + rational
/// frame rates, never float seconds" actually buys us on the AVFoundation
/// side: `CMTime` is rational-native, so the tick contract and `CMTime`'s
/// own representation line up exactly, with no lossy hop through
/// `Double` seconds anywhere in this mapper.
public enum EdlTime {
	public static func cmTime(ticks: Int64, ticksPerSecond: Int64) -> CMTime {
		CMTime(value: ticks, timescale: CMTimeScale(ticksPerSecond))
	}

	public static func cmTimeRange(
		startTicks: Int64,
		durationTicks: Int64,
		ticksPerSecond: Int64
	) -> CMTimeRange {
		CMTimeRange(
			start: cmTime(ticks: startTicks, ticksPerSecond: ticksPerSecond),
			duration: cmTime(ticks: durationTicks, ticksPerSecond: ticksPerSecond)
		)
	}

	/// `CMTime` for an `EdlRational` frame rate expressed as a frame
	/// DURATION (the reciprocal of fps) — what `AVMutableVideoComposition
	/// .frameDuration` and `AVAssetWriterInput`'s frame-rate hints want.
	public static func frameDuration(fps: EdlRational) -> CMTime {
		// duration = denominator/numerator seconds per frame, kept as an
		// exact rational rather than 1.0/fps.doubleValue.
		CMTime(value: fps.denominator, timescale: CMTimeScale(fps.numerator))
	}
}
