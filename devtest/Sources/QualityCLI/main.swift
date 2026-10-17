import Foundation
import CompassCore
struct Request: Codable {
    var clips: [MediaClip]
    var settings: EditSettings
    var action: String
    var plan: EditPlan?
    var previous: EditPlan?
}
struct Response: Codable { var plan: EditPlan; var timeline: [TimelineShot] }
do {
    guard CommandLine.arguments.count == 3 else { throw CompassError.invalid("Expected a request and output file.") }
    let r = try JSONDecoder().decode(Request.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    var plan: EditPlan
    if r.action == "plan" {
        let direction = PromptDirector.interpret(r.settings.prompt, base: r.settings)
        guard !direction.settings.stabilize else { throw CompassError.invalid("Stabilization is not part of this Linux quality test. Remove that direction.") }
        plan = try Planner.propose(clips: r.clips, settings: direction.settings, previous: r.previous)
        plan.warnings += direction.understood + direction.warnings
        plan.director = "Existing CompassCore rules and signal planner; separate Linux renderer"
    } else if r.action == "validate", let proposed = r.plan {
        plan = proposed
    } else { throw CompassError.invalid("Unsupported quality-test operation.") }
    try Timeline.validate(plan, clips: r.clips)
    let result = Response(plan: plan, timeline: try Timeline.build(plan))
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    try encoder.encode(result).write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8)); exit(1)
}
