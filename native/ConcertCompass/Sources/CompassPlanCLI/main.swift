import Foundation
import CompassCore

struct Request: Codable { var clips: [MediaClip]; var settings: EditSettings }
struct Response: Codable { var plan: EditPlan; var timeline: [TimelineShot] }

do {
    guard CommandLine.arguments.count == 3 else {
        throw CompassError.invalid("Usage: compass-plan request.json response.json")
    }
    let input = URL(fileURLWithPath: CommandLine.arguments[1])
    let output = URL(fileURLWithPath: CommandLine.arguments[2])
    let request = try JSONDecoder().decode(Request.self, from: Data(contentsOf: input))
    let plan = try Planner.propose(clips: request.clips, settings: request.settings)
    let result = Response(plan: plan, timeline: try Timeline.build(plan))
    let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    try encoder.encode(result).write(to: output, options: .atomic)
    print("Planned \(result.timeline.count) moments, \(String(format: "%.3f", Timeline.duration(plan))) seconds. No media was rendered by this CLI.")
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(1)
}
