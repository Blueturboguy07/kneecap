// Measuring tool for scripts/ios-sim-editor-test.py. It runs on the CI Mac,
// not in the app. scripts/ios-sim-editor-test.py compiles it with swiftc.
//
//   editor-ci-tool image-stats <png> <x> <y> <w> <h> <viewportW> <viewportH>
//       x y w h: the preview area in CSS pixels, as the app logged it. The
//       tool measures the inner 80% of that area in the screenshot.
//   editor-ci-tool video-check <movie>
//       duration, tracks, size, the colours of the frame at 0.5 s, and the
//       sound of the first audio track (peak, RMS, audible part) read as PCM.
//   editor-ci-tool make-video <out.mp4> <tone.wav> <seconds>
//       the test video: H.264 1280x720 at 30 fps (red, green, blue and
//       yellow quarters with a moving white bar) plus the WAV as AAC.
//   editor-ci-tool frame-regions <baseline.mp4> <main.mp4> <spec.json> [<frames folder>]
//       spec: {"times": [s, ...], "regions": [{"name": "...", "box": [x, y, w, h]}, ...]}
//       with boxes in output pixels. For each time it reads the exact frame
//       of both files and, per region, gives the part of the pixels whose
//       largest channel difference is more than 48 levels ("changed"), the
//       mean of that difference, and the mean colour in each file. With a
//       folder it also writes each frame as PNG, the main frames with the
//       region outlines.
//   editor-ci-tool find-centres <spec.json> [<frames folder>]
//       1.0.8: where an element is, as a fraction of the frame. spec:
//       {"items": [{"id": "...", "movie": "<mp4>", "time": s, "targets": [...]},
//                  {"id": "...", "image": "<png>", "rect": [x, y, w, h],
//                   "viewport": [w, h], "targets": [...]}]}
//       A movie item reads the exact frame at the time; its frame is the
//       whole picture. An image item is a screenshot; its frame is the
//       preview rect in CSS pixels (scale = image width / viewport width).
//       A target is {"name": "...", "mask": "flag" | "light", "box": [x, y, w, h]}
//       with the search box as fractions of the frame. "flag": clearly blue
//       or clearly yellow pixels; "light": white or grey pixels (each
//       channel at least 80, channels within 48 of each other). For each
//       target: the mask pixels in the box, their centre (mean position)
//       and their bounds, as fractions of the frame. With a folder it writes
//       each frame as PNG with the search boxes and the centres.
//   editor-ci-tool image-diff <a.png> <b.png> <x> <y> <w> <h> <viewportW> <viewportH>
//       1.0.8: two screenshots inside one rect (CSS pixels, 2 px kept clear
//       of the edge): the part of the pixels whose largest channel
//       difference is more than 48 levels ("changed"), the mean difference,
//       and the bounds of the changed pixels (fractions of the rect).
//
// It prints one JSON object. Exit 0: measured. Exit 1: could not measure.
import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
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
        if let track = audio.first {
            result["audio"] = audioStats(asset: asset, track: track)
        }
    } catch {
        result["error"] = error.localizedDescription
        printJSON(result)
        return 1
    }
    printJSON(result)
    return 0
}

/// The sound of one audio track, decoded to 16-bit PCM: peak and RMS (1.0 =
/// full scale), its length, and the part of its 100 ms windows with an RMS of
/// at least 0.005 (not silent).
func audioStats(asset: AVAsset, track: AVAssetTrack) -> [String: Any] {
    let reader: AVAssetReader
    do {
        reader = try AVAssetReader(asset: asset)
    } catch {
        return ["error": error.localizedDescription]
    }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
    ])
    guard reader.canAdd(output) else { return ["error": "cannot read the audio track as PCM"] }
    reader.add(output)
    guard reader.startReading() else {
        return ["error": reader.error?.localizedDescription ?? "the audio reader did not start"]
    }
    var peak = 0.0
    var squares = 0.0
    var samples = 0
    var channels = 1
    var sampleRate = 0.0
    var windowSquares = 0.0
    var windowSamples = 0
    var windows = 0
    var audibleWindows = 0
    while let buffer = output.copyNextSampleBuffer() {
        if sampleRate == 0,
           let format = CMSampleBufferGetFormatDescription(buffer),
           let description = CMAudioFormatDescriptionGetStreamBasicDescription(format) {
            sampleRate = description.pointee.mSampleRate
            channels = max(1, Int(description.pointee.mChannelsPerFrame))
        }
        guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
        let count = CMBlockBufferGetDataLength(block) / 2
        if count == 0 { continue }
        var pcm = [Int16](repeating: 0, count: count)
        let status = pcm.withUnsafeMutableBytes { raw -> OSStatus in
            guard let base = raw.baseAddress else { return -1 }
            return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: count * 2, destination: base)
        }
        if status != 0 { continue }
        let windowSize = max(1, Int((sampleRate > 0 ? sampleRate : 44_100) * 0.1)) * channels
        for value in pcm {
            let level = Double(value) / 32768.0
            peak = max(peak, abs(level))
            squares += level * level
            samples += 1
            windowSquares += level * level
            windowSamples += 1
            if windowSamples >= windowSize {
                windows += 1
                if (windowSquares / Double(windowSamples)).squareRoot() >= 0.005 { audibleWindows += 1 }
                windowSquares = 0
                windowSamples = 0
            }
        }
    }
    var result: [String: Any] = [
        "peak": peak,
        "rms": samples > 0 ? (squares / Double(samples)).squareRoot() : 0.0,
        "channels": channels,
        "sampleRate": sampleRate,
        "seconds": sampleRate > 0 ? Double(samples / channels) / sampleRate : 0.0,
        "audibleFraction": windows > 0 ? Double(audibleWindows) / Double(windows) : 0.0,
    ]
    if reader.status == .failed {
        result["error"] = reader.error?.localizedDescription ?? "the audio read failed"
    }
    return result
}

/// One frame of the test video into a 32BGRA pixel buffer: the four colours of
/// the test photo in quarters (top: red, green; bottom: blue, yellow) and a
/// white bar that moves 16 px per frame.
func paintFrame(_ buffer: CVPixelBuffer, frame: Int, width: Int, height: Int) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
    let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
    let pixels = base.assumingMemoryBound(to: UInt8.self)
    // B, G, R, A
    let red: [UInt8] = [30, 30, 220, 255]
    let green: [UInt8] = [60, 180, 30, 255]
    let blue: [UInt8] = [220, 60, 30, 255]
    let yellow: [UInt8] = [30, 210, 240, 255]
    var top = [UInt8](repeating: 0, count: width * 4)
    var bottom = [UInt8](repeating: 0, count: width * 4)
    for x in 0..<width {
        let left = x < width / 2
        for c in 0..<4 {
            top[x * 4 + c] = left ? red[c] : green[c]
            bottom[x * 4 + c] = left ? blue[c] : yellow[c]
        }
    }
    let barStart = (frame * 16) % width
    let barEnd = min(width, barStart + 24)
    for y in 0..<height {
        let row = pixels + y * rowBytes
        let template = y < height / 2 ? top : bottom
        template.withUnsafeBufferPointer { source in
            if let start = source.baseAddress {
                row.update(from: start, count: width * 4)
            }
        }
        for x in barStart..<barEnd {
            let pixel = row + x * 4
            pixel[0] = 255
            pixel[1] = 255
            pixel[2] = 255
            pixel[3] = 255
        }
    }
}

/// Feeds the writer: video frames from paintFrame, sound from the WAV reader.
/// Returns nil when both inputs are finished, else the problem.
func pumpMovie(
    writer: AVAssetWriter,
    video: AVAssetWriterInput,
    adaptor: AVAssetWriterInputPixelBufferAdaptor,
    audio: AVAssetWriterInput,
    pcm: AVAssetReaderTrackOutput,
    frames: Int,
    width: Int,
    height: Int
) -> String? {
    var frame = 0
    var videoDone = false
    var audioDone = false
    let deadline = Date().addingTimeInterval(180)
    while !(videoDone && audioDone) {
        if writer.status == .failed {
            return writer.error?.localizedDescription ?? "the writer failed"
        }
        var moved = false
        if !videoDone && video.isReadyForMoreMediaData {
            moved = true
            if frame >= frames {
                video.markAsFinished()
                videoDone = true
            } else {
                guard let pool = adaptor.pixelBufferPool else { return "the writer has no pixel buffer pool" }
                var made: CVPixelBuffer?
                CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &made)
                guard let buffer = made else { return "no pixel buffer" }
                paintFrame(buffer, frame: frame, width: width, height: height)
                if !adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 30)) {
                    return writer.error?.localizedDescription ?? "the writer refused video frame \(frame)"
                }
                frame += 1
            }
        }
        if !audioDone && audio.isReadyForMoreMediaData {
            moved = true
            if let sample = pcm.copyNextSampleBuffer() {
                if !audio.append(sample) {
                    return writer.error?.localizedDescription ?? "the writer refused a sound buffer"
                }
            } else {
                audio.markAsFinished()
                audioDone = true
            }
        }
        if !moved {
            if Date() > deadline { return "the writer stopped taking data" }
            usleep(5_000)
        }
    }
    return nil
}

func makeVideo(_ args: [String]) async -> Int32 {
    guard args.count == 3, let seconds = Double(args[2]), seconds > 0 else {
        printJSON(["error": "make-video needs <out.mp4> <tone.wav> <seconds>"])
        return 1
    }
    let output = URL(fileURLWithPath: args[0])
    try? FileManager.default.removeItem(at: output)
    let width = 1280
    let height = 720
    let tone = AVURLAsset(url: URL(fileURLWithPath: args[1]))
    do {
        guard let toneTrack = try await tone.loadTracks(withMediaType: .audio).first else {
            printJSON(["error": "the WAV has no audio track"])
            return 1
        }
        let reader = try AVAssetReader(asset: tone)
        let pcm = AVAssetReaderTrackOutput(track: toneTrack, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
        guard reader.canAdd(pcm) else {
            printJSON(["error": "cannot read the WAV as PCM"])
            return 1
        }
        reader.add(pcm)

        let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 4_000_000,
                AVVideoMaxKeyFrameIntervalKey: 30,
            ],
        ])
        video.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
        ])
        let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVNumberOfChannelsKey: 1,
            AVSampleRateKey: 44_100,
            AVEncoderBitRateKey: 128_000,
        ])
        audio.expectsMediaDataInRealTime = false
        guard writer.canAdd(video), writer.canAdd(audio) else {
            printJSON(["error": "the writer cannot take an H.264 and an AAC track"])
            return 1
        }
        writer.add(video)
        writer.add(audio)
        guard reader.startReading() else {
            printJSON(["error": reader.error?.localizedDescription ?? "the WAV reader did not start"])
            return 1
        }
        guard writer.startWriting() else {
            printJSON(["error": writer.error?.localizedDescription ?? "the writer did not start"])
            return 1
        }
        writer.startSession(atSourceTime: .zero)
        let frames = Int((seconds * 30).rounded())
        if let problem = pumpMovie(writer: writer, video: video, adaptor: adaptor, audio: audio, pcm: pcm,
                                   frames: frames, width: width, height: height) {
            writer.cancelWriting()
            printJSON(["error": problem])
            return 1
        }
        await writer.finishWriting()
        guard writer.status == .completed else {
            printJSON(["error": writer.error?.localizedDescription ?? "the writer did not complete"])
            return 1
        }
    } catch {
        printJSON(["error": error.localizedDescription])
        return 1
    }
    printJSON(["file": args[0], "seconds": seconds, "size": [width, height]])
    return 0
}

// ---------------------------------------------------------------- frame-regions

/// A pixel difference above this (largest of R, G, B, 0-255) counts as changed.
let changedLevel = 48

struct RegionBox {
    let name: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

/// The facts of one movie file for frame-regions: size, length and a frame reader.
struct MovieFrames {
    let size: [Int]
    let seconds: Double
    let generator: AVAssetImageGenerator
}

func openMovie(_ path: String) async throws -> MovieFrames {
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    let duration = try await asset.load(.duration)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else {
        throw NSError(domain: "editor-ci-tool", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(path) has no video track"])
    }
    let natural = try await track.load(.naturalSize)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    // The exact frame at each time: the default tolerance may return a key
    // frame up to a second away.
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    let seconds = CMTimeGetSeconds(duration)
    return MovieFrames(
        size: [Int(natural.width.rounded()), Int(natural.height.rounded())],
        seconds: seconds.isFinite ? seconds : -1,
        generator: generator
    )
}

/// The box clipped to the image, in whole pixels (x0, y0, x1, y1), or nil when empty.
func clip(_ box: RegionBox, width: Int, height: Int) -> (Int, Int, Int, Int)? {
    let x0 = max(0, min(width, Int(box.x.rounded())))
    let y0 = max(0, min(height, Int(box.y.rounded())))
    let x1 = max(0, min(width, Int((box.x + box.w).rounded())))
    let y1 = max(0, min(height, Int((box.y + box.h).rounded())))
    return x1 > x0 && y1 > y0 ? (x0, y0, x1, y1) : nil
}

/// main vs baseline inside one box: changed part, mean difference, mean colours.
func compareRegion(main: RGBA, base: RGBA, box: (Int, Int, Int, Int)) -> [String: Any] {
    let (x0, y0, x1, y1) = box
    var changed = 0
    var count = 0
    var diffSum = 0.0
    var mainSum = [0.0, 0.0, 0.0]
    var baseSum = [0.0, 0.0, 0.0]
    for y in y0..<y1 {
        var i = (y * main.width + x0) * 4
        for _ in x0..<x1 {
            var d = 0
            for c in 0..<3 {
                let m = Int(main.bytes[i + c])
                let b = Int(base.bytes[i + c])
                d = max(d, abs(m - b))
                mainSum[c] += Double(m)
                baseSum[c] += Double(b)
            }
            if d > changedLevel { changed += 1 }
            diffSum += Double(d)
            count += 1
            i += 4
        }
    }
    let total = Double(max(count, 1))
    return [
        "pixels": count,
        "box": [x0, y0, x1 - x0, y1 - y0],
        "changed": Double(changed) / total,
        "meanDiff": diffSum / total,
        "main": mainSum.map { $0 / total },
        "base": baseSum.map { $0 / total },
    ]
}

func writePNG(_ image: CGImage, to path: String) {
    guard let destination = CGImageDestinationCreateWithURL(
        URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil
    ) else { return }
    CGImageDestinationAddImage(destination, image, nil)
    CGImageDestinationFinalize(destination)
}

/// The frame with each region's outline (controls green, the rest magenta).
func outlined(_ image: CGImage, regions: [RegionBox]) -> CGImage? {
    let width = image.width
    let height = image.height
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
              data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
              space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          ) else { return nil }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    context.setLineWidth(3)
    for region in regions {
        let control = region.name.hasPrefix("control")
        context.setStrokeColor(red: control ? 0 : 1, green: control ? 1 : 0, blue: control ? 0 : 1, alpha: 1)
        // CGContext has its origin at the bottom left; the boxes at the top left.
        context.stroke(CGRect(x: region.x, y: Double(height) - region.y - region.h, width: region.w, height: region.h))
    }
    return context.makeImage()
}

func frameRegions(_ args: [String]) async -> Int32 {
    guard args.count == 3 || args.count == 4 else {
        printJSON(["error": "frame-regions needs <baseline.mp4> <main.mp4> <spec.json> [<frames folder>]"])
        return 1
    }
    guard let data = FileManager.default.contents(atPath: args[2]),
          let spec = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let times = spec["times"] as? [Double],
          let rawRegions = spec["regions"] as? [[String: Any]] else {
        printJSON(["error": "cannot read the spec \(args[2])"])
        return 1
    }
    var regions: [RegionBox] = []
    for raw in rawRegions {
        guard let name = raw["name"] as? String, let box = raw["box"] as? [Double], box.count == 4 else { continue }
        regions.append(RegionBox(name: name, x: box[0], y: box[1], w: box[2], h: box[3]))
    }
    let folder = args.count == 4 ? args[3] : nil
    if let folder {
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    }
    var result: [String: Any] = ["changedLevel": changedLevel]
    do {
        let base = try await openMovie(args[0])
        let main = try await openMovie(args[1])
        result["baseline"] = ["file": args[0], "size": base.size, "durationSeconds": base.seconds]
        result["main"] = ["file": args[1], "size": main.size, "durationSeconds": main.seconds]
        var frames: [[String: Any]] = []
        for time in times {
            var entry: [String: Any] = ["time": time]
            let at = CMTime(seconds: time, preferredTimescale: 600)
            do {
                let mainFrame = try await main.generator.image(at: at)
                let baseFrame = try await base.generator.image(at: at)
                entry["mainTime"] = CMTimeGetSeconds(mainFrame.actualTime)
                entry["baseTime"] = CMTimeGetSeconds(baseFrame.actualTime)
                if let folder {
                    let stamp = String(format: "%.2f", time)
                    writePNG(baseFrame.image, to: "\(folder)/baseline-\(stamp)s.png")
                    writePNG(outlined(mainFrame.image, regions: regions) ?? mainFrame.image, to: "\(folder)/main-\(stamp)s.png")
                }
                guard let m = rgba(mainFrame.image), let b = rgba(baseFrame.image) else {
                    entry["error"] = "could not read the frames as RGBA"
                    frames.append(entry)
                    continue
                }
                entry["size"] = [m.width, m.height]
                guard m.width == b.width && m.height == b.height else {
                    entry["error"] = "the frames have different sizes: main \(m.width)x\(m.height), baseline \(b.width)x\(b.height)"
                    frames.append(entry)
                    continue
                }
                var measured: [String: Any] = [:]
                for region in regions {
                    if let box = clip(region, width: m.width, height: m.height) {
                        measured[region.name] = compareRegion(main: m, base: b, box: box)
                    } else {
                        measured[region.name] = ["pixels": 0, "error": "the box is outside the frame"]
                    }
                }
                entry["regions"] = measured
            } catch {
                entry["error"] = error.localizedDescription
            }
            frames.append(entry)
        }
        result["frames"] = frames
    } catch {
        result["error"] = error.localizedDescription
        printJSON(result)
        return 1
    }
    printJSON(result)
    return 0
}

// ---------------------------------------------------------------- find-centres

/// The frame inside a picture, in pixels (x1, y1 not included).
struct PixelFrame {
    let x0: Int
    let y0: Int
    let x1: Int
    let y1: Int
}

/// 0: not in the mask. "flag": 1 blue, 2 yellow. "light": 1 (white or grey).
func maskPart(_ mask: String, _ r: Int, _ g: Int, _ b: Int) -> Int {
    switch mask {
    case "flag":
        if b >= 120 && b - r >= 70 && b - g >= 30 { return 1 }
        if r >= 160 && g >= 130 && r - b >= 90 && g - b >= 70 { return 2 }
        return 0
    case "light":
        let low = min(r, g, b)
        let high = max(r, g, b)
        return low >= 80 && high - low <= 48 ? 1 : 0
    default:
        return 0
    }
}

/// A search box (fractions x, y, w, h of the frame) in pixels, clipped to the frame; nil when empty.
func searchPixels(_ box: [Double], frame: PixelFrame) -> (Int, Int, Int, Int)? {
    guard box.count == 4 else { return nil }
    let fw = Double(frame.x1 - frame.x0)
    let fh = Double(frame.y1 - frame.y0)
    func px(_ v: Double) -> Int { max(frame.x0, min(frame.x1, frame.x0 + Int((v * fw).rounded()))) }
    func py(_ v: Double) -> Int { max(frame.y0, min(frame.y1, frame.y0 + Int((v * fh).rounded()))) }
    let x0 = px(box[0])
    let y0 = py(box[1])
    let x1 = px(box[0] + box[2])
    let y1 = py(box[1] + box[3])
    return x1 > x0 && y1 > y0 ? (x0, y0, x1, y1) : nil
}

/// The mask pixels of one target: count, centre (mean position) and bounds, as fractions of the frame.
/// "found" needs at least 0.2% of the search box (and at least 50 pixels).
func findCentre(_ p: RGBA, frame: PixelFrame, mask: String, box: [Double]) -> [String: Any] {
    guard ["flag", "light"].contains(mask) else { return ["found": false, "error": "unknown mask \(mask)"] }
    guard let pixels = searchPixels(box, frame: frame) else {
        return ["found": false, "error": "the search box is empty or outside the frame"]
    }
    let (x0, y0, x1, y1) = pixels
    let fw = Double(frame.x1 - frame.x0)
    let fh = Double(frame.y1 - frame.y0)
    var count = [0, 0, 0]
    var sumX = [0.0, 0.0, 0.0]
    var sumY = [0.0, 0.0, 0.0]
    var minX = Int.max
    var minY = Int.max
    var maxX = -1
    var maxY = -1
    for y in y0..<y1 {
        var i = (y * p.width + x0) * 4
        for x in x0..<x1 {
            let part = maskPart(mask, Int(p.bytes[i]), Int(p.bytes[i + 1]), Int(p.bytes[i + 2]))
            if part > 0 {
                for index in [0, part] {
                    count[index] += 1
                    sumX[index] += Double(x) + 0.5
                    sumY[index] += Double(y) + 0.5
                }
                minX = min(minX, x)
                minY = min(minY, y)
                maxX = max(maxX, x)
                maxY = max(maxY, y)
            }
            i += 4
        }
    }
    let area = (x1 - x0) * (y1 - y0)
    let minimum = max(50, area / 500)
    var result: [String: Any] = [
        "pixels": count[0],
        "boxPixels": area,
        "share": Double(count[0]) / Double(max(area, 1)),
        "minimum": minimum,
        "searchPx": [x0, y0, x1 - x0, y1 - y0],
    ]
    guard count[0] >= minimum else {
        result["found"] = false
        return result
    }
    func fx(_ v: Double) -> Double { (v - Double(frame.x0)) / fw }
    func fy(_ v: Double) -> Double { (v - Double(frame.y0)) / fh }
    result["found"] = true
    result["cx"] = fx(sumX[0] / Double(count[0]))
    result["cy"] = fy(sumY[0] / Double(count[0]))
    result["bounds"] = [fx(Double(minX)), fy(Double(minY)), fx(Double(maxX + 1)), fy(Double(maxY + 1))]
    // True when the pixels reach the edge of the search box: part of the element may be outside it.
    result["touchesEdge"] = minX <= x0 || minY <= y0 || maxX >= x1 - 1 || maxY >= y1 - 1
    if mask == "flag" {
        var parts: [String: Any] = [:]
        for (index, name) in [(1, "blue"), (2, "yellow")] where count[index] > 0 {
            parts[name] = [
                "pixels": count[index],
                "cx": fx(sumX[index] / Double(count[index])),
                "cy": fy(sumY[index] / Double(count[index])),
            ]
        }
        result["parts"] = parts
    }
    return result
}

/// The frame part of the picture with the search boxes (magenta) and the centres (green crosses).
func annotatedFrame(_ image: CGImage, frame: PixelFrame, marks: [([Double], Double?, Double?)]) -> CGImage? {
    let fw = frame.x1 - frame.x0
    let fh = frame.y1 - frame.y0
    guard fw > 0, fh > 0, let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
              data: nil, width: fw, height: fh, bitsPerComponent: 8, bytesPerRow: 0,
              space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          ) else { return nil }
    // CGContext has its origin at the bottom left; the frame at the top left of the picture.
    context.draw(image, in: CGRect(x: -frame.x0, y: fh - image.height + frame.y0, width: image.width, height: image.height))
    let w = Double(fw)
    let h = Double(fh)
    context.setLineWidth(max(2, w / 400))
    for (box, cx, cy) in marks {
        if box.count == 4 {
            context.setStrokeColor(red: 1, green: 0, blue: 1, alpha: 1)
            context.stroke(CGRect(x: box[0] * w, y: h - (box[1] + box[3]) * h, width: box[2] * w, height: box[3] * h))
        }
        if let cx, let cy {
            let x = cx * w
            let y = h - cy * h
            let arm = max(8, w / 60)
            context.setStrokeColor(red: 0, green: 1, blue: 0, alpha: 1)
            context.strokeLineSegments(between: [
                CGPoint(x: x - arm, y: y), CGPoint(x: x + arm, y: y),
                CGPoint(x: x, y: y - arm), CGPoint(x: x, y: y + arm),
            ])
        }
    }
    return context.makeImage()
}

func findCentres(_ args: [String]) async -> Int32 {
    guard args.count == 1 || args.count == 2 else {
        printJSON(["error": "find-centres needs <spec.json> [<frames folder>]"])
        return 1
    }
    guard let data = FileManager.default.contents(atPath: args[0]),
          let spec = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let items = spec["items"] as? [[String: Any]] else {
        printJSON(["error": "cannot read the spec \(args[0])"])
        return 1
    }
    let folder = args.count == 2 ? args[1] : nil
    if let folder {
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    }
    var movies: [String: MovieFrames] = [:]
    var movieErrors: [String: String] = [:]
    var results: [[String: Any]] = []
    for item in items {
        let id = (item["id"] as? String) ?? "item\(results.count)"
        var entry: [String: Any] = ["id": id]
        var picture: CGImage?
        var frame: PixelFrame?
        if let path = item["movie"] as? String {
            let time = (item["time"] as? Double) ?? 0
            entry["movie"] = path
            entry["time"] = time
            if movies[path] == nil && movieErrors[path] == nil {
                do {
                    movies[path] = try await openMovie(path)
                } catch {
                    movieErrors[path] = error.localizedDescription
                }
            }
            if let problem = movieErrors[path] {
                entry["error"] = problem
            } else if let movie = movies[path] {
                entry["movieSize"] = movie.size
                entry["durationSeconds"] = movie.seconds
                do {
                    let got = try await movie.generator.image(at: CMTime(seconds: time, preferredTimescale: 600))
                    picture = got.image
                    entry["actualTime"] = CMTimeGetSeconds(got.actualTime)
                } catch {
                    entry["error"] = error.localizedDescription
                }
            }
        } else if let path = item["image"] as? String {
            entry["image"] = path
            if let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
               let image = CGImageSourceCreateImageAtIndex(source, 0, nil) {
                picture = image
                let rect = (item["rect"] as? [Double]) ?? []
                let viewport = (item["viewport"] as? [Double]) ?? []
                if rect.count == 4, viewport.count == 2, viewport[0] > 0 {
                    // Capacitor's web view fills the screen: one scale fits both axes (image-stats).
                    let scale = Double(image.width) / viewport[0]
                    func clampX(_ v: Double) -> Int { max(0, min(image.width, Int((v * scale).rounded()))) }
                    func clampY(_ v: Double) -> Int { max(0, min(image.height, Int((v * scale).rounded()))) }
                    let f = PixelFrame(x0: clampX(rect[0]), y0: clampY(rect[1]), x1: clampX(rect[0] + rect[2]), y1: clampY(rect[1] + rect[3]))
                    if f.x1 > f.x0 && f.y1 > f.y0 {
                        frame = f
                        entry["scale"] = scale
                    } else {
                        entry["error"] = "the preview rect is outside the screenshot"
                        picture = nil
                    }
                } else {
                    entry["error"] = "an image item needs rect [x, y, w, h] and viewport [w, h]"
                    picture = nil
                }
            } else {
                entry["error"] = "cannot read \(path)"
            }
        } else {
            entry["error"] = "an item needs a movie or an image"
        }
        guard let image = picture, let pixels = rgba(image) else {
            if entry["error"] == nil { entry["error"] = "could not read the frame as RGBA" }
            results.append(entry)
            continue
        }
        let f = frame ?? PixelFrame(x0: 0, y0: 0, x1: pixels.width, y1: pixels.height)
        entry["size"] = [pixels.width, pixels.height]
        entry["frame"] = [f.x0, f.y0, f.x1 - f.x0, f.y1 - f.y0]
        var found: [String: Any] = [:]
        var marks: [([Double], Double?, Double?)] = []
        for target in (item["targets"] as? [[String: Any]]) ?? [] {
            guard let name = target["name"] as? String else { continue }
            let mask = (target["mask"] as? String) ?? ""
            let box = (target["box"] as? [Double]) ?? []
            let measured = findCentre(pixels, frame: f, mask: mask, box: box)
            found[name] = measured
            marks.append((box, measured["cx"] as? Double, measured["cy"] as? Double))
        }
        entry["targets"] = found
        if let folder, let marked = annotatedFrame(image, frame: f, marks: marks) {
            let safe = id.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "-" }
            writePNG(marked, to: "\(folder)/\(String(safe)).png")
        }
        results.append(entry)
    }
    printJSON(["items": results])
    return 0
}

// ---------------------------------------------------------------- image-diff

func imageDiff(_ args: [String]) -> Int32 {
    guard args.count == 8 else {
        printJSON(["error": "image-diff needs <a.png> <b.png> <x> <y> <w> <h> <viewportW> <viewportH>"])
        return 1
    }
    guard let a = loadImage(args[0]), let b = loadImage(args[1]) else {
        printJSON(["error": "cannot read \(args[0]) or \(args[1])"])
        return 1
    }
    guard a.width == b.width && a.height == b.height else {
        printJSON(["error": "the screenshots have different sizes: \(a.width)x\(a.height) and \(b.width)x\(b.height)"])
        return 1
    }
    let numbers = args.dropFirst(2).compactMap { Double($0) }
    guard numbers.count == 6, numbers[2] > 0, numbers[3] > 0, numbers[4] > 0 else {
        printJSON(["error": "bad numbers"])
        return 1
    }
    let scale = Double(a.width) / numbers[4]
    func px(_ v: Double, _ limit: Int) -> Int { max(0, min(limit, Int((v * scale).rounded()))) }
    // 2 px clear of the edge: the rounded corners and the edge smoothing of the canvas.
    let x0 = px(numbers[0], a.width) + 2
    let y0 = px(numbers[1], a.height) + 2
    let x1 = px(numbers[0] + numbers[2], a.width) - 2
    let y1 = px(numbers[1] + numbers[3], a.height) - 2
    guard x1 > x0, y1 > y0 else {
        printJSON(["error": "the rect is outside the screenshots"])
        return 1
    }
    var changed = 0
    var count = 0
    var diffSum = 0.0
    var minX = Int.max
    var minY = Int.max
    var maxX = -1
    var maxY = -1
    for y in y0..<y1 {
        var i = (y * a.width + x0) * 4
        for x in x0..<x1 {
            var d = 0
            for c in 0..<3 {
                d = max(d, abs(Int(a.bytes[i + c]) - Int(b.bytes[i + c])))
            }
            if d > changedLevel {
                changed += 1
                minX = min(minX, x)
                minY = min(minY, y)
                maxX = max(maxX, x)
                maxY = max(maxY, y)
            }
            diffSum += Double(d)
            count += 1
            i += 4
        }
    }
    let total = Double(max(count, 1))
    let w = Double(x1 - x0)
    let h = Double(y1 - y0)
    var result: [String: Any] = [
        "pixels": count,
        "changed": Double(changed) / total,
        "meanDiff": diffSum / total,
        "changedLevel": changedLevel,
        "rectPx": [x0, y0, x1 - x0, y1 - y0],
        "scale": scale,
    ]
    if changed > 0 {
        result["changedBounds"] = [
            Double(minX - x0) / w, Double(minY - y0) / h, Double(maxX + 1 - x0) / w, Double(maxY + 1 - y0) / h,
        ]
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
case "make-video":
    exit(await makeVideo(Array(arguments.dropFirst())))
case "frame-regions":
    exit(await frameRegions(Array(arguments.dropFirst())))
case "find-centres":
    exit(await findCentres(Array(arguments.dropFirst())))
case "image-diff":
    exit(imageDiff(Array(arguments.dropFirst())))
default:
    FileHandle.standardError.write(Data(("usage: editor-ci-tool image-stats <png> <x> <y> <w> <h> <viewportW> <viewportH>"
        + " | video-check <movie> | make-video <out.mp4> <tone.wav> <seconds>"
        + " | frame-regions <baseline.mp4> <main.mp4> <spec.json> [<frames folder>]"
        + " | find-centres <spec.json> [<frames folder>]"
        + " | image-diff <a.png> <b.png> <x> <y> <w> <h> <viewportW> <viewportH>\n").utf8))
    exit(2)
}
