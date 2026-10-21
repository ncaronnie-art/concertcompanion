import Foundation

public enum Planner {
    private struct Range { var start: Double; var end: Double; var duration: Double { end - start } }
    private struct Pick { var clip: MediaClip; var start: Double; var duration: Double; var score: Double; var reason: String }

    public static func propose(clips: [MediaClip], settings input: EditSettings, previous: EditPlan? = nil, seed: UInt64 = 0) throws -> EditPlan {
        try Timeline.validateSettings(input)
        guard !clips.isEmpty else { throw CompassError.invalid("Choose at least one concert video first.") }
        guard clips.count <= 12, Set(clips.map(\.id)).count == clips.count,
              clips.allSatisfy({ $0.duration.isFinite && $0.duration >= 0.1 && $0.duration <= 600 }) else {
            throw CompassError.invalid("Use up to 12 videos, each between 0.1 seconds and 10 minutes.")
        }
        var settings = input
        var warnings: [String] = []
        if settings.style == .surprise {
            let frames = clips.flatMap(\.audio)
            let energy = frames.isEmpty ? 0.5 : frames.reduce(0) { $0 + $1.energy } / Double(frames.count)
            let onsets = frames.isEmpty ? 0 : frames.filter { $0.onset > 0.55 }.count
            let rhythmic = frames.isEmpty ? false : Double(onsets) / Double(frames.count) > 0.08
            settings.style = energy > 0.6 && rhythmic ? .musicVideo : energy > 0.68 ? .hype : energy < 0.35 ? .cinematic : .memory
            warnings.append("Surprise Me selected \(settings.style.label) from measured energy and onset activity.")
        }
        let oldApproved = previous?.moments.filter(\.approved) ?? []
        let rejected = previous?.moments.filter { !$0.approved } ?? []
        let knownIDs = Set(clips.map(\.id))
        let locks = Dictionary(uniqueKeysWithValues: oldApproved.enumerated().filter { $0.element.locked && knownIDs.contains($0.element.clipID) }.map { ($0.offset, $0.element) })
        var free: [UUID: [Range]] = Dictionary(uniqueKeysWithValues: clips.map { ($0.id, [Range(start: 0, end: $0.duration)]) })
        for moment in Array(locks.values) + rejected { subtract(moment, from: &free) }
        let available = free.values.flatMap { $0 }.reduce(0) { $0 + $1.duration } + locks.values.reduce(0) { $0 + $1.duration }
        guard available >= 0.1 else { throw CompassError.invalid("All footage is rejected. Restore a moment or add another clip.") }
        let desiredCount = Int((min(settings.targetSeconds, available) / settings.style.averageShot).rounded())
        let count = min(Timeline.maximumMoments, max(1, max(desiredCount, (locks.keys.max() ?? -1) + 1)))
        let roles = Timeline.roles(count: count, mode: settings.mode)
        let lockedDuration = locks.values.reduce(0) { $0 + $1.duration }
        let estimatedOverlap = settings.transitions == .dissolves ? 0.32 : settings.transitions == .automatic && (settings.style == .cinematic || settings.style == .memory) ? 0.07 : 0
        let budget = max(0, min(available, settings.targetSeconds + Double(max(0, count - 1)) * estimatedOverlap) - lockedDuration)
        let unlockedIndices = (0..<count).filter { locks[$0] == nil }
        func weight(_ index: Int) -> Double {
            switch roles[index] {
            case .hook: return 0.72
            case .establish: return settings.mode == .trailer ? 1.35 : 1.05
            case .build:
                return settings.mode == .trailer ? max(0.55, 1.3 - Double(index) / Double(max(1, count)) * 1.2) : 0.92
            case .peak: return 1.35
            case .payoff: return 1.05
            case .end: return 1.0
            }
        }
        let totalWeight = unlockedIndices.reduce(0) { $0 + weight($1) }
        var chosen: [Moment] = []
        var usage: [UUID: Int] = [:]
        var rng = SeededRandom(seed: seed)
        for index in 0..<count {
            try Task.checkCancellation()
            if let locked = locks[index] {
                chosen.append(locked); usage[locked.clipID, default: 0] += 1; continue
            }
            if budget < 0.1 || totalWeight == 0 { continue }
            let wanted = max(0.1, min(5.0, budget * weight(index) / totalWeight))
            var best: Pick? = nil
            for clip in clips {
                for span in free[clip.id] ?? [] where span.duration >= 0.1 {
                    let length = frameRound(min(span.duration, wanted))
                    let maxStart = span.end - length
                    var start = span.start
                    repeat {
                        var trimStart = start
                        if settings.style == .hype || settings.style == .musicVideo {
                            trimStart = snapToOnset(start, clip: clip, lower: span.start, upper: maxStart)
                        }
                        let features = score(clip: clip, start: trimStart, length: length, role: roles[index])
                        let sameClip = chosen.last?.clipID == clip.id ? 0.16 : 0
                        let reuse = Double(usage[clip.id, default: 0]) * 0.055
                        let shortfall = max(0, wanted - length) / max(0.1, wanted) * 0.3
                        let previousMatch = seed > 0 && oldApproved.contains { !$0.locked && $0.clipID == clip.id && abs($0.start - trimStart) < 0.5 } ? 0.16 : 0
                        let variation = seed == 0 ? 0 : rng.nextUnit() * 0.10
                        let value = features.0 - sameClip - reuse - shortfall - previousMatch + variation
                        if best == nil || value > best!.score {
                            best = Pick(clip: clip, start: frameRound(trimStart), duration: length, score: value, reason: features.1)
                        }
                        if start >= maxStart - 0.001 { break }
                        start = min(maxStart, start + 0.5)
                    } while true
                }
            }
            guard let best else { continue }
            let moment = Moment(clipID: best.clip.id, start: best.start, duration: best.duration,
                                role: roles[index], score: best.score, reason: best.reason)
            chosen.append(moment); usage[best.clip.id, default: 0] += 1
            subtract(moment, from: &free)
        }
        guard !chosen.isEmpty else { throw CompassError.invalid("No usable ranges remain. Restore a rejected moment or add a video.") }
        var plan = EditPlan(settings: settings, moments: chosen, warnings: warnings)
        fitTarget(&plan, clips: clips, forbidden: rejected)
        let actual = Timeline.duration(plan)
        if abs(actual - settings.targetSeconds) > 0.08 {
            plan.warnings.append("Requested \(Int(settings.targetSeconds))s; this edit is \(String(format: "%.1f", actual))s. No footage was looped or stretched to fill time.")
        }
        if locks.count > 0 { plan.warnings.append("Locked source ranges were preserved. Locked moments may prevent an exact target length.") }
        if clips.allSatisfy({ $0.audio.isEmpty && $0.visual.isEmpty }) {
            plan.warnings.append("No signal measurements are available. These are rough trims, not analyzed highlights.")
        }
        plan.warnings.append("Signals rank energy, exposure, sharpness and motion. They do not identify artists, lyrics, songs or emotional meaning.")
        plan.moments.append(contentsOf: rejected.filter { knownIDs.contains($0.clipID) })
        try Timeline.validate(plan, clips: clips)
        return plan
    }

    private static func subtract(_ moment: Moment, from free: inout [UUID: [Range]]) {
        free[moment.clipID] = (free[moment.clipID] ?? []).flatMap { range -> [Range] in
            if moment.end <= range.start || moment.start >= range.end { return [range] }
            var pieces: [Range] = []
            if moment.start - range.start >= 0.1 { pieces.append(Range(start: range.start, end: moment.start)) }
            if range.end - moment.end >= 0.1 { pieces.append(Range(start: moment.end, end: range.end)) }
            return pieces
        }
    }
    private static func nearest<T>(_ array: [T], time: Double, key: (T) -> Double) -> T? {
        guard !array.isEmpty else { return nil }
        var lower = 0; var upper = array.count - 1
        while lower < upper {
            let mid = (lower + upper) / 2
            if key(array[mid]) < time { lower = mid + 1 } else { upper = mid }
        }
        if lower > 0 && abs(key(array[lower - 1]) - time) < abs(key(array[lower]) - time) { return array[lower - 1] }
        return array[lower]
    }
    private static func score(clip: MediaClip, start: Double, length: Double, role: StoryRole) -> (Double, String) {
        var energy = 0.0, clipping = 0.0, sharpness = 0.0, shake = 0.0, darkness = 0.0
        for fraction in [0.1, 0.3, 0.5, 0.7, 0.9] {
            let time = start + length * fraction
            let a = nearest(clip.audio, time: time, key: { $0.time })
            let v = nearest(clip.visual, time: time, key: { $0.time })
            energy += a?.energy ?? 0.45; clipping += a?.clipping ?? 0
            sharpness += v?.sharpness ?? 0.5; shake += v?.shake ?? 0.2
            if let v { darkness += v.brightness < 0.06 ? 1 : v.brightness > 0.96 ? 0.65 : 0 }
        }
        energy /= 5; clipping /= 5; sharpness /= 5; shake /= 5; darkness /= 5
        let quality = sharpness * 0.26 + (1 - shake) * 0.22 - clipping * 0.8 - darkness * 0.6
        let energyWeight: Double
        switch role {
        case .hook, .peak: energyWeight = energy * 0.38
        case .build: energyWeight = energy * 0.26
        case .establish: energyWeight = (1 - abs(energy - 0.45)) * 0.20
        case .payoff, .end: energyWeight = (1 - abs(energy - 0.5)) * 0.18
        }
        let reason = role == .hook || role == .peak ? "Higher energy with a usable picture" : role == .establish ? "A steadier setup moment" : role == .end || role == .payoff ? "A calmer closing breath" : "Energy and visual quality balance"
        return (quality + energyWeight, reason)
    }
    private static func snapToOnset(_ time: Double, clip: MediaClip, lower: Double, upper: Double) -> Double {
        guard upper >= lower else { return lower }
        let nearby = clip.audio.filter { abs($0.time - time) <= 0.12 && $0.time >= lower && $0.time <= upper && $0.onset >= 0.55 }
        return nearby.max(by: { $0.onset < $1.onset })?.time ?? time
    }
    private static func fitTarget(_ plan: inout EditPlan, clips: [MediaClip], forbidden: [Moment]) {
        let sourceDurations = Dictionary(uniqueKeysWithValues: clips.map { ($0.id, $0.duration) })
        for _ in 0..<8 {
            var difference = plan.settings.targetSeconds - Timeline.duration(plan)
            if abs(difference) < 0.04 { break }
            var changed = false
            for index in plan.moments.indices.reversed() where !plan.moments[index].locked {
                var m = plan.moments[index]
                if difference < 0 {
                    let remove = min(-difference, max(0, m.duration - 0.15))
                    if remove > 0.001 { m.duration = frameRound(m.duration - remove); changed = true }
                } else {
                    let blockers = (plan.moments.filter { $0.id != m.id } + forbidden).filter { $0.clipID == m.clipID && $0.start >= m.end - 0.001 }
                    let next = blockers.map(\.start).min() ?? sourceDurations[m.clipID] ?? m.end
                    let add = min(difference, max(0, min(next - m.end, 5 - m.duration)))
                    if add > 0.001 { m.duration = frameRound(m.duration + add); changed = true }
                }
                plan.moments[index] = m
                difference = plan.settings.targetSeconds - Timeline.duration(plan)
                if abs(difference) < 0.04 { break }
            }
            if !changed { break }
        }
    }
}

public struct SeededRandom {
    private var state: UInt64
    public init(seed: UInt64) { self.state = seed == 0 ? 0x123456789abcdef : seed }
    public mutating func nextUnit() -> Double {
        state ^= state << 13; state ^= state >> 7; state ^= state << 17
        return Double(state & 0x1fffffffffffff) / Double(0x1fffffffffffff)
    }
}
