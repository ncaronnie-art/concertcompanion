import Foundation

public enum EditMode: String, Codable, CaseIterable, Sendable { case highlight, trailer }
public enum EditStyle: String, Codable, CaseIterable, Sendable {
    case cinematic, hype, memory, musicVideo, surprise
    public var label: String {
        switch self {
        case .cinematic: return "Cinematic"
        case .hype: return "Hype"
        case .memory: return "Memory"
        case .musicVideo: return "Music Video"
        case .surprise: return "Surprise Me"
        }
    }
    // Port of the existing editmodes.ts pacing intentions; these are presets, not ML.
    public var averageShot: Double {
        switch self {
        case .cinematic: return 2.9
        case .hype: return 1.6
        case .memory, .surprise: return 2.2
        case .musicVideo: return 1.8
        }
    }
}
public enum TransitionPreference: String, Codable, CaseIterable, Sendable { case automatic, cuts, dissolves }
public enum TransitionKind: String, Codable, Sendable { case cut, dissolve }
public enum StoryRole: String, Codable, CaseIterable, Sendable { case hook, establish, build, peak, payoff, end }

public struct EditSettings: Codable, Equatable, Sendable {
    public var mode: EditMode = .highlight
    public var style: EditStyle = .memory
    public var targetSeconds: Double = 30
    public var transitions: TransitionPreference = .automatic
    public var gentleCleanup: Bool = false
    public var stabilize: Bool = false
    public var prompt: String = ""
    public var masterAudioClipID: UUID? = nil
    public init() {}
}

public struct AudioWindow: Codable, Equatable, Sendable {
    public var time: Double
    public var energy: Double
    public var onset: Double
    public var clipping: Double
    public init(time: Double, energy: Double, onset: Double = 0, clipping: Double = 0) {
        self.time = time; self.energy = energy; self.onset = onset; self.clipping = clipping
    }
}
public struct VisualWindow: Codable, Equatable, Sendable {
    public var time: Double
    public var sharpness: Double
    public var brightness: Double
    public var shake: Double
    public init(time: Double, sharpness: Double = 0.5, brightness: Double = 0.5, shake: Double = 0.2) {
        self.time = time; self.sharpness = sharpness; self.brightness = brightness; self.shake = shake
    }
}
public struct MediaClip: Identifiable, Codable, Equatable, Sendable {
    public var id: UUID
    public var name: String
    public var fileName: String
    public var duration: Double
    public var width: Double
    public var height: Double
    public var hasAudio: Bool
    public var mediaStart: Double
    public var audio: [AudioWindow]
    public var visual: [VisualWindow]
    public var warnings: [String]
    public init(id: UUID = UUID(), name: String, fileName: String, duration: Double,
                width: Double = 1080, height: Double = 1920, hasAudio: Bool = true,
                audio: [AudioWindow] = [], visual: [VisualWindow] = [], warnings: [String] = [], mediaStart: Double = 0) {
        self.id = id; self.name = name; self.fileName = fileName; self.duration = duration
        self.width = width; self.height = height; self.hasAudio = hasAudio
        self.audio = audio; self.visual = visual; self.warnings = warnings; self.mediaStart = mediaStart
    }
}
public struct Moment: Identifiable, Codable, Equatable, Sendable {
    public var id: UUID
    public var clipID: UUID
    public var start: Double
    public var duration: Double
    public var role: StoryRole
    public var score: Double
    public var reason: String
    public var approved: Bool
    public var locked: Bool
    public var muted: Bool
    public var focusX: Double
    public var focusY: Double
    public init(id: UUID = UUID(), clipID: UUID, start: Double, duration: Double,
                role: StoryRole = .build, score: Double = 0, reason: String = "Selected moment",
                approved: Bool = true, locked: Bool = false, muted: Bool = false,
                focusX: Double = 0.5, focusY: Double = 0.5) {
        self.id = id; self.clipID = clipID; self.start = start; self.duration = duration
        self.role = role; self.score = score; self.reason = reason; self.approved = approved
        self.locked = locked; self.muted = muted; self.focusX = focusX; self.focusY = focusY
    }
    public var end: Double { start + duration }
}
public struct TimelineShot: Codable, Equatable, Sendable {
    public var moment: Moment
    public var at: Double
    public var incoming: TransitionKind
    public var overlap: Double
    public var end: Double { at + moment.duration }
}
public struct EditPlan: Codable, Equatable, Sendable {
    public var version: Int = 1
    public var settings: EditSettings
    public var moments: [Moment]
    public var warnings: [String]
    public var director: String
    public init(settings: EditSettings, moments: [Moment], warnings: [String] = [], director: String = "On-device rules + signal analysis") {
        self.settings = settings; self.moments = moments; self.warnings = warnings; self.director = director
    }
}
public enum CompassError: Error, LocalizedError, Equatable {
    case invalid(String)
    public var errorDescription: String? { if case .invalid(let text) = self { return text }; return nil }
}
public func clamp(_ x: Double, _ low: Double, _ high: Double) -> Double { min(high, max(low, x)) }
public func frameRound(_ x: Double) -> Double { (x * 600).rounded() / 600 }
