import Foundation

public enum SignalTools {
    public static func normalizedAudio(rms: [Double], clipping: [Double], step: Double = 0.1) -> [AudioWindow] {
        guard !rms.isEmpty else { return [] }
        let safe = rms.map { $0.isFinite ? max(0, $0) : 0 }
        let sorted = safe.sorted()
        let high = max(0.001, sorted[min(sorted.count - 1, Int((Double(sorted.count - 1) * 0.95).rounded(.up)))])
        var last = 0.0
        return safe.enumerated().map { index, value in
            let energy = clamp(value / high, 0, 1)
            let onset = index == 0 ? 0 : clamp((energy - last) * 3, 0, 1)
            last = energy
            return AudioWindow(time: Double(index) * step, energy: energy, onset: onset,
                               clipping: index < clipping.count ? clamp(clipping[index], 0, 1) : 0)
        }
    }

    public static func visualStatistics(gray: [UInt8], width: Int, height: Int) -> (brightness: Double, sharpness: Double) {
        guard width >= 3, height >= 3, gray.count == width * height else { return (0, 0) }
        let mean = gray.reduce(0.0) { $0 + Double($1) } / Double(gray.count) / 255
        var energy = 0.0, samples = 0.0
        for y in stride(from: 1, to: height - 1, by: 2) {
            for x in stride(from: 1, to: width - 1, by: 2) {
                let p = y * width + x
                let laplacian = Double(Int(gray[p - 1]) + Int(gray[p + 1]) + Int(gray[p - width]) + Int(gray[p + width]) - 4 * Int(gray[p]))
                energy += laplacian * laplacian; samples += 1
            }
        }
        return (mean, clamp(log1p(energy / max(1, samples)) / 9, 0, 1))
    }
}

public struct MotionPoint: Codable, Equatable, Sendable {
    public var time: Double
    public var x: Double
    public var y: Double
    public init(time: Double, x: Double, y: Double) { self.time = time; self.x = x; self.y = y }
}
public enum Stabilization {
    /// Small-translation block matching. No rotation, rolling-shutter repair, or invented pixels.
    /// x/y describe the current frame's displacement relative to the previous frame.
    public static func translation(previous: [UInt8], current: [UInt8], width: Int, height: Int, radius: Int = 4) -> (x: Double, y: Double, reliable: Bool) {
        guard width > 2 * radius + 4, height > 2 * radius + 4,
              previous.count == width * height, current.count == previous.count else { return (0, 0, false) }
        let statistics = SignalTools.visualStatistics(gray: previous, width: width, height: height)
        guard statistics.brightness > 0.025, statistics.sharpness > 0.2 else { return (0, 0, false) }
        var best = Double.infinity, second = Double.infinity
        var bestX = 0, bestY = 0
        for dy in -radius...radius {
            for dx in -radius...radius {
                var error = 0.0, count = 0.0
                for y in stride(from: radius + 1, to: height - radius - 1, by: 4) {
                    for x in stride(from: radius + 1, to: width - radius - 1, by: 4) {
                        error += abs(Double(previous[y * width + x]) - Double(current[(y + dy) * width + x + dx]))
                        count += 1
                    }
                }
                error /= max(1, count)
                if error < best { second = best; best = error; bestX = dx; bestY = dy }
                else if error < second { second = error }
            }
        }
        let reliable = best < 36 && second - best > 0.8 && abs(bestX) < radius && abs(bestY) < radius
        return (Double(bestX), Double(bestY), reliable)
    }
    /// A centered smoother removes short jitter while following a sustained pan.
    /// Endpoints are held unchanged to avoid a jump when a cut starts or finishes.
    public static func corrections(path: [MotionPoint], radius: Int = 3, maxFraction: Double = 0.025) -> [MotionPoint] {
        guard !path.isEmpty else { return [] }
        return path.indices.map { index in
            let lo = max(0, index - max(0, radius)), hi = min(path.count - 1, index + max(0, radius))
            let window = path[lo...hi]
            let sx = window.reduce(0) { $0 + $1.x } / Double(window.count)
            let sy = window.reduce(0) { $0 + $1.y } / Double(window.count)
            let edge = min(1.0, Double(min(index, path.count - 1 - index)) / Double(max(1, radius)))
            return MotionPoint(time: path[index].time,
                               x: clamp(sx - path[index].x, -maxFraction, maxFraction) * edge,
                               y: clamp(sy - path[index].y, -maxFraction, maxFraction) * edge)
        }
    }
}

/// Conservative, streaming rumble reduction. It does NOT separate an audience from a singer.
/// The original is blended back in; no gain above unity is introduced by this filter.
public struct GentleAudioFilter {
    private let alpha: Double
    private var previousInput = 0.0
    private var previousOutput = 0.0
    public init(sampleRate: Double) {
        let rate = max(8000, sampleRate)
        let rc = 1 / (2 * Double.pi * 70)
        self.alpha = rc / (rc + 1 / rate)
    }
    public mutating func process(_ input: Float) -> Float {
        let x = input.isFinite ? Double(input) : 0
        let highpassed = alpha * (previousOutput + x - previousInput)
        previousInput = x; previousOutput = highpassed
        return Float(clamp(x * 0.55 + highpassed * 0.45, -1, 1))
    }
}
