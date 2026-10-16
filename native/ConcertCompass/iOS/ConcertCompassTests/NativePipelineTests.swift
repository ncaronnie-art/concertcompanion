import XCTest
import AVFoundation
import CompassCore
@testable import ConcertCompass

/// Apple-only integration gates. These are NOT claimed as passed in the Linux QA report.
final class NativePipelineTests: XCTestCase {
    private func importFixture(_ name: String, ext: String = "mp4") async throws -> MediaClip {
        let bundle = Bundle(for: Self.self)
        let source = try XCTUnwrap(bundle.url(forResource: name, withExtension: ext))
        let destination = try NativeFiles.directory("Sources").appendingPathComponent(UUID().uuidString + "." + ext)
        try FileManager.default.copyItem(at: source, to: destination)
        return try await NativeAnalyzer().analyze(url: destination, name: name, progress: { _ in })
    }
    private func clean(_ clips: [MediaClip], output: URL? = nil) {
        for clip in clips { if let url = try? NativeFiles.source(clip.fileName) { try? FileManager.default.removeItem(at: url) } }
        if let output { try? FileManager.default.removeItem(at: output) }
    }
    func testMixedOrientationDissolveWithSound() async throws {
        let a = try await importFixture("portrait_h264")
        let b = try await importFixture("landscape_h264")
        defer { clean([a, b]) }
        XCTAssertGreaterThan(a.height, a.width); XCTAssertGreaterThan(b.width, b.height)
        var settings = EditSettings(); settings.targetSeconds = 15; settings.transitions = .dissolves
        let plan = EditPlan(settings: settings, moments: [
            Moment(clipID: a.id, start: 0.1, duration: 2.5, role: .hook),
            Moment(clipID: b.id, start: 0.1, duration: 2.5, role: .end)
        ])
        let result = try await NativeRenderer().render(plan: plan, clips: [a, b], progress: { _, _ in })
        defer { clean([], output: result.url) }
        let output = AVURLAsset(url: result.url)
        let duration = try await output.load(.duration).seconds
        XCTAssertEqual(duration, Timeline.duration(plan), accuracy: 0.15)
        let audioTracks = try await output.loadTracks(withMediaType: .audio)
        let audio = try XCTUnwrap(audioTracks.first)
        let measured = try AudioReader.windows(asset: output, track: audio, range: CMTimeRange(start: .zero, duration: CMTime(seconds: duration, preferredTimescale: 600)))
        XCTAssertTrue(measured.contains { $0.energy > 0.1 })
        let generator = AVAssetImageGenerator(asset: output); generator.appliesPreferredTrackTransform = true
        for t in [0.05, 2.2, 2.35, 2.48, 4.5] {
            let frame = try await generator.image(at: CMTime(seconds: t, preferredTimescale: 600)).image
            XCTAssertEqual(frame.width, 1080); XCTAssertEqual(frame.height, 1920)
            let gray = try GrayFrame(image: frame, maxSide: 64)
            XCTAssertGreaterThan(SignalTools.visualStatistics(gray: gray.pixels, width: gray.width, height: gray.height).brightness, 0.04)
        }
    }
    func testSilentVideoIsSupportedWithoutInventedAudio() async throws {
        let clip = try await importFixture("silent_h264")
        defer { clean([clip]) }
        XCTAssertFalse(clip.hasAudio)
        let plan = EditPlan(settings: EditSettings(), moments: [Moment(clipID: clip.id, start: 0, duration: 1.5)])
        let result = try await NativeRenderer().render(plan: plan, clips: [clip], progress: { _, _ in })
        defer { clean([], output: result.url) }
        let tracks = try await AVURLAsset(url: result.url).loadTracks(withMediaType: .audio)
        XCTAssertTrue(tracks.isEmpty)
    }
    func testHEVCMain10MOVImportAndH264Export() async throws {
        let clip = try await importFixture("portrait_hevc", ext: "mov")
        defer { clean([clip]) }
        let plan = EditPlan(settings: EditSettings(), moments: [Moment(clipID: clip.id, start: 0.05, duration: 1.5)])
        let result = try await NativeRenderer().render(plan: plan, clips: [clip], progress: { _, _ in })
        defer { clean([], output: result.url) }
        let tracks = try await AVURLAsset(url: result.url).loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let descriptions = try await track.load(.formatDescriptions)
        XCTAssertTrue(descriptions.contains { CMFormatDescriptionGetMediaSubType($0) == kCMVideoCodecType_H264 })
    }
    func testCleanupAndStabilizationFinishWithoutDroppingSound() async throws {
        let clip = try await importFixture("portrait_h264")
        defer { clean([clip]) }
        var settings = EditSettings(); settings.gentleCleanup = true; settings.stabilize = true
        let plan = EditPlan(settings: settings, moments: [Moment(clipID: clip.id, start: 0.1, duration: 2.5)])
        let result = try await NativeRenderer().render(plan: plan, clips: [clip], progress: { _, _ in })
        defer { clean([], output: result.url) }
        let tracks = try await AVURLAsset(url: result.url).loadTracks(withMediaType: .audio)
        XCTAssertFalse(tracks.isEmpty)
        XCTAssertTrue(result.warnings.contains { $0.contains("rumble") })
    }
    func testCancelledExportDoesNotReturnAShareableFile() async throws {
        let clip = try await importFixture("portrait_h264")
        defer { clean([clip]) }
        let plan = EditPlan(settings: EditSettings(), moments: [Moment(clipID: clip.id, start: 0, duration: 2.5)])
        let task = Task { try await NativeRenderer().render(plan: plan, clips: [clip], progress: { _, _ in }) }
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled export completed unexpectedly.") }
        catch is CancellationError { }
    }
}
