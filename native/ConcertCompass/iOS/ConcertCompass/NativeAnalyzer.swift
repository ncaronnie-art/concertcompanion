import AVFoundation
import CoreGraphics
import CompassCore

actor NativeAnalyzer {
    func analyze(url: URL, name: String, progress: @escaping @Sendable (Double) -> Void) async throws -> MediaClip {
        let asset = AVURLAsset(url: url)
        guard try await asset.load(.isPlayable), !(try await asset.load(.hasProtectedContent)) else {
            throw CompassError.invalid("This video cannot be decoded, or is protected. The original is unchanged.")
        }
        guard let video = try await asset.loadTracks(withMediaType: .video).first else {
            throw CompassError.invalid("That file does not contain a video track.")
        }
        let range = try await video.load(.timeRange)
        let duration = range.duration.seconds
        guard duration.isFinite, duration >= 0.1, duration <= 600 else {
            throw CompassError.invalid("Choose a video between 0.1 seconds and 10 minutes for this alpha.")
        }
        let natural = try await video.load(.naturalSize)
        let transform = try await video.load(.preferredTransform)
        let rect = CGRect(origin: .zero, size: natural).applying(transform)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        var result = MediaClip(name: name, fileName: url.lastPathComponent, duration: duration,
                               width: abs(rect.width), height: abs(rect.height), hasAudio: !audioTracks.isEmpty,
                               mediaStart: max(0, range.start.seconds))
        if let audio = audioTracks.first {
            do { result.audio = try AudioReader.windows(asset: asset, track: audio, range: range) }
            catch is CancellationError { throw CancellationError() }
            catch { result.warnings.append("Audio analysis was unavailable; source audio will still be attempted during export.") }
        }
        progress(0.35)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 192, height: 192)
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.08, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.08, preferredTimescale: 600)
        let step = max(1, duration / 240)
        var previous: GrayFrame? = nil
        var time = 0.0
        var failures = 0
        while time < duration {
            try Task.checkCancellation()
            do {
                let generated = try await generator.image(at: CMTime(seconds: result.mediaStart + min(time, duration - 0.03), preferredTimescale: 600))
                let frame = try GrayFrame(image: generated.image, maxSide: 96)
                let stats = SignalTools.visualStatistics(gray: frame.pixels, width: frame.width, height: frame.height)
                var shake = 0.2
                if let previous, previous.width == frame.width, previous.height == frame.height {
                    let move = Stabilization.translation(previous: previous.pixels, current: frame.pixels, width: frame.width, height: frame.height)
                    shake = move.reliable ? clamp(hypot(move.x, move.y) / 6, 0, 1) : 0.45
                }
                result.visual.append(VisualWindow(time: time, sharpness: stats.sharpness, brightness: stats.brightness, shake: shake))
                previous = frame
            } catch is CancellationError { throw CancellationError() }
            catch { failures += 1 }
            time += step
            progress(0.35 + 0.65 * min(1, time / duration))
        }
        if failures > 0 { result.warnings.append("Some visual samples could not be decoded. Review the proposed trims.") }
        progress(1)
        return result
    }
}

struct GrayFrame {
    let width: Int
    let height: Int
    let pixels: [UInt8]
    init(image: CGImage, maxSide: Int) throws {
        let factor = min(1, Double(maxSide) / Double(max(image.width, image.height)))
        width = max(8, Int(Double(image.width) * factor))
        height = max(8, Int(Double(image.height) * factor))
        var bytes = [UInt8](repeating: 0, count: width * height)
        let w = width, h = height
        let success = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: w, height: h, bitsPerComponent: 8,
                                          bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            context.interpolationQuality = .low
            context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard success else { throw CompassError.invalid("A frame could not be analyzed.") }
        pixels = bytes
    }
}

enum AudioReader {
    static func windows(asset: AVAsset, track: AVAssetTrack, range: CMTimeRange) throws -> [AudioWindow] {
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = range
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false,
            AVLinearPCMIsBigEndianKey: false
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw CompassError.invalid("Audio analysis is unavailable for this clip.") }
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? CompassError.invalid("Audio analysis could not start.") }
        defer { if reader.status == .reading { reader.cancelReading() } }
        let frameCount = max(1, Int(ceil(range.duration.seconds * 10)))
        var sum = [Double](repeating: 0, count: frameCount)
        var count = [Int](repeating: 0, count: frameCount)
        var clipped = [Int](repeating: 0, count: frameCount)
        while let buffer = output.copyNextSampleBuffer() {
            try Task.checkCancellation()
            let samples = try floats(buffer)
            let time = CMSampleBufferGetPresentationTimeStamp(buffer).seconds - range.start.seconds
            for (index, value) in samples.enumerated() {
                let t = time + Double(index) / 16000
                let bin = Int(floor(t * 10))
                guard bin >= 0, bin < frameCount, value.isFinite else { continue }
                sum[bin] += Double(value) * Double(value); count[bin] += 1
                if abs(value) > 0.985 { clipped[bin] += 1 }
            }
        }
        if reader.status == .failed { throw reader.error ?? CompassError.invalid("Audio decoding failed.") }
        let rms = sum.indices.map { sqrt(sum[$0] / Double(max(1, count[$0]))) }
        let clipping = count.indices.map { Double(clipped[$0]) / Double(max(1, count[$0])) }
        return SignalTools.normalizedAudio(rms: rms, clipping: clipping)
    }
    static func floats(_ sample: CMSampleBuffer) throws -> [Float] {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return [] }
        let length = CMBlockBufferGetDataLength(block)
        if length == 0 { return [] }
        guard length % MemoryLayout<Float>.size == 0 else { throw CompassError.invalid("Unexpected PCM audio format.") }
        var values = [Float](repeating: 0, count: length / MemoryLayout<Float>.size)
        let status = values.withUnsafeMutableBytes { data in
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: data.baseAddress!)
        }
        guard status == kCMBlockBufferNoErr else { throw CompassError.invalid("An audio sample could not be read.") }
        return values
    }
}
