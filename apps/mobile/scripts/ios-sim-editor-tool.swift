// Measuring tool for scripts/ios-sim-editor-test.py. It runs on the CI Mac,
// not in the app. scripts/ios-sim-editor-test.py compiles it with swiftc.
//
//   editor-ci-tool image-stats <png> <x> <y> <w> <h> <viewportW> <viewportH>
//       x y w h: the preview area in CSS pixels, as the app logged it. The
//       tool measures the inner 80% of that area in the screenshot.
//   editor-ci-tool video-check <movie>
//       duration, tracks, size, and the colours of the frame at 0.5 s.
//
// It prints one JSON object. Exit 0: measured. Exit 1: could not measure.
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

struct RGBA {
    let width: Int
    let height: Int
    let bytes: [UInt8]
}

/// The image as 8-bit sRGB RGBA, top row first.
func rgba(_ image: CGImage) -> RGBA? {
    let width = image.width
    let height = image.height
    guard width > 0, height > 0, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(
            data: buffer.baseAddress,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
    }
    return drawn ? RGBA(width: width, height: height, bytes: bytes) : nil
}

func loadImage(_ path: String) -> RGBA? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
    return rgba(image)
}

/// Colour facts for the box x0..<x1, y0..<y1:
/// - dominant: the most common colour (5 bits per channel);
/// - offFraction: the part of the box more than 40 levels from it;
/// - lumaStd: the spread of brightness;
/// - colours: the part of the box that is clearly red, green, blue or yellow
///   (the four colours of the test photo).
func measure(_ p: RGBA, x0: Int, y0: Int, x1: Int, y1: Int) -> [String: Any] {
    var histogram = [Int](repeating: 0, count: 32 * 32 * 32)
    var count = 0
    var lumaSum = 0.0
    var lumaSquares = 0.0
    var red = 0
    var green = 0
    var blue = 0
    var yellow = 0
    for y in y0..<y1 {
        var i = (y * p.width + x0) * 4
        for _ in x0..<x1 {
            let r = Int(p.bytes[i])
            let g = Int(p.bytes[i + 1])
            let b = Int(p.bytes[i + 2])
            histogram[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)] += 1
            let luma = 0.299 * Double(r) + 0.587 * Double(g) + 0.114 * Double(b)
            lumaSum += luma
            lumaSquares += luma * luma
            if r > 160 && g < 110 && b < 110 {
                red += 1
            } else if g > 130 && r < 120 && b < 130 {
                green += 1
            } else if b > 160 && r < 120 && g < 150 {
                blue += 1
            } else if r > 170 && g > 160 && b < 120 {
                yellow += 1
            }
            count += 1
            i += 4
        }
    }
    if count == 0 { return ["pixels": 0] }

    var dominantBin = 0
    for bin in 0..<histogram.count where histogram[bin] > histogram[dominantBin] {
        dominantBin = bin
    }
    let dr = ((dominantBin >> 10) & 31) * 8 + 4
    let dg = ((dominantBin >> 5) & 31) * 8 + 4
    let db = (dominantBin & 31) * 8 + 4
    var off = 0
    for y in y0..<y1 {
        var i = (y * p.width + x0) * 4
        for _ in x0..<x1 {
            let d = max(abs(Int(p.bytes[i]) - dr), abs(Int(p.bytes[i + 1]) - dg), abs(Int(p.bytes[i + 2]) - db))
            if d > 40 { off += 1 }
            i += 4
        }
    }
    let minimumBin = max(1, count / 1000)
    var distinct = 0
    for value in histogram where value >= minimumBin { distinct += 1 }
    let total = Double(count)
    let mean = lumaSum / total
    let variance = max(0.0, lumaSquares / total - mean * mean)
    let colours: [String: Double] = [
        "red": Double(red) / total,
        "green": Double(green) / total,
        "blue": Double(blue) / total,
        "yellow": Double(yellow) / total,
    ]
    return [
        "pixels": count,
        "dominant": [dr, dg, db],
        "offFraction": Double(off) / total,
        "lumaMean": mean,
        "lumaStd": variance.squareRoot(),
        "distinctColours": distinct,
        "colours": colours,
    ]
}

func printJSON(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print("{\"error\":\"could not write JSON\"}")
    }
}

func imageStats(_ args: [String]) -> Int32 {
    guard args.count == 7 else {
        printJSON(["error": "image-stats needs <png> <x> <y> <w> <h> <viewportW> <viewportH>"])
        return 1
    }
    guard let image = loadImage(args[0]) else {
        printJSON(["error": "cannot read \(args[0])"])
        return 1
    }
    let numbers = args.dropFirst().compactMap { Double($0) }
    guard numbers.count == 6, numbers[4] > 0, numbers[5] > 0 else {
        printJSON(["error": "bad numbers"])
        return 1
    }
    let x = numbers[0]
    let y = numbers[1]
    let w = numbers[2]
    let h = numbers[3]
    let viewportW = numbers[4]
    let viewportH = numbers[5]
    // Capacitor's web view fills the screen (content inset "never"), so CSS
    // (0, 0) is the top left of the screenshot and one scale fits both axes.
    let scale = Double(image.width) / viewportW
    func pixel(_ value: Double, _ limit: Int) -> Int {
        min(max(Int((value * scale).rounded()), 0), limit)
    }
    let x0 = pixel(x + w * 0.1, image.width)
    let x1 = pixel(x + w * 0.9, image.width)
    let y0 = pixel(y + h * 0.1, image.height)
    let y1 = pixel(y + h * 0.9, image.height)
    guard x1 > x0, y1 > y0 else {
        printJSON(["error": "the preview area is outside the screenshot"])
        return 1
    }
    var result = measure(image, x0: x0, y0: y0, x1: x1, y1: y1)
    result["image"] = [image.width, image.height]
    result["scale"] = scale
    result["box"] = [x0, y0, x1 - x0, y1 - y0]
    result["viewportHeightMismatchPx"] = Double(image.height) - viewportH * scale
    printJSON(result)
    return 0
}

func videoCheck(_ path: String) async -> Int32 {
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    var result: [String: Any] = ["file": path]
    do {
        let duration = try await asset.load(.duration)
        let seconds = CMTimeGetSeconds(duration)
        result["durationSeconds"] = seconds.isFinite ? seconds : -1.0
        let video = try await asset.loadTracks(withMediaType: .video)
        let audio = try await asset.loadTracks(withMediaType: .audio)
        result["videoTracks"] = video.count
        result["audioTracks"] = audio.count
        if let track = video.first {
            let size = try await track.load(.naturalSize)
            let fps = try await track.load(.nominalFrameRate)
            result["naturalSize"] = [Int(size.width), Int(size.height)]
            result["nominalFrameRate"] = Double(fps)
            if seconds.isFinite && seconds > 0 {
                let generator = AVAssetImageGenerator(asset: asset)
                generator.appliesPreferredTrackTransform = true
                let time = CMTime(seconds: min(0.5, seconds / 2), preferredTimescale: 600)
                do {
                    let frame = try await generator.image(at: time).image
                    if let pixels = rgba(frame) {
                        result["frame"] = measure(pixels, x0: 0, y0: 0, x1: pixels.width, y1: pixels.height)
                    }
                } catch {
                    result["frameError"] = error.localizedDescription
                }
            }
        }
    } catch {
        result["error"] = error.localizedDescription
        printJSON(result)
        return 1
    }
    printJSON(result)
    return 0
}

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "image-stats":
    exit(imageStats(Array(arguments.dropFirst())))
case "video-check" where arguments.count == 2:
    exit(await videoCheck(arguments[1]))
default:
    FileHandle.standardError.write(Data("usage: editor-ci-tool image-stats <png> <x> <y> <w> <h> <viewportW> <viewportH> | video-check <movie>\n".utf8))
    exit(2)
}
