import Foundation

public struct PromptInterpretation: Sendable {
    public var settings: EditSettings
    public var understood: [String]
    public var warnings: [String]
}

public enum PromptDirector {
    /// Bounded, offline fallback. Unsupported intent stays visible; no arbitrary code is executed.
    public static func interpret(_ prompt: String, base: EditSettings) -> PromptInterpretation {
        var settings = base
        settings.prompt = String(prompt.prefix(2000))
        let text = settings.prompt.lowercased()
        func has(_ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
        var understood: [String] = []
        var warnings: [String] = []
        let styles: [(EditStyle, String)] = [
            (.cinematic, #"\b(cinematic|film-like|movie-like)\b"#),
            (.hype, #"\b(hype|energetic|fast cuts|high energy)\b"#),
            (.memory, #"\b(memory|nostalgic|emotional|gentle|slow cuts)\b"#),
            (.musicVideo, #"\b(music video|on the beat|on-beat|beat sync)\b"#)
        ]
        // Remove simple negated style clauses before matching a desired style.
        let affirmative = text.replacingOccurrences(
            of: #"\b(no|not|avoid|without|don't|do not)\s+(cinematic|hype|energetic|fast cuts|high energy|nostalgic|gentle|slow cuts|music video)\b"#,
            with: "", options: .regularExpression)
        for (style, pattern) in styles where affirmative.range(of: pattern, options: .regularExpression) != nil {
            settings.style = style
            understood.append("Style: \(style.label)")
        }
        if has(#"\b(trailer|teaser)\b"#) && !has(#"\b(no|not|avoid)\s+(a\s+)?(trailer|teaser)\b"#) {
            settings.mode = .trailer; understood.append("Trailer pacing")
        }
        if has(#"\b(highlight reel|highlights)\b"#) { settings.mode = .highlight }
        if has(#"\b(dissolve|crossfade|cross-fade|soft transitions)\b"#) && !has(#"\b(no|without|avoid)\s+(dissolves?|crossfades?|cross-fades?|soft transitions)\b"#) {
            settings.transitions = .dissolves; understood.append("Soft dissolves")
        }
        if has(#"\b(no transitions|no dissolves|no crossfades|hard cuts|cuts only|cut only)\b"#) {
            settings.transitions = .cuts; understood.append("Cuts only")
        }
        if has(#"\b(stabilize|stabilise|steady|reduce shake|smooth the shake)\b"#) && !has(#"\b(no|without|don't|do not)\s+(stabilization|stabilisation|stabilize|stabilise)\b"#) {
            settings.stabilize = true; understood.append("Gentle stabilization")
        }
        if has(#"\b(no stabilization|no stabilisation|keep the shake|do not stabilize|don't stabilize)\b"#) {
            settings.stabilize = false; understood.append("Keep original camera motion")
        }
        if has(#"\b(clean( up)? (the )?audio|reduce (the )?crowd|less crowd|reduce noise|cleaner audio)\b"#) {
            settings.gentleCleanup = true; understood.append("Gentle cleanup, not crowd removal")
        }
        if has(#"\b(raw audio|untouched audio|no cleanup|do not clean|don't clean|no audio cleanup)\b"#) {
            settings.gentleCleanup = false; understood.append("Original audio")
        }
        for duration in [15, 30, 45, 60] where has("\\b\(duration)\\s*(s|sec|secs|second|seconds)\\b") {
            settings.targetSeconds = Double(duration); understood.append("\(duration)-second target")
        }
        if has(#"\b(remove|erase|eliminate|isolate|separate|drown out)\b"#) && has(#"\b(crowd|screaming|singing|vocals|voice)\b"#) {
            warnings.append("Nearby singing and overlapping crowd voices cannot be cleanly removed by this build. Gentle cleanup is limited.")
        }
        if has(#"\b(flash|strobe|whip|spin|glitch)\b"#) && !has(#"\b(no|without|avoid)\s+(flashy|flash|strobe|whip|spin|glitch)"#) {
            warnings.append("This build supports cuts and dissolves only. No flashing or novelty transitions were added.")
        }
        if understood.isEmpty { warnings.append("No supported edit directive was recognized. Your visible settings are unchanged.") }
        warnings.append("The offline interpreter handles edit directives, not song recognition or arbitrary story instructions.")
        return PromptInterpretation(settings: settings, understood: understood, warnings: warnings)
    }

    /// Validate structured model output. A model cannot name files, run tools, or exceed limits.
    public static func applyModel(style: String, mode: String, transition: String, seconds: Int,
                                  cleanup: Bool, stabilization: Bool, to base: EditSettings) throws -> EditSettings {
        guard let s = EditStyle(rawValue: style), let m = EditMode(rawValue: mode),
              let t = TransitionPreference(rawValue: transition), [15, 30, 45, 60].contains(seconds) else {
            throw CompassError.invalid("The AI suggested an unsupported edit. Your settings were not changed.")
        }
        var result = base
        result.style = s; result.mode = m; result.transitions = t; result.targetSeconds = Double(seconds)
        result.gentleCleanup = cleanup; result.stabilize = stabilization
        return result
    }
}
