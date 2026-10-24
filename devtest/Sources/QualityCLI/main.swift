import Foundation
import CompassCore
struct Request: Codable {
    var clips: [MediaClip]
    var settings: EditSettings
    var action: String
    var plan: EditPlan?
    var previous: EditPlan?
    var seed: UInt64?
    var explicitSettings: [String]?
    // Harness-only mode: the native core and its persisted model stay unchanged.
    var preserveSections: Bool?
}
struct Response: Codable { var plan: EditPlan; var timeline: [TimelineShot]; var preserveSections: Bool }

func intactPlan(clips: [MediaClip], settings: EditSettings, previous: EditPlan?) throws -> EditPlan {
    guard !clips.isEmpty, clips.count <= 12 else { throw CompassError.invalid("Choose up to 12 source videos first.") }
    let moments: [Moment]
    if let previous {
        // These are the owner's selected ranges, not permission to replace them
        // with whole uploads. Keep IDs, reviewed order, rejections and locks.
        moments = previous.moments
    } else {
        let roles = Timeline.roles(count: clips.count, mode: settings.mode)
        moments = zip(clips, roles).map { clip, role in
            Moment(clipID: clip.id, start: 0, duration: clip.duration, role: role,
                   reason: "Complete source preserved in upload order", locked: true)
        }
    }
    let actual = moments.filter(\.approved).reduce(0) { $0 + $1.duration }
    guard actual.isFinite, actual <= Timeline.maximumReelSeconds else {
        let choice = previous == nil
            ? "Choose Highlight montage, or clear this test and upload fewer/shorter clips."
            : "Reject a section or unlock and trim one; alternatively unlock the ranges and choose Highlight montage."
        throw CompassError.invalid("Your intact sections total \(String(format: "%.3f", actual))s, over the 300s limit. \(choice) Nothing was shortened or reordered.")
    }
    var warnings = [previous == nil
        ? "Complete uploaded clips kept intact in upload order and locked."
        : "Chosen ranges, reviewed order, rejections and locks kept unchanged; newly uploaded clips are not added automatically."]
    warnings.append("Intact mode does not identify choruses, bridges or lyrics. Select those ranges yourself; direction changes do not recut them.")
    warnings.append("With original section audio, joins use 5ms de-click gains; gentle cleanup applies only when selected. Picture boundaries round to 30fps within one frame; audio samples do not follow that rounding.")
    warnings.append(settings.transitions == .cuts ? "Sections join with cuts, without overlapping source audio."
        : "Soft fades through black stay inside section edges. No overlap, lyric mixing or source-time removal.")
    if abs(actual - settings.targetSeconds) > 0.08 {
        warnings.append("Requested \(Int(settings.targetSeconds))s; intact sections total \(String(format: "%.1f", actual))s. Nothing was trimmed, looped, stretched or reordered to fit the target.")
    }
    return EditPlan(settings: settings, moments: moments, warnings: warnings,
                    director: "Owner-selected intact sections; no automatic musical listening")
}
do {
    guard CommandLine.arguments.count == 3 else { throw CompassError.invalid("Expected a request and output file.") }
    let r = try JSONDecoder().decode(Request.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    var plan: EditPlan
    if r.action == "plan" {
        let direction = PromptDirector.interpret(r.settings.prompt, base: r.settings)
        var resolved = direction.settings
        // A compact wizard can combine a vibe with deliberate visible
        // controls. Never let old/generated prose silently replace a newer
        // parameter the owner touched.
        for key in r.explicitSettings ?? [] {
            switch key {
            case "mode": resolved.mode = r.settings.mode
            case "style": resolved.style = r.settings.style
            case "targetSeconds": resolved.targetSeconds = r.settings.targetSeconds
            case "transitions": resolved.transitions = r.settings.transitions
            case "gentleCleanup": resolved.gentleCleanup = r.settings.gentleCleanup
            default: continue
            }
        }
        guard !resolved.stabilize else { throw CompassError.invalid("Stabilization is not part of this Linux quality test. Remove that direction.") }
        if r.preserveSections == true {
            plan = try intactPlan(clips: r.clips, settings: resolved, previous: r.previous)
        } else {
            plan = try Planner.propose(clips: r.clips, settings: resolved, previous: r.previous, seed: r.seed ?? 0)
        }
        plan.warnings += direction.understood + direction.warnings
        if r.preserveSections != true { plan.director = "Existing CompassCore rules and signal planner; separate Linux renderer" }
    } else if r.action == "validate", let proposed = r.plan {
        plan = proposed
    } else { throw CompassError.invalid("Unsupported quality-test operation.") }
    // The core has no intact-mode field. Validate and build the actual sequential
    // timing with its existing cut model, retaining the user's fade preference
    // only in the harness response. The renderer applies in-place soft fades.
    var timingPlan = plan
    if r.preserveSections == true {
        timingPlan.settings.transitions = .cuts
        let actual = timingPlan.moments.filter(\.approved).reduce(0) { $0 + $1.duration }
        guard actual.isFinite, actual <= Timeline.maximumReelSeconds else {
            throw CompassError.invalid("Your intact sections total \(String(format: "%.3f", actual))s, over the 300s limit. Reject a section or unlock and trim one; nothing was shortened automatically.")
        }
    }
    try Timeline.validate(timingPlan, clips: r.clips)
    let result = Response(plan: plan, timeline: try Timeline.build(timingPlan), preserveSections: r.preserveSections == true)
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    try encoder.encode(result).write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8)); exit(1)
}
