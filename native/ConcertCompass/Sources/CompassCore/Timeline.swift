import Foundation

public enum Timeline {
    public static func build(_ plan: EditPlan) throws -> [TimelineShot] {
        try validateSettings(plan.settings)
        let moments = plan.moments.filter(\.approved)
        guard !moments.isEmpty else { throw CompassError.invalid("Approve at least one moment before rendering.") }
        guard moments.count <= 60 else { throw CompassError.invalid("This alpha supports up to 60 moments per reel.") }
        var output: [TimelineShot] = []
        var cursor = 0.0
        for (index, moment) in moments.enumerated() {
            guard moment.start.isFinite, moment.start >= 0, moment.duration.isFinite, moment.duration >= 0.1,
                  moment.focusX.isFinite, moment.focusY.isFinite, (0...1).contains(moment.focusX), (0...1).contains(moment.focusY) else {
                throw CompassError.invalid("A trim or framing value is invalid. Please revise that moment.")
            }
            var kind: TransitionKind = .cut
            var overlap = 0.0
            if index > 0 {
                let previous = moments[index - 1]
                switch plan.settings.transitions {
                case .cuts: kind = .cut
                case .dissolves: kind = .dissolve
                case .automatic:
                    let calm = plan.settings.style == .cinematic || plan.settings.style == .memory
                    let storyBreath = moment.role == .payoff || moment.role == .end || (calm && index % 4 == 0)
                    kind = calm && storyBreath && previous.clipID != moment.clipID ? .dissolve : .cut
                }
                if kind == .dissolve {
                    overlap = frameRound(min(0.32, min(previous.duration, moment.duration) / 4))
                }
            }
            let at = frameRound(max(0, cursor - overlap))
            output.append(TimelineShot(moment: moment, at: at, incoming: kind, overlap: overlap))
            cursor = frameRound(at + moment.duration)
        }
        guard cursor <= 120.01 else { throw CompassError.invalid("This alpha limits one reel to two minutes. Shorten your edit.") }
        return output
    }

    public static func duration(_ plan: EditPlan) -> Double { (try? build(plan).last?.end) ?? 0 }

    public static func validate(_ plan: EditPlan, clips: [MediaClip]) throws {
        guard Set(clips.map(\.id)).count == clips.count else { throw CompassError.invalid("Duplicate source identifiers.") }
        guard Set(plan.moments.map(\.id)).count == plan.moments.count else { throw CompassError.invalid("Duplicate moment identifiers.") }
        for clip in clips {
            guard clip.duration.isFinite, clip.duration > 0, clip.duration <= 600,
                  clip.width.isFinite, clip.width > 0, clip.height.isFinite, clip.height > 0,
                  clip.mediaStart.isFinite, clip.mediaStart >= 0,
                  !clip.fileName.isEmpty, clip.fileName == URL(fileURLWithPath: clip.fileName).lastPathComponent,
                  !clip.fileName.contains(".."), !clip.fileName.contains("\\") else {
                throw CompassError.invalid("A source file is invalid or exceeds the ten-minute limit.")
            }
        }
        let byID = Dictionary(uniqueKeysWithValues: clips.map { ($0.id, $0) })
        for moment in plan.moments where moment.approved {
            guard let source = byID[moment.clipID], moment.end <= source.duration + 0.002 else {
                throw CompassError.invalid("A selected moment extends beyond its source. Adjust the trim.")
            }
        }
        let timeline = try build(plan)
        if let master = plan.settings.masterAudioClipID {
            guard let clip = byID[master], clip.hasAudio, clip.duration + 0.002 >= (timeline.last?.end ?? 0) else {
                throw CompassError.invalid("Your continuous audio clip must contain audio and cover the entire reel without looping.")
            }
        }
    }
    public static func validateSettings(_ settings: EditSettings) throws {
        guard [15.0, 30.0, 45.0, 60.0].contains(settings.targetSeconds) else {
            throw CompassError.invalid("Choose a 15-, 30-, 45-, or 60-second target.")
        }
    }

    public static func roles(count: Int, mode: EditMode) -> [StoryRole] {
        guard count > 0 else { return [] }
        if count == 1 { return [.hook] }
        if count == 2 { return [.hook, .end] }
        if count == 3 { return [.hook, .peak, .end] }
        if count == 4 { return [.hook, .establish, .peak, .end] }
        if count == 5 { return [.hook, .establish, .build, .peak, .end] }
        return [.hook, .establish] + Array(repeating: .build, count: count - 5) + [.peak, .payoff, .end]
    }
}
