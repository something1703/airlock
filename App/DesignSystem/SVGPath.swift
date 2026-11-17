import SwiftUI

/// A small SVG path-data parser (`d="…"`) → SwiftUI `Path`, so Airlock's own icon set (drawn for
/// the web app) renders identically on Apple platforms. Supports M L H V C S Q T A Z in absolute
/// and relative forms, implicit command repetition, compact numbers ("1.5.5", "-2-3") and packed
/// arc flags. Arcs are converted to cubic Béziers.
enum SVGPath {
    static func parse(_ d: String) -> Path {
        var scanner = Scanner(Array(d.unicodeScalars))
        var path = Path()
        var current = CGPoint.zero
        var start = CGPoint.zero
        var lastControl: CGPoint?
        var lastQuad: CGPoint?
        var command: Character = "M"

        while scanner.skipSeparators() {
            if let c = scanner.command() { command = c } else if command == "M" { command = "L" } else if command == "m" { command = "l" }
            let rel = command.isLowercase
            let base = rel ? current : .zero
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: base.x + x, y: base.y + y) }
            var control: CGPoint?
            var quad: CGPoint?
            switch command.uppercased().first ?? "Z" {
            case "M":
                guard let x = scanner.number(), let y = scanner.number() else { return path }
                current = pt(x, y)
                start = current
                path.move(to: current)
            case "L":
                guard let x = scanner.number(), let y = scanner.number() else { return path }
                current = pt(x, y)
                path.addLine(to: current)
            case "H":
                guard let x = scanner.number() else { return path }
                current = CGPoint(x: rel ? current.x + x : x, y: current.y)
                path.addLine(to: current)
            case "V":
                guard let y = scanner.number() else { return path }
                current = CGPoint(x: current.x, y: rel ? current.y + y : y)
                path.addLine(to: current)
            case "C":
                guard let x1 = scanner.number(), let y1 = scanner.number(), let x2 = scanner.number(), let y2 = scanner.number(),
                    let x = scanner.number(), let y = scanner.number()
                else { return path }
                let c2 = pt(x2, y2)
                let end = pt(x, y)
                path.addCurve(to: end, control1: pt(x1, y1), control2: c2)
                control = c2
                current = end
            case "S":
                guard let x2 = scanner.number(), let y2 = scanner.number(), let x = scanner.number(), let y = scanner.number() else {
                    return path
                }
                let c1 = lastControl.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let c2 = pt(x2, y2)
                let end = pt(x, y)
                path.addCurve(to: end, control1: c1, control2: c2)
                control = c2
                current = end
            case "Q":
                guard let x1 = scanner.number(), let y1 = scanner.number(), let x = scanner.number(), let y = scanner.number() else {
                    return path
                }
                let c = pt(x1, y1)
                let end = pt(x, y)
                path.addQuadCurve(to: end, control: c)
                quad = c
                current = end
            case "T":
                guard let x = scanner.number(), let y = scanner.number() else { return path }
                let c = lastQuad.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let end = pt(x, y)
                path.addQuadCurve(to: end, control: c)
                quad = c
                current = end
            case "A":
                guard let rx = scanner.number(), let ry = scanner.number(), let rot = scanner.number(), let large = scanner.flag(),
                    let sweep = scanner.flag(), let x = scanner.number(), let y = scanner.number()
                else { return path }
                let end = pt(x, y)
                addArc(&path, from: current, rx: rx, ry: ry, rotation: rot, large: large, sweep: sweep, to: end)
                current = end
            case "Z":
                path.closeSubpath()
                current = start
            default:
                return path
            }
            lastControl = control
            lastQuad = quad
        }
        return path
    }

    /// Endpoint → centre parameterisation (SVG 1.1 implementation notes F.6.5), then ≤ 90° cubic segments.
    static func addArc(
        _ path: inout Path, from p0: CGPoint, rx rxIn: CGFloat, ry ryIn: CGFloat, rotation: CGFloat, large: Bool, sweep: Bool, to p: CGPoint
    ) {
        if p0 == p { return }
        var rx = abs(rxIn)
        var ry = abs(ryIn)
        guard rx > 0, ry > 0 else {
            path.addLine(to: p)
            return
        }
        let phi = rotation * .pi / 180
        let cosP = cos(phi)
        let sinP = sin(phi)
        let dx = (p0.x - p.x) / 2
        let dy = (p0.y - p.y) / 2
        let x1 = cosP * dx + sinP * dy
        let y1 = -sinP * dx + cosP * dy
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 {
            rx *= sqrt(lambda)
            ry *= sqrt(lambda)
        }
        let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
        var coef = den == 0 ? 0 : sqrt(max(0, num / den))
        if large == sweep { coef = -coef }
        let cx1 = coef * rx * y1 / ry
        let cy1 = -coef * ry * x1 / rx
        let cx = cosP * cx1 - sinP * cy1 + (p0.x + p.x) / 2
        let cy = sinP * cx1 + cosP * cy1 + (p0.y + p.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat { atan2(ux * vy - uy * vx, ux * vx + uy * vy) }
        let theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi } else if sweep && delta < 0 { delta += 2 * .pi }
        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2) - 0.001)))
        let step = delta / CGFloat(segments)
        let t = 4 / 3 * tan(step / 4)
        func map(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: cx + rx * cosP * x - ry * sinP * y, y: cy + rx * sinP * x + ry * cosP * y)
        }
        var theta = theta1
        for i in 0..<segments {
            let c1 = cos(theta)
            let s1 = sin(theta)
            let c2 = cos(theta + step)
            let s2 = sin(theta + step)
            let end = i == segments - 1 ? p : map(c2, s2)
            path.addCurve(to: end, control1: map(c1 - t * s1, s1 + t * c1), control2: map(c2 + t * s2, s2 - t * c2))
            theta += step
        }
    }

    private struct Scanner {
        let s: [Unicode.Scalar]
        var i = 0
        init(_ s: [Unicode.Scalar]) { self.s = s }

        /// Skips whitespace and commas; false at the end.
        mutating func skipSeparators() -> Bool {
            while i < s.count, s[i] == " " || s[i] == "," || s[i] == "\n" || s[i] == "\t" || s[i] == "\r" { i += 1 }
            return i < s.count
        }

        mutating func command() -> Character? {
            guard i < s.count else { return nil }
            let c = Character(s[i])
            guard "MmLlHhVvCcSsQqTtAaZz".contains(c) else { return nil }
            i += 1
            return c
        }

        mutating func flag() -> Bool? {
            _ = skipSeparators()
            guard i < s.count, s[i] == "0" || s[i] == "1" else { return nil }
            defer { i += 1 }
            return s[i] == "1"
        }

        mutating func number() -> CGFloat? {
            _ = skipSeparators()
            var text = ""
            var seenDot = false
            var seenExp = false
            if i < s.count, s[i] == "-" || s[i] == "+" {
                text.unicodeScalars.append(s[i])
                i += 1
            }
            while i < s.count {
                let c = s[i]
                if ("0"..."9").contains(c) {
                    text.unicodeScalars.append(c)
                } else if c == ".", !seenDot, !seenExp {
                    seenDot = true
                    text.unicodeScalars.append(c)
                } else if c == "e" || c == "E", !seenExp, !text.isEmpty {
                    seenExp = true
                    text.unicodeScalars.append(c)
                    if i + 1 < s.count, s[i + 1] == "-" || s[i + 1] == "+" {
                        i += 1
                        text.unicodeScalars.append(s[i])
                    }
                } else {
                    break
                }
                i += 1
            }
            return Double(text).map { CGFloat($0) }
        }
    }
}
