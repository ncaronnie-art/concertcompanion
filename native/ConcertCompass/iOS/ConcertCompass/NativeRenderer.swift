import AVFoundation
import CoreGraphics
import Foundation
import CompassCore

actor NativeRenderer {
    struct Result: Sendable { let url: URL; let warnings: [String] }
    private struct Layer {
        var shot: TimelineShot
        var track: AVMutableCompositionTrack
        var natural: CGSize
        var preferred: CGAffineTransform
        var corrections: [MotionPoint]
    }

    func render(plan: EditPlan, clips: [MediaClip], progress: @escaping @Sendable (Double, String) -> Void) async throws -> Result {
        try Timeline.validate(plan, clips: clips)
        let shots = try Timeline.build(plan)
        let total = shots.last!.end
        let byID = Dictionary(uniqueKeysWithValues: clips.map { ($0.id, $0) })
        let composition = AVMutableComposition()
        let canvas = CGSize(width: 1080, height: 1920)
        var layers: [Layer] = []
        var audioParameters: [AVMutableAudioMixInputParameters] = []
        var warnings: [String] = []
        let work = try NativeFiles.directory("Working")
        let raw = work.appendingPathComponent(UUID().uuidString + ".mp4")
        var temporary = [raw]
        defer { for file in temporary { try? FileManager.default.removeItem(at: file) } }

        for (index, shot) in shots.enumerated() {
            try Task.checkCancellation()
            guard let clip = byID[shot.moment.clipID] else { throw CompassError.invalid("A selected source is missing.") }
            let asset = AVURLAsset(url: try NativeFiles.source(clip.fileName))
            guard let sourceVideo = try await asset.loadTracks(withMediaType: .video).first,
                  let destination = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                throw CompassError.invalid("A video track could not be prepared for export.")
            }
            let sourceRange = CMTimeRange(start: time(clip.mediaStart + shot.moment.start), duration: time(shot.moment.duration))
            try destination.insertTimeRange(sourceRange, of: sourceVideo, at: time(shot.at))
            var corrections: [MotionPoint] = []
            if plan.settings.stabilize {
                progress(Double(index) / Double(shots.count) * 0.28, "Measuring camera movement \(index + 1)/\(shots.count)")
                do {
                    corrections = try await stabilize(asset: asset, start: clip.mediaStart + shot.moment.start, duration: shot.moment.duration)
                    if corrections.isEmpty { warnings.append("Motion was not reliable enough to stabilize one moment; it was left unchanged.") }
                }
                catch is CancellationError { throw CancellationError() }
                catch { warnings.append("Stabilization was skipped for one moment; original motion was preserved.") }
            }
            layers.append(Layer(shot: shot, track: destination, natural: try await sourceVideo.load(.naturalSize),
                                preferred: try await sourceVideo.load(.preferredTransform), corrections: corrections))
            if plan.settings.masterAudioClipID == nil, !shot.moment.muted,
               let sourceAudio = try await asset.loadTracks(withMediaType: .audio).first {
                let naturalRange = try await sourceAudio.load(.timeRange)
                let validRange = CMTimeRangeGetIntersection(sourceRange, otherRange: naturalRange)
                if validRange.isValid && validRange.duration.seconds > 0,
                   let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
                    let offset = max(0, validRange.start.seconds - sourceRange.start.seconds)
                    try audioTrack.insertTimeRange(validRange, of: sourceAudio, at: time(shot.at + offset))
                    let parameters = AVMutableAudioMixInputParameters(track: audioTrack)
                    let nextOverlap = index + 1 < shots.count ? shots[index + 1].overlap : 0
                    let fadeIn = min(max(0.012, shot.overlap), validRange.duration.seconds / 4)
                    let fadeOut = min(max(0.012, nextOverlap), validRange.duration.seconds / 4)
                    let audioAt = shot.at + offset
                    let audioEnd = audioAt + validRange.duration.seconds
                    parameters.setVolume(1, at: time(audioAt))
                    parameters.setVolumeRamp(fromStartVolume: 0, toEndVolume: 1, timeRange: CMTimeRange(start: time(audioAt), duration: time(fadeIn)))
                    parameters.setVolumeRamp(fromStartVolume: 1, toEndVolume: 0, timeRange: CMTimeRange(start: time(audioEnd - fadeOut), duration: time(fadeOut)))
                    audioParameters.append(parameters)
                }
            }
        }
        if let masterID = plan.settings.masterAudioClipID, let clip = byID[masterID] {
            let asset = AVURLAsset(url: try NativeFiles.source(clip.fileName))
            guard let source = try await asset.loadTracks(withMediaType: .audio).first,
                  let destination = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                throw CompassError.invalid("The continuous audio source is unavailable.")
            }
            let range = CMTimeRange(start: time(clip.mediaStart), duration: time(total))
            let available = try await source.load(.timeRange)
            guard CMTimeRangeContainsTimeRange(available, otherRange: range) else {
                throw CompassError.invalid("The selected continuous audio does not cover the full edit. Choose source audio instead.")
            }
            try destination.insertTimeRange(range, of: source, at: .zero)
            let parameters = AVMutableAudioMixInputParameters(track: destination)
            parameters.setVolumeRamp(fromStartVolume: 0, toEndVolume: 1, timeRange: CMTimeRange(start: .zero, duration: time(0.04)))
            parameters.setVolumeRamp(fromStartVolume: 1, toEndVolume: 0, timeRange: CMTimeRange(start: time(max(0, total - 0.25)), duration: time(min(0.25, total))))
            audioParameters.append(parameters)
        }
        let video = AVMutableVideoComposition()
        video.renderSize = canvas
        video.frameDuration = CMTime(value: 1, timescale: 30)
        video.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
        video.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
        video.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
        var boundaries = Set<Int64>([0, Int64((total * 600).rounded())])
        for layer in layers {
            boundaries.insert(Int64((layer.shot.at * 600).rounded()))
            boundaries.insert(Int64((layer.shot.end * 600).rounded()))
        }
        let sorted = boundaries.sorted()
        var instructions: [AVMutableVideoCompositionInstruction] = []
        for pair in zip(sorted, sorted.dropFirst()) {
            let start = Double(pair.0) / 600, end = Double(pair.1) / 600
            guard end - start > 0.0001 else { continue }
            let midpoint = (start + end) / 2
            let active = layers.filter { $0.shot.at <= midpoint && $0.shot.end > midpoint }.sorted { $0.shot.at > $1.shot.at }
            guard !active.isEmpty, active.count <= 2 else { throw CompassError.invalid("The edit contains a timing gap. Your selections are saved.") }
            let instruction = AVMutableVideoCompositionInstruction()
            instruction.timeRange = CMTimeRange(start: time(start), end: time(end))
            instruction.backgroundColor = CGColor(gray: 0, alpha: 1)
            instruction.enablePostProcessing = true
            instruction.layerInstructions = active.enumerated().map { position, layer in
                let l = AVMutableVideoCompositionLayerInstruction(assetTrack: layer.track)
                let points = [start] + layer.corrections.map { layer.shot.at + $0.time }.filter { $0 > start && $0 < end } + [end]
                for p in zip(points, points.dropFirst()) {
                    l.setTransformRamp(fromStart: transform(layer, at: p.0, canvas: canvas, stabilize: plan.settings.stabilize),
                                       toEnd: transform(layer, at: p.1, canvas: canvas, stabilize: plan.settings.stabilize),
                                       timeRange: CMTimeRange(start: time(p.0), end: time(p.1)))
                }
                if active.count == 2 && position == 0 && layer.shot.overlap > 0 {
                    let a = Float(clamp((start - layer.shot.at) / layer.shot.overlap, 0, 1))
                    let b = Float(clamp((end - layer.shot.at) / layer.shot.overlap, 0, 1))
                    l.setOpacityRamp(fromStartOpacity: a, toEndOpacity: b, timeRange: instruction.timeRange)
                } else {
                    // Incoming alpha reveals an opaque outgoing layer. Fading both produces a dark dip.
                    l.setOpacity(1, at: time(start))
                }
                return l
            }
            instructions.append(instruction)
        }
        video.instructions = instructions
        let mix = AVMutableAudioMix(); mix.inputParameters = audioParameters
        progress(0.30, "Rendering the complete reel")
        try await export(asset: composition, destination: raw, video: video, mix: mix) { value in
            progress(0.30 + Double(value) * (plan.settings.gentleCleanup ? 0.42 : 0.64), "Rendering the complete reel")
        }
        var final = raw
        if plan.settings.gentleCleanup, !audioParameters.isEmpty {
            let cleaned = work.appendingPathComponent(UUID().uuidString + ".mp4")
            let pcm = work.appendingPathComponent(UUID().uuidString + ".caf")
            temporary += [cleaned, pcm]
            progress(0.73, "Softening low-frequency rumble")
            try await cleanup(source: raw, pcm: pcm, destination: cleaned) { value in
                progress(0.78 + Double(value) * 0.16, "Finishing gentle audio cleanup")
            }
            final = cleaned
            warnings.append("Gentle cleanup reduces low-frequency rumble, not nearby singing or crowd voices.")
        }
        try Task.checkCancellation()
        progress(0.95, "Checking video, sound and duration")
        try await verify(url: final, expectedDuration: total, expectedAudio: !audioParameters.isEmpty)
        let target = try NativeFiles.export(UUID().uuidString + ".mp4")
        try FileManager.default.moveItem(at: final, to: target)
        progress(1, "Your full reel is ready to review")
        return Result(url: target, warnings: warnings)
    }

    private func time(_ value: Double) -> CMTime { CMTime(seconds: value, preferredTimescale: 600) }

    private func transform(_ layer: Layer, at absoluteTime: Double, canvas: CGSize, stabilize: Bool) -> CGAffineTransform {
        let oriented = CGRect(origin: .zero, size: layer.natural).applying(layer.preferred)
        let zoom = stabilize && !layer.corrections.isEmpty ? 1.08 : 1
        let scale = max(canvas.width / abs(oriented.width), canvas.height / abs(oriented.height)) * zoom
        let overflowX = max(0, abs(oriented.width) * scale - canvas.width)
        let overflowY = max(0, abs(oriented.height) * scale - canvas.height)
        var x = -overflowX * layer.shot.moment.focusX
        var y = -overflowY * layer.shot.moment.focusY
        let local = clamp(absoluteTime - layer.shot.at, 0, layer.shot.moment.duration)
        if stabilize, !layer.corrections.isEmpty {
            let after = layer.corrections.firstIndex { $0.time >= local } ?? (layer.corrections.count - 1)
            let before = max(0, after - 1)
            let a = layer.corrections[before], b = layer.corrections[after]
            let mix = b.time > a.time ? clamp((local - a.time) / (b.time - a.time), 0, 1) : 0
            let cx = (a.x + (b.x - a.x) * mix) * abs(oriented.width) * scale
            let cy = (a.y + (b.y - a.y) * mix) * abs(oriented.height) * scale
            x += clamp(cx, -canvas.width * 0.03, canvas.width * 0.03)
            y += clamp(cy, -canvas.height * 0.03, canvas.height * 0.03)
            // Never expose edges, even for off-center user framing.
            x = clamp(x, -overflowX, 0); y = clamp(y, -overflowY, 0)
        }
        return layer.preferred
            .concatenating(CGAffineTransform(translationX: -oriented.minX, y: -oriented.minY))
            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
            .concatenating(CGAffineTransform(translationX: x, y: y))
    }

    private func stabilize(asset: AVAsset, start: Double, duration: Double) async throws -> [MotionPoint] {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 160, height: 160)
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        var path: [MotionPoint] = []
        var previous: GrayFrame? = nil
        var x = 0.0, y = 0.0, valid = 0
        let sampleTimes = stride(from: 0.0, to: max(0.01, duration - 0.035), by: 0.1).map { $0 }
        for t in sampleTimes {
            try Task.checkCancellation()
            let image = try await generator.image(at: time(start + t)).image
            let current = try GrayFrame(image: image, maxSide: 160)
            if let previous, previous.width == current.width, previous.height == current.height {
                let motion = Stabilization.translation(previous: previous.pixels, current: current.pixels,
                                                       width: current.width, height: current.height)
                if motion.reliable {
                    x += motion.x / Double(current.width); y += motion.y / Double(current.height); valid += 1
                }
            }
            path.append(MotionPoint(time: t, x: x, y: y)); previous = current
        }
        guard valid > max(1, path.count / 3) else { return [] }
        return Stabilization.corrections(path: path)
    }

    private func export(asset: AVAsset, destination: URL, video: AVVideoComposition? = nil, mix: AVAudioMix? = nil,
                        progress: @escaping @Sendable (Float) -> Void) async throws {
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset1920x1080),
              session.supportedFileTypes.contains(.mp4) else { throw CompassError.invalid("This device could not prepare an MP4 export.") }
        session.outputURL = destination; session.outputFileType = .mp4; session.shouldOptimizeForNetworkUse = true
        session.videoComposition = video; session.audioMix = mix; session.metadata = []
        let cancellation = ExportCancellation(session)
        let monitor = Task {
            while !Task.isCancelled {
                progress(session.progress)
                try? await Task.sleep(nanoseconds: 180_000_000)
            }
        }
        defer { monitor.cancel() }
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let started = cancellation.start {
                    switch session.status {
                    case .completed: continuation.resume()
                    case .cancelled: continuation.resume(throwing: CancellationError())
                    default: continuation.resume(throwing: session.error ?? CompassError.invalid("Export stopped before completion. Your edit is saved."))
                    }
                }
                if !started { continuation.resume(throwing: CancellationError()) }
            }
        } onCancel: { cancellation.cancel() }
        try Task.checkCancellation()
    }

    private func cleanup(source: URL, pcm: URL, destination: URL, progress: @escaping @Sendable (Float) -> Void) async throws {
        let asset = AVURLAsset(url: source)
        guard let audio = try await asset.loadTracks(withMediaType: .audio).first,
              let video = try await asset.loadTracks(withMediaType: .video).first else { throw CompassError.invalid("The exported audio could not be opened for cleanup.") }
        let duration = try await asset.load(.duration)
        let reader = try AVAssetReader(asset: asset)
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000,
                                       AVNumberOfChannelsKey: 2, AVLinearPCMBitDepthKey: 32,
                                       AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false,
                                       AVLinearPCMIsBigEndianKey: false]
        let output = AVAssetReaderTrackOutput(track: audio, outputSettings: settings)
        guard reader.canAdd(output) else { throw CompassError.invalid("Audio cleanup is unavailable for this format.") }
        reader.add(output)
        guard reader.startReading(), let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2) else {
            throw reader.error ?? CompassError.invalid("Audio cleanup could not start.")
        }
        defer { if reader.status == .reading { reader.cancelReading() } }
        var writer: AVAudioFile? = try AVAudioFile(forWriting: pcm, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        var filters = [GentleAudioFilter(sampleRate: 48000), GentleAudioFilter(sampleRate: 48000)]
        while let sample = output.copyNextSampleBuffer() {
            try Task.checkCancellation()
            let data = try AudioReader.floats(sample)
            let frames = data.count / 2
            guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
                  let channels = buffer.floatChannelData else { continue }
            buffer.frameLength = AVAudioFrameCount(frames)
            for frame in 0..<frames { for channel in 0..<2 { channels[channel][frame] = filters[channel].process(data[frame * 2 + channel]) } }
            try writer?.write(from: buffer)
        }
        if reader.status == .failed { throw reader.error ?? CompassError.invalid("Audio cleanup was interrupted.") }
        writer = nil // Finalize the CAF header before reopening it.
        let cleanAsset = AVURLAsset(url: pcm)
        guard let cleanAudio = try await cleanAsset.loadTracks(withMediaType: .audio).first else { throw CompassError.invalid("The cleaned audio file is incomplete.") }
        let cleanRange = try await cleanAudio.load(.timeRange)
        let mix = AVMutableComposition()
        guard let videoTrack = mix.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
              let audioTrack = mix.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw CompassError.invalid("Could not assemble the cleaned reel.")
        }
        try videoTrack.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: video, at: .zero)
        videoTrack.preferredTransform = try await video.load(.preferredTransform)
        try audioTrack.insertTimeRange(CMTimeRange(start: cleanRange.start, duration: CMTimeMinimum(duration, cleanRange.duration)), of: cleanAudio, at: .zero)
        try await export(asset: mix, destination: destination, progress: progress)
    }

    private func verify(url: URL, expectedDuration: Double, expectedAudio: Bool) async throws {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        let tracks = try await asset.loadTracks(withMediaType: .video)
        guard let video = tracks.first, duration.isFinite, abs(duration - expectedDuration) < 0.15 else {
            throw CompassError.invalid("The rendered duration did not pass verification. Nothing was saved to Photos.")
        }
        let size = try await video.load(.naturalSize)
        let transform = try await video.load(.preferredTransform)
        let actual = CGRect(origin: .zero, size: size).applying(transform)
        guard abs(abs(actual.width) - 1080) < 2, abs(abs(actual.height) - 1920) < 2 else {
            throw CompassError.invalid("The output did not preserve the required 9:16 dimensions.")
        }
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        if expectedAudio && audioTracks.isEmpty {
            throw CompassError.invalid("The output is missing audio. Nothing was saved to Photos.")
        }
        let descriptions = try await video.load(.formatDescriptions)
        guard descriptions.contains(where: { CMFormatDescriptionGetMediaSubType($0) == kCMVideoCodecType_H264 }) else {
            throw CompassError.invalid("The output was not H.264. Device compatibility must be checked before sharing.")
        }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        for point in [0.05, duration / 2, max(0, duration - 0.08)] {
            _ = try await generator.image(at: time(min(point, max(0, duration - 0.01))))
        }
    }
}

private final class ExportCancellation: @unchecked Sendable {
    private let session: AVAssetExportSession
    private let lock = NSLock()
    private var cancelled = false
    init(_ session: AVAssetExportSession) { self.session = session }
    func start(_ completion: @escaping @Sendable () -> Void) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !cancelled else { return false }
        session.exportAsynchronously(completionHandler: completion)
        return true
    }
    func cancel() {
        lock.lock(); defer { lock.unlock() }
        cancelled = true; session.cancelExport()
    }
}
