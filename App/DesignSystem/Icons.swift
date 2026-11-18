import SwiftUI

/// Airlock's own icon set (24-pt grid, 1.8-pt round strokes) — the same drawings as
/// `web/src/ui/icons.tsx`, so every platform looks the same. No SF Symbols, no emoji.
/// Icons are decorative (`accessibilityHidden`); the element that carries meaning has the label.
enum Glyph: String, CaseIterable, Sendable {
    case ask, ledger, vault, settings, person, org, place, contact, id, date, health, secret, sparkle, device, cloud, check, shield
    case eye, trash, plus, arrow, link, alert, question, chevron, close, copy
    case detect, target, gate, restore

    fileprivate enum Element {
        case path(String)
        case rect(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, r: CGFloat)
        case circle(cx: CGFloat, cy: CGFloat, r: CGFloat)
    }

    fileprivate var elements: [Element] {
        switch self {
        case .ask: [.path("M4 18.5V6.5a2.5 2.5 0 0 1 2.5-2.5h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-5 2.5Z"), .path("M9 9.5h6M9 12.5h3.5")]
        case .ledger: [.path("M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3Z"), .path("M9 8h6M9 11.5h6M9 15h3")]
        case .vault:
            [
                .path("M12 3 5 6v5.5c0 4.2 2.9 7.8 7 9.5 4.1-1.7 7-5.3 7-9.5V6Z"), .rect(x: 9, y: 10.5, w: 6, h: 5, r: 1.2),
                .path("M10.3 10.5V9a1.7 1.7 0 0 1 3.4 0v1.5"),
            ]
        case .settings: [.path("M4 7h9M17 7h3M4 17h3M11 17h9"), .circle(cx: 15, cy: 7, r: 2), .circle(cx: 9, cy: 17, r: 2)]
        case .person: [.circle(cx: 12, cy: 8.5, r: 3.5), .path("M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5")]
        case .org: [.path("M4 20.5h16M6 20.5V5.5l7-2v17M13 8.5l5 1.5v10.5"), .path("M9 8h1M9 11.5h1M9 15h1M16 13h.5M16 16.5h.5")]
        case .place: [.path("M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Z"), .circle(cx: 12, cy: 10, r: 2.3)]
        case .contact: [.rect(x: 3.5, y: 5.5, w: 17, h: 13, r: 2.5), .path("m4.5 7 7.5 5.5L19.5 7")]
        case .id: [.rect(x: 3.5, y: 5.5, w: 17, h: 13, r: 2.5), .path("M9.5 9.5 8.5 15M14 9.5 13 15M7.5 11h8M7 13.5h8")]
        case .date: [.rect(x: 4, y: 5.5, w: 16, h: 14.5, r: 2.5), .path("M4 10h16M8.5 3.5v3.5M15.5 3.5v3.5")]
        case .health: [.path("M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10Z"), .path("M8 12.5h2l1.2-2 1.6 4 1.2-2h2")]
        case .secret: [.circle(cx: 8, cy: 14, r: 3.5), .path("m10.5 11.5 8-8M15.5 6.5l2 2M13.5 8.5l1.5 1.5")]
        case .sparkle: [.path("M12 3.5c.6 4.2 2.3 5.9 6.5 6.5-4.2.6-5.9 2.3-6.5 6.5-.6-4.2-2.3-5.9-6.5-6.5 4.2-.6 5.9-2.3 6.5-6.5Z"), .path("M18.5 16v4M16.5 18h4")]
        case .device: [.rect(x: 4, y: 4.5, w: 16, h: 11, r: 2), .path("M2.5 19.5h19M9.5 15.5l-.5 4M14.5 15.5l.5 4")]
        case .cloud: [.path("M7 18.5a4.5 4.5 0 0 1-.4-9 6 6 0 0 1 11.3 1.6A3.8 3.8 0 0 1 17.5 18.5Z")]
        case .check: [.path("m5 12.5 4.5 4.5L19 7.5")]
        case .shield: [.path("M12 3 5 6v5.5c0 4.2 2.9 7.8 7 9.5 4.1-1.7 7-5.3 7-9.5V6Z"), .path("m9 12 2 2 4-4")]
        case .eye: [.path("M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"), .circle(cx: 12, cy: 12, r: 2.8)]
        case .trash: [.path("M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5")]
        case .plus: [.path("M12 5v14M5 12h14")]
        case .arrow: [.path("M5 12h14M13 6l6 6-6 6")]
        case .link: [.path("M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"), .path("M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1")]
        case .alert: [.path("M12 4 2.8 19.5h18.4Z"), .path("M12 10v4.5M12 17v.2")]
        case .question: [.circle(cx: 12, cy: 12, r: 8.5), .path("M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 16.8v.2")]
        // Drawn for the native app in the same style (not in the web set).
        case .chevron: [.path("m9.5 6 6 6-6 6")]
        case .close: [.path("M6.5 6.5l11 11M17.5 6.5l-11 11")]
        case .copy: [.rect(x: 8.5, y: 8.5, w: 11, h: 11, r: 2.2), .path("M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8")]
        // "How Airlock works" steps (Detect, Red-team, Egress gate, Restore).
        case .detect: [.circle(cx: 10.5, cy: 10.5, r: 6), .path("m15 15 5 5"), .path("M8 10.5h5")]
        case .target: [.circle(cx: 12, cy: 12, r: 7.5), .circle(cx: 12, cy: 12, r: 3), .path("M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3")]
        case .gate: [.path("M5 20.5V11a7 7 0 0 1 14 0v9.5"), .path("M3 20.5h18"), .path("M12 4v16.5"), .path("M9.5 13.5h.01M14.5 13.5h.01")]
        case .restore: [.path("M4.5 12a7.5 7.5 0 1 0 2.2-5.3"), .path("M4.5 4.5v3.8h3.8"), .path("m9 12.5 2 2 4-4")]
        }
    }

    /// The glyph in its 24×24 design grid (parsed once).
    var unitPath: Path { Self.cache[self] ?? Path() }

    private static let cache: [Glyph: Path] = Dictionary(uniqueKeysWithValues: allCases.map { ($0, $0.build()) })

    private func build() -> Path {
        var p = Path()
        for e in elements {
            switch e {
            case .path(let d): p.addPath(SVGPath.parse(d))
            case .rect(let x, let y, let w, let h, let r):
                p.addRoundedRect(in: CGRect(x: x, y: y, width: w, height: h), cornerSize: CGSize(width: r, height: r))
            case .circle(let cx, let cy, let r): p.addEllipse(in: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))
            }
        }
        return p
    }

    /// The glyph scaled into `rect`.
    func path(in rect: CGRect) -> Path {
        unitPath.applying(CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: rect.width / 24, y: rect.height / 24))
    }

    /// Stroke for a glyph drawn at `size` points (1.8 pt on the 24-pt grid).
    static func stroke(for size: CGFloat) -> StrokeStyle {
        StrokeStyle(lineWidth: 1.8 * size / 24, lineCap: .round, lineJoin: .round)
    }
}

/// The glyph as a `Shape` (fill-less; stroke it).
struct GlyphShape: Shape {
    let glyph: Glyph
    func path(in rect: CGRect) -> Path { glyph.path(in: rect) }
}

/// An Airlock icon. Decorative by default.
struct Icon: View {
    let glyph: Glyph
    var size: CGFloat = 18

    init(_ glyph: Glyph, size: CGFloat = 18) {
        self.glyph = glyph
        self.size = size
    }

    var body: some View {
        GlyphShape(glyph: glyph)
            .stroke(style: Glyph.stroke(for: size))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// An icon that scales with Dynamic Type (relative to `textStyle`).
struct ScaledIcon: View {
    let glyph: Glyph
    @ScaledMetric private var size: CGFloat

    init(_ glyph: Glyph, size: CGFloat = 16, relativeTo style: Font.TextStyle = .body) {
        self.glyph = glyph
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
    }

    var body: some View { Icon(glyph, size: size) }
}

#Preview("Icon set") {
    LazyVGrid(columns: Array(repeating: GridItem(.fixed(64)), count: 6), spacing: 16) {
        ForEach(Glyph.allCases, id: \.self) { g in
            VStack(spacing: 6) {
                Icon(g, size: 28)
                Text(verbatim: g.rawValue).font(.caption2).foregroundStyle(Palette.text2)
            }
        }
    }
    .padding()
    .foregroundStyle(Palette.text)
    .background(Palette.bg)
}
