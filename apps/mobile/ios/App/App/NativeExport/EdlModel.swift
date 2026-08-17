import Foundation

/// kneecap M9 — the Swift decoder for EDL v1
/// (`packages/editor-core/src/edl/types.ts`, docs/EDL.md). This is the ONE
/// place the native export mapper learns the bridge document's shape.
///
/// Field names are kept IDENTICAL to the TS source so `JSONDecoder`'s default
/// synthesized `Decodable` conformance does the mapping with zero
/// `CodingKeys` boilerplate — any drift between this file and
/// `edl/types.ts` shows up as a decode failure, not a silent mismatch,
/// which is the property we want for a frozen cross-language contract.
///
/// THE ONE RULE THAT MATTERS (plan §2.2/§2.3 rule 1, restated for this file):
/// every `*Ticks` field below is `Int64`, decoded from a JSON integer. There
/// is no `Double`/`CMTimeSeconds` anywhere in this file. `EdlTime.swift` is
/// the only place a tick count turns into a `CMTime`, and it does so exactly
/// (`CMTimeMake(value: ticks, timescale: ticksPerSecond)`), never via a
/// seconds-float intermediate.
///
/// Platform-agnostic (Foundation only — no AVFoundation, no UIKit/Capacitor):
/// this file, like `NativeMedia/*.swift`, compiles unmodified into both the
/// iOS app target and the standalone `verify-export-pipeline` macOS harness.
public struct EdlRational: Codable, Equatable {
	public var numerator: Int64
	public var denominator: Int64

	public init(numerator: Int64, denominator: Int64) {
		self.numerator = numerator
		self.denominator = denominator
	}

	/// As a `Double`, ONLY for contexts that have no rational-native API
	/// (e.g. picking an `AVVideoCompressionPropertiesKey` heuristic). Never
	/// used for anything that crosses back into tick math.
	public var doubleValue: Double {
		denominator == 0 ? 0 : Double(numerator) / Double(denominator)
	}
}

/// `EdlBackground` is a small tagged union in TS
/// (`{type:"color",color} | {type:"blur",blurIntensity}`). Modeled here as a
/// flat optional-field struct rather than a Swift `enum` with associated
/// values — `Decodable` synthesis for tagged unions needs hand-written
/// `init(from:)` either way, and the flat shape is simpler for the one v1
/// caller (`EdlExporter` reads `.type` and only implements the `"color"`
/// case — see its header comment for the `"blur"` limitation).
public struct EdlBackground: Codable, Equatable {
	public var type: String
	public var color: String?
	public var blurIntensity: Double?
}

public struct EdlMeta: Codable, Equatable {
	public var edlVersion: Int
	public var generator: String
	public var ticksPerSecond: Int64
	public var frameRate: EdlRational
	public var canvas: EdlSize
	public var background: EdlBackground
	public var projectId: String
	public var projectName: String
	public var sceneId: String
	public var sceneName: String
	public var durationTicks: Int64
}

public struct EdlSize: Codable, Equatable {
	public var width: Int
	public var height: Int
}

public struct EdlAsset: Codable, Equatable {
	public var assetId: String
	public var kind: String // "video" | "image" | "audio"
	public var name: String
	public var sourceUri: String?
	public var proxyUri: String?
	public var codec: String?
	public var width: Int?
	public var height: Int?
	public var durationTicks: Int64?
	public var rotationDegrees: Int
	public var hasAudio: Bool
}

public struct EdlTransform: Codable, Equatable {
	public var positionX: Double
	public var positionY: Double
	public var scaleX: Double
	public var scaleY: Double
	public var rotateDegrees: Double
}

/// `params`/effect params are `Record<string, number|string|boolean>` in TS —
/// `AnyCodableValue` is the minimal Swift shape that round-trips exactly
/// those three JSON leaf types without pulling in a third-party dependency
/// (plan directive: zero-cost/local-first, no new toolchain pieces for a
/// decode-only concern).
public enum AnyCodableValue: Codable, Equatable {
	case string(String)
	case number(Double)
	case bool(Bool)
	case null

	public init(from decoder: Decoder) throws {
		let c = try decoder.singleValueContainer()
		if let v = try? c.decode(Bool.self) { self = .bool(v); return }
		if let v = try? c.decode(Double.self) { self = .number(v); return }
		if let v = try? c.decode(String.self) { self = .string(v); return }
		if c.decodeNil() { self = .null; return }
		self = .null
	}

	public func encode(to encoder: Encoder) throws {
		var c = encoder.singleValueContainer()
		switch self {
		case .string(let v): try c.encode(v)
		case .number(let v): try c.encode(v)
		case .bool(let v): try c.encode(v)
		case .null: try c.encodeNil()
		}
	}

	public var asString: String? {
		if case .string(let v) = self { return v }
		return nil
	}
	public var asDouble: Double? {
		if case .number(let v) = self { return v }
		return nil
	}
}

public struct EdlEffect: Codable, Equatable {
	public var effectId: String
	public var type: String
	public var enabled: Bool
	public var params: [String: AnyCodableValue]
}

public struct EdlMask: Codable, Equatable {
	public var maskId: String
	public var type: String
	// `params: Record<string, unknown>` in TS — genuinely unknown-shaped, so
	// decoded as raw `AnyCodableValue` best-effort; v1 never reads mask
	// params (masks are post-v1 for native export, see `EdlClip.masks`).
	public var params: [String: AnyCodableValue]
}

public struct EdlCurveHandle: Codable, Equatable {
	public var dtTicks: Int64
	public var dv: Double
}

public struct EdlKeyframe: Codable, Equatable {
	public var keyframeId: String
	public var timeTicks: Int64
	public var value: AnyCodableValue
	public var interpolation: String // "linear" | "hold" | "bezier"
	public var leftHandle: EdlCurveHandle?
	public var rightHandle: EdlCurveHandle?
}

public struct EdlAnimationChannel: Codable, Equatable {
	public var propertyPath: String
	public var componentKey: String?
	public var extrapolationBefore: String
	public var extrapolationAfter: String
	public var keyframes: [EdlKeyframe]
}

public struct EdlClip: Codable, Equatable {
	public var clipId: String
	public var kind: String // "video"|"image"|"audio"|"text"|"sticker"|"graphic"|"effect"
	public var assetId: String?
	public var name: String
	public var startTicks: Int64
	public var durationTicks: Int64
	public var sourceStartTicks: Int64
	public var sourceEndTicks: Int64
	public var trimEndTicks: Int64
	public var speed: EdlRational
	public var maintainPitch: Bool
	public var volumeDb: Double
	public var muted: Bool
	public var hidden: Bool
	public var transform: EdlTransform
	public var opacity: Double
	public var blendMode: String
	public var effects: [EdlEffect]
	public var masks: [EdlMask]
	public var animations: [EdlAnimationChannel]
	public var params: [String: AnyCodableValue]
}

public struct EdlTrack: Codable, Equatable {
	public var trackId: String
	public var kind: String // "main" | "overlay" | "audio"
	public var trackType: String // "video"|"text"|"audio"|"graphic"|"effect"
	public var name: String
	public var zIndex: Int?
	public var muted: Bool
	public var hidden: Bool
	public var clips: [EdlClip]
}

public struct EdlTransition: Codable, Equatable {
	public var transitionId: String
	public var afterClipId: String
	public var kind: String
	public var durationTicks: Int64
}

public struct EdlOverlay: Codable, Equatable {
	public var overlayId: String
	public var kind: String // "text"|"sticker"|"graphic"|"caption"
	public var trackId: String
	public var clipId: String
	public var zIndex: Int
	public var startTicks: Int64
	public var durationTicks: Int64
}

public struct EdlOutput: Codable, Equatable {
	public var container: String // "mp4" | "webm"
	public var videoCodec: String
	public var audioCodec: String
	public var bitrate: Int
	public var fps: EdlRational
	public var resolution: EdlSize
	public var includeAudio: Bool
}

public struct EdlDocument: Codable, Equatable {
	public var schema: String
	public var meta: EdlMeta
	public var assets: [EdlAsset]
	public var tracks: [EdlTrack]
	public var transitions: [EdlTransition]
	public var overlays: [EdlOverlay]
	public var output: EdlOutput

	enum CodingKeys: String, CodingKey {
		case schema = "$schema"
		case meta, assets, tracks, transitions, overlays, output
	}
}

public enum EdlDecodeError: Error, CustomStringConvertible {
	case unsupportedVersion(Int)
	case malformedJson(String)

	public var description: String {
		switch self {
		case .unsupportedVersion(let v):
			return "EDL edlVersion \(v) is not supported (this mapper only implements v1)"
		case .malformedJson(let m):
			return "EDL JSON could not be decoded: \(m)"
		}
	}
}

public enum EdlDecoder {
	public static func decode(_ data: Data) throws -> EdlDocument {
		let doc: EdlDocument
		do {
			doc = try JSONDecoder().decode(EdlDocument.self, from: data)
		} catch {
			throw EdlDecodeError.malformedJson(String(describing: error))
		}
		guard doc.meta.edlVersion == 1 else {
			throw EdlDecodeError.unsupportedVersion(doc.meta.edlVersion)
		}
		return doc
	}

	/// Convenience for the Capacitor plugin, which receives the EDL as an
	/// already-parsed `[String: Any]` (Capacitor JSON-bridges plugin call
	/// params automatically) rather than raw `Data`.
	public static func decode(jsObject: [String: Any]) throws -> EdlDocument {
		let data: Data
		do {
			data = try JSONSerialization.data(withJSONObject: jsObject)
		} catch {
			throw EdlDecodeError.malformedJson(String(describing: error))
		}
		return try decode(data)
	}
}
