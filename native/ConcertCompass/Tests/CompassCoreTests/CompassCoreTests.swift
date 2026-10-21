import XCTest
@testable import CompassCore

final class CompassCoreTests: XCTestCase {
    func source(_ duration: Double = 30, name: String = "clip.mov", energy: Double = 0.6) -> MediaClip {
        let audio: [AudioWindow] = (0..<max(1, Int(duration * 10))).map { i in
            let bonus: Double = i % 13 == 0 ? 0.2 : 0
            let onset: Double = i % 5 == 0 ? 0.8 : 0
            return AudioWindow(time: Double(i) / 10, energy: energy + bonus, onset: onset)
        }
        let visual: [VisualWindow] = (0..<max(1, Int(duration))).map { i in
            VisualWindow(time: Double(i), sharpness: 0.7, brightness: 0.3, shake: 0.12)
        }
        return MediaClip(name: name, fileName: UUID().uuidString + ".mov", duration: duration,
                         audio: audio, visual: visual)
    }
    func makeSettings(_ target: Double = 15, style: EditStyle = .memory, transition: TransitionPreference = .automatic) -> EditSettings {
        var s = EditSettings(); s.targetSeconds = target; s.style = style; s.transitions = transition; return s
    }
    func testOneShortClipIsNotLooped() throws {
        let clip = source(2)
        let plan = try Planner.propose(clips: [clip], settings: makeSettings())
        XCTAssertLessThanOrEqual(Timeline.duration(plan), 2.001)
        XCTAssertTrue(plan.warnings.contains { $0.contains("No footage was looped") })
        assertNoRepeatedSourceRanges(plan)
    }
    func testTinyClipIsAccepted() throws {
        let plan = try Planner.propose(clips: [source(0.12)], settings: makeSettings())
        XCTAssertEqual(Timeline.duration(plan), 0.12, accuracy: 0.002)
    }
    func testEmptyInputFailsClearly() { XCTAssertThrowsError(try Planner.propose(clips: [], settings: makeSettings())) }
    func testInvalidDurationRejected() { XCTAssertThrowsError(try Planner.propose(clips: [source()], settings: makeSettings(17))) }
    func testNaNRejected() throws {
        var c = source(); c.duration = .nan
        XCTAssertThrowsError(try Planner.propose(clips: [c], settings: makeSettings()))
    }
    func testDuplicateSourceIDsRejected() { let c = source(); XCTAssertThrowsError(try Planner.propose(clips: [c, c], settings: makeSettings())) }
    func testTooManySourcesRejected() { XCTAssertThrowsError(try Planner.propose(clips: (0..<13).map { _ in source(1) }, settings: makeSettings())) }
    func testTargetsWhenEnoughFootage() throws {
        for target in Timeline.supportedTargetSeconds {
            for transition in TransitionPreference.allCases {
                let clips = [source(105), source(105), source(105)]
                let plan = try Planner.propose(clips: clips, settings: makeSettings(target, transition: transition))
                XCTAssertEqual(Timeline.duration(plan), target, accuracy: 0.08, "target \(target), \(transition)")
                try Timeline.validate(plan, clips: clips)
                assertNoRepeatedSourceRanges(plan)
            }
        }
    }
    func testFiveMinuteCompilationCanUseMoreThanSixtyNaturalMoments() throws {
        let clips = [source(105), source(105), source(105)]
        let plan = try Planner.propose(clips: clips, settings: makeSettings(300, style: .hype, transition: .dissolves))
        XCTAssertGreaterThan(plan.moments.filter(\.approved).count, 60)
        XCTAssertLessThanOrEqual(plan.moments.filter(\.approved).count, Timeline.maximumMoments)
        XCTAssertEqual(Timeline.duration(plan), 300, accuracy: 0.08)
        try Timeline.validate(plan, clips: clips)
    }
    func testDefaultPlanUsesSeveralSources() throws {
        let clips = [source(20), source(20), source(20)]
        let plan = try Planner.propose(clips: clips, settings: makeSettings())
        XCTAssertEqual(Set(plan.moments.map(\.clipID)).count, 3)
    }
    func testStoryArcIsOrdered() throws {
        let plan = try Planner.propose(clips: [source(60), source(60)], settings: makeSettings(30))
        XCTAssertEqual(plan.moments.first?.role, .hook)
        XCTAssertEqual(plan.moments.last?.role, .end)
        XCTAssertEqual(plan.moments.map(\.role).filter { $0 != .build }, [.hook, .establish, .peak, .payoff, .end])
    }
    func testNoTitleOrBlankLeadIn() throws {
        let plan = try Planner.propose(clips: [source()], settings: makeSettings())
        let timeline = try Timeline.build(plan)
        XCTAssertEqual(timeline.first?.at, 0)
        XCTAssertEqual(timeline.first?.incoming, .cut)
    }
    func testDissolvesChangeTimelineLength() throws {
        let clip = source()
        let shots = [Moment(clipID: clip.id, start: 0, duration: 3), Moment(clipID: clip.id, start: 5, duration: 3)]
        let plan = EditPlan(settings: makeSettings(transition: .dissolves), moments: shots)
        XCTAssertEqual(Timeline.duration(plan), 5.68, accuracy: 0.001)
    }
    func testTinyDissolvesNeverTripleOverlap() throws {
        let clip = source()
        let moments = (0..<10).map { Moment(clipID: clip.id, start: Double($0), duration: 0.12) }
        let timeline = try Timeline.build(EditPlan(settings: makeSettings(transition: .dissolves), moments: moments))
        for time in stride(from: 0.0, to: timeline.last!.end, by: 0.005) {
            XCTAssertLessThanOrEqual(timeline.filter { $0.at <= time && $0.end > time }.count, 2)
        }
    }
    func testCutsHaveNoOverlap() throws {
        let plan = try Planner.propose(clips: [source(), source()], settings: makeSettings(transition: .cuts))
        XCTAssertTrue(try Timeline.build(plan).allSatisfy { $0.incoming == .cut && $0.overlap == 0 })
    }
    func testLockPreservesSourceTrimAndFraming() throws {
        let clips = [source(), source()]
        var plan = try Planner.propose(clips: clips, settings: makeSettings())
        plan.moments[2].locked = true; plan.moments[2].focusX = 0.3; plan.moments[2].muted = true
        let locked = plan.moments[2]
        let next = try Planner.propose(clips: clips, settings: plan.settings, previous: plan, seed: 4)
        XCTAssertEqual(next.moments[2], locked)
    }
    func testRegenerationChangesUnlockedEdit() throws {
        let clips = [source(), source()]
        let original = try Planner.propose(clips: clips, settings: makeSettings())
        let new = try Planner.propose(clips: clips, settings: original.settings, previous: original, seed: 7)
        XCTAssertNotEqual(original.moments.map(\.start), new.moments.map(\.start))
    }
    func testRejectedRangeStaysRejected() throws {
        let clips = [source(), source()]
        var plan = try Planner.propose(clips: clips, settings: makeSettings())
        plan.moments[0].approved = false
        let rejected = plan.moments[0]
        let next = try Planner.propose(clips: clips, settings: plan.settings, previous: plan, seed: 2)
        for m in next.moments where m.approved && m.clipID == rejected.clipID {
            XCTAssertTrue(m.end <= rejected.start + 0.003 || m.start >= rejected.end - 0.003)
        }
        XCTAssertTrue(next.moments.contains { $0.id == rejected.id && !$0.approved })
    }
    func testAllRejectedFails() throws {
        let clip = source(2)
        var m = Moment(clipID: clip.id, start: 0, duration: 2); m.approved = false
        let p = EditPlan(settings: makeSettings(), moments: [m])
        XCTAssertThrowsError(try Planner.propose(clips: [clip], settings: p.settings, previous: p))
    }
    func testTrailerPacingDiffers() throws {
        let clips = [source(60), source(60)]
        let highlight = try Planner.propose(clips: clips, settings: makeSettings(30))
        var settings = makeSettings(30); settings.mode = .trailer
        let trailer = try Planner.propose(clips: clips, settings: settings)
        XCTAssertNotEqual(highlight.moments.map(\.duration), trailer.moments.map(\.duration))
    }
    func testSurpriseResolvesToConcreteStyle() throws {
        let p = try Planner.propose(clips: [source()], settings: makeSettings(style: .surprise))
        XCTAssertNotEqual(p.settings.style, .surprise)
    }
    func testTrimOutsideSourceRejected() throws {
        let c = source(3)
        let p = EditPlan(settings: makeSettings(), moments: [Moment(clipID: c.id, start: 2, duration: 2)])
        XCTAssertThrowsError(try Timeline.validate(p, clips: [c]))
    }
    func testPathTraversalRejected() throws {
        var c = source(); c.fileName = "../private.mov"
        let p = EditPlan(settings: makeSettings(), moments: [Moment(clipID: c.id, start: 0, duration: 2)])
        XCTAssertThrowsError(try Timeline.validate(p, clips: [c]))
    }
    func testInvalidCropRejected() throws {
        let c = source(); var m = Moment(clipID: c.id, start: 0, duration: 2); m.focusX = 2
        XCTAssertThrowsError(try Timeline.build(EditPlan(settings: makeSettings(), moments: [m])))
    }
    func testNoApprovedMomentsRejected() {
        let c = source(); let m = Moment(clipID: c.id, start: 0, duration: 2, approved: false)
        XCTAssertThrowsError(try Timeline.build(EditPlan(settings: makeSettings(), moments: [m])))
    }
    func testMasterAudioMustCoverTimeline() throws {
        let c = source(2), d = source(40)
        var s = makeSettings(); s.masterAudioClipID = c.id
        let p = EditPlan(settings: s, moments: [Moment(clipID: d.id, start: 0, duration: 10)])
        XCTAssertThrowsError(try Timeline.validate(p, clips: [c, d]))
    }
    func testMasterAudioCannotBeSilent() throws {
        var c = source(); c.hasAudio = false
        var s = makeSettings(); s.masterAudioClipID = c.id
        let p = EditPlan(settings: s, moments: [Moment(clipID: c.id, start: 0, duration: 3)])
        XCTAssertThrowsError(try Timeline.validate(p, clips: [c]))
    }
    func testSourceMuteDoesNotRemoveVideo() throws {
        let c = source(); let m = Moment(clipID: c.id, start: 0, duration: 3, muted: true)
        XCTAssertEqual(Timeline.duration(EditPlan(settings: makeSettings(), moments: [m])), 3)
    }
    func testPlanRoundTripsThroughJSON() throws {
        let p = try Planner.propose(clips: [source()], settings: makeSettings())
        XCTAssertEqual(p, try JSONDecoder().decode(EditPlan.self, from: JSONEncoder().encode(p)))
    }
    func testPromptMakesSafeDirectives() {
        let r = PromptDirector.interpret("45 seconds, cinematic with soft transitions; reduce crowd and stabilize", base: makeSettings())
        XCTAssertEqual(r.settings.targetSeconds, 45); XCTAssertEqual(r.settings.style, .cinematic)
        XCTAssertEqual(r.settings.transitions, .dissolves); XCTAssertTrue(r.settings.gentleCleanup); XCTAssertTrue(r.settings.stabilize)
    }
    func testPromptRecognizesFiveMinuteCompilation() {
        let r = PromptDirector.interpret("5 minutes, cinematic with soft transitions", base: makeSettings())
        XCTAssertEqual(r.settings.targetSeconds, 300)
        XCTAssertTrue(r.understood.contains("5-minute compilation"))
    }
    func testPromptNegationWinsForCutsAndCleanup() {
        let r = PromptDirector.interpret("cinematic, crossfade, but cuts only. Clean the audio? No cleanup. Don't stabilize.", base: makeSettings())
        XCTAssertEqual(r.settings.transitions, .cuts); XCTAssertFalse(r.settings.gentleCleanup); XCTAssertFalse(r.settings.stabilize)
    }
    func testNoFastCutsDoesNotSelectHype() {
        XCTAssertEqual(PromptDirector.interpret("No fast cuts, nostalgic", base: makeSettings()).settings.style, .memory)
    }
    func testUnknownPromptDoesNotInventFeatures() {
        let base = makeSettings()
        let r = PromptDirector.interpret("make a dragon sing the entire set", base: base)
        XCTAssertEqual(r.settings.style, base.style)
        XCTAssertTrue(r.warnings.contains { $0.contains("No supported") })
    }
    func testCrowdIsolationIsNotPromised() {
        let r = PromptDirector.interpret("Remove all the screaming and isolate the singer", base: makeSettings())
        XCTAssertTrue(r.warnings.contains { $0.contains("cannot be cleanly removed") })
    }
    func testStructuredAIOutputIsAllowListed() {
        XCTAssertThrowsError(try PromptDirector.applyModel(style: "runShell", mode: "highlight", transition: "dissolves", seconds: 30, cleanup: false, stabilization: false, to: makeSettings()))
    }
    func testStructuredAIValidOutput() throws {
        let result = try PromptDirector.applyModel(style: "hype", mode: "trailer", transition: "cuts", seconds: 15, cleanup: true, stabilization: false, to: makeSettings())
        XCTAssertEqual(result.style, .hype); XCTAssertEqual(result.mode, .trailer)
    }
    func testSilenceProducesFiniteFeatures() {
        let features = SignalTools.normalizedAudio(rms: [0, 0, .nan, 0], clipping: [])
        XCTAssertTrue(features.allSatisfy { $0.energy.isFinite && $0.energy == 0 && $0.onset.isFinite })
    }
    func testOnsetsReactToRisingEnergy() {
        let frames = SignalTools.normalizedAudio(rms: [0.1, 0.1, 0.9, 0.1], clipping: [0, 0, 0.1, 0])
        XCTAssertGreaterThan(frames[2].onset, frames[1].onset); XCTAssertEqual(frames[2].clipping, 0.1)
    }
    func testFlatFrameHasNoSharpness() {
        let stats = SignalTools.visualStatistics(gray: Array(repeating: 60, count: 64 * 64), width: 64, height: 64)
        XCTAssertEqual(stats.sharpness, 0); XCTAssertEqual(stats.brightness, 60.0 / 255, accuracy: 0.001)
    }
    func testKnownTranslationIsRecovered() {
        var rng = SeededRandom(seed: 43)
        let w = 64, h = 64
        let previous = (0..<w * h).map { _ in UInt8(rng.nextUnit() * 255) }
        var current = Array(repeating: UInt8(0), count: w * h)
        for y in 1..<h { for x in 0..<(w - 2) { current[(y - 1) * w + x + 2] = previous[y * w + x] } }
        let m = Stabilization.translation(previous: previous, current: current, width: w, height: h)
        XCTAssertTrue(m.reliable); XCTAssertEqual(m.x, 2); XCTAssertEqual(m.y, -1)
    }
    func testDarkMotionIsNotTrusted() {
        let black = Array(repeating: UInt8(0), count: 64 * 64)
        XCTAssertFalse(Stabilization.translation(previous: black, current: black, width: 64, height: 64).reliable)
    }
    func testStabilizationLimitsCropAndPreservesEndpoints() {
        let path = (0..<20).map { MotionPoint(time: Double($0) / 10, x: $0 % 2 == 0 ? -0.1 : 0.1, y: 0) }
        let corrections = Stabilization.corrections(path: path)
        XCTAssertTrue(corrections.allSatisfy { abs($0.x) <= 0.025 })
        XCTAssertEqual(corrections.first?.x, 0); XCTAssertEqual(corrections.last?.x, 0)
    }
    func testSteadyPanIsNotFrozen() {
        let path = (0..<20).map { MotionPoint(time: Double($0) / 10, x: Double($0) * 0.001, y: 0) }
        let corrections = Stabilization.corrections(path: path)
        for point in corrections[4..<16] { XCTAssertEqual(point.x, 0, accuracy: 1e-8) }
    }
    func testAudioCleanupAttenuatesRumbleMoreThanMusicBand() {
        func gain(_ frequency: Double) -> Double {
            var filter = GentleAudioFilter(sampleRate: 48000)
            var inputEnergy = 0.0, outputEnergy = 0.0
            for n in 0..<48000 {
                let x = Float(0.3 * sin(2 * .pi * frequency * Double(n) / 48000))
                let y = filter.process(x)
                if n > 1000 { inputEnergy += Double(x * x); outputEnergy += Double(y * y) }
            }
            return sqrt(outputEnergy / inputEnergy)
        }
        XCTAssertLessThan(gain(20), 0.75)
        XCTAssertGreaterThan(gain(1000), 0.97)
    }
    func testAudioCleanupHandlesNaNAndClipping() {
        var filter = GentleAudioFilter(sampleRate: 48000)
        XCTAssertTrue(filter.process(.nan).isFinite)
        XCTAssertLessThanOrEqual(abs(filter.process(10)), 1)
    }
    func testPlannerPropertiesAcrossStylesAndShortFootage() throws {
        for style in EditStyle.allCases {
            for length in [0.5, 3.0, 13.0, 40.0] {
                let clips = [source(length), source(length + 1)]
                let p = try Planner.propose(clips: clips, settings: makeSettings(style: style), seed: 3)
                try Timeline.validate(p, clips: clips)
                assertNoRepeatedSourceRanges(p)
                XCTAssertGreaterThan(Timeline.duration(p), 0)
            }
        }
    }
    private func assertNoRepeatedSourceRanges(_ plan: EditPlan, file: StaticString = #filePath, line: UInt = #line) {
        let active = plan.moments.filter(\.approved)
        for i in active.indices { for j in active.indices where j > i && active[i].clipID == active[j].clipID {
            XCTAssertTrue(active[i].end <= active[j].start + 0.005 || active[j].end <= active[i].start + 0.005,
                          "Repeated source ranges", file: file, line: line)
        } }
    }
}
