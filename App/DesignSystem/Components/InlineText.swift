import AirlockCore
import SwiftUI

/// How an inline chip looks (docs/06 §3 `PlaceholderChip` states).
enum ChipStyle: Hashable, Sendable {
    /// A protected detail (category colour). `lowConfidence` adds the amber dot.
    case protected(PrivacyCategory, lowConfidence: Bool)
    /// Made less specific on device (dashed outline).
    case generalised
    /// A removed secret (coral).
    case secret
    /// The model invented a placeholder Airlock doesn't know.
    case unknown

    var tint: Color {
        switch self {
        case .protected(let c, _): c.tint
        case .generalised: Palette.text2
        case .secret: Palette.risk
        case .unknown: PrivacyCategory.id.tint
        }
    }

    var glyph: Glyph {
        switch self {
        case .protected(let c, _): c.glyph
        case .generalised: .sparkle
        case .secret: .secret
        case .unknown: .question
        }
    }
}

/// One run of inline text: plain text, a chip, or a restored real detail.
enum InlinePiece: Hashable, Sendable {
    case text(String)
    /// `label` is drawn; `spoken` is what VoiceOver says; `entityID` makes it tappable.
    case chip(label: String, spoken: String, style: ChipStyle, entityID: PlaceholderID?)
    /// A real detail your device filled back in (underlined, "unseals" as it arrives).
    case restored(String)
}

/// Marks chip runs for `InlineRenderer`.
private struct ChipMark: TextAttribute {
    let index: Int
    let style: ChipStyle
}

/// Marks restored runs for `InlineRenderer`.
private struct RestoredMark: TextAttribute {
    let index: Int
}

/// Text with inline chips and restored names, wrapping like normal prose.
///
/// Built as one `Text` (so it wraps, selects and reads naturally) drawn by a `TextRenderer` that
/// paints chip backgrounds and icons and animates chips popping in and restored names unsealing
/// (blur → sharp, seal tint fading into an underline). Reduce Motion shows the final state.
struct InlineText: View {
    let pieces: [InlinePiece]
    /// Tap on a chip that has an `entityID` (sealed preview: protect ↔ send as written).
    var onChip: ((PlaceholderID) -> Void)?
    /// Chips pop in staggered when the view appears.
    var popChips = false
    /// Restored names that appear after the view appears get the unseal animation.
    var unsealNew = false
    var font: Font = .body

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()
    @State private var firstSeen: [Int: Date] = [:]
    @State private var animating = false

    private static let popDuration = 0.12 + 0.46
    private static let unsealDuration = 0.7

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: !animating || reduceMotion)) { timeline in
            composed
                .font(font)
                .foregroundStyle(Palette.text)
                .lineSpacing(5)
                .textRenderer(
                    InlineRenderer(
                        now: timeline.date, start: start, popChips: popChips && !reduceMotion, firstSeen: reduceMotion ? [:] : firstSeen))
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(
            \.openURL,
            OpenURLAction { url in
                if url.scheme == "airlock-chip", let id = url.host().flatMap(PlaceholderID.init(string:)) { onChip?(id) }
                return .handled
            }
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: spoken))
        .accessibilityActions {
            if let onChip {
                ForEach(Array(chipActions.enumerated()), id: \.offset) { _, a in
                    Button(a.label) { onChip(a.id) }
                }
            }
        }
        .onAppear {
            start = Date()
            markAllSeen(at: unsealNew ? Date() : .distantPast)
            kick(max(popChips ? Self.popDuration + Double(chipCount) * 0.08 : 0, unsealNew ? Self.unsealDuration : 0))
        }
        .onChange(of: pieces) { _, _ in
            guard unsealNew else { return markAllSeen(at: .distantPast) }
            let now = Date()
            var added = false
            for (i, p) in pieces.enumerated() where firstSeen[i] == nil {
                if case .restored = p { added = true }
                firstSeen[i] = now
            }
            if added { kick(Self.unsealDuration) }
        }
    }

    private func markAllSeen(at date: Date) {
        for i in pieces.indices where firstSeen[i] == nil { firstSeen[i] = date }
    }

    @State private var stopTask: Task<Void, Never>?

    /// Runs the timeline for `seconds`, then pauses it (no idle redraws).
    private func kick(_ seconds: Double) {
        guard !reduceMotion else { return }
        animating = true
        stopTask?.cancel()
        stopTask = Task {
            try? await Task.sleep(for: .seconds(seconds + 0.1))
            if !Task.isCancelled { animating = false }
        }
    }

    private var chipCount: Int { pieces.reduce(0) { if case .chip = $1 { $0 + 1 } else { $0 } } }

    private var composed: Text {
        var out = Text(verbatim: "")
        var chipIndex = 0
        for (i, p) in pieces.enumerated() {
            switch p {
            case .text(let s):
                out = Text("\(out)\(Text(verbatim: s))")
            case .chip(let label, _, let style, let id):
                // Leading em space holds the icon; non-breaking spaces keep a chip on one line.
                let trailing = if case .protected(_, true) = style { "\u{2009}\u{2002}" } else { "\u{2009}" }
                var a = AttributedString("\u{2003}" + label.replacingOccurrences(of: " ", with: "\u{00A0}") + trailing)
                if let id, onChip != nil { a.link = URL(string: "airlock-chip://\(id.description)") }
                let chip = Text(a).font(.callout.weight(.semibold)).customAttribute(ChipMark(index: chipIndex, style: style))
                out = Text("\(out)\(chip)")
                chipIndex += 1
            case .restored(let s):
                let restored = Text(verbatim: s).customAttribute(RestoredMark(index: i))
                out = Text("\(out)\(restored)")
            }
        }
        return out
    }

    private var spoken: String {
        pieces.map { p in
            switch p {
            case .text(let s): s
            case .chip(_, let spoken, _, _): " \(spoken) "
            case .restored(let s): s
            }
        }.joined()
    }

    private var chipActions: [(label: String, id: PlaceholderID)] {
        var seen = Set<PlaceholderID>()
        return pieces.compactMap { p in
            guard case .chip(let label, _, _, let id?) = p, seen.insert(id).inserted else { return nil }
            return (String(localized: "Change \(label)"), id)
        }
    }
}

/// Draws chips and restored runs (see `InlineText`).
private struct InlineRenderer: TextRenderer {
    let now: Date
    let start: Date
    let popChips: Bool
    let firstSeen: [Int: Date]

    func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
        let t = now.timeIntervalSince(start)
        for line in layout {
            // Group runs of the same chip on this line into one rect.
            var chipRects: [Int: (CGRect, ChipStyle)] = [:]
            for run in line {
                if let mark = run[ChipMark.self] {
                    let r = run.typographicBounds.rect
                    chipRects[mark.index] = (chipRects[mark.index].map { $0.0.union(r) } ?? r, mark.style)
                }
            }
            var drawnChips = Set<Int>()
            for run in line {
                if let mark = run[ChipMark.self] {
                    guard let (rect, style) = chipRects[mark.index] else { continue }
                    let p = popChips ? Motion.popCurve((t - 0.12 - Double(mark.index) * 0.08) / 0.46) : 1
                    var c = ctx
                    if p < 1 {
                        let s = 0.6 + 0.4 * p
                        c.translateBy(x: rect.midX, y: rect.midY)
                        c.scaleBy(x: s, y: s)
                        c.translateBy(x: -rect.midX, y: -rect.midY)
                        c.opacity = max(0, min(1, p))
                        if p < 0.9 { c.addFilter(.blur(radius: 4 * (1 - p))) }
                    }
                    if drawnChips.insert(mark.index).inserted { drawChipBackground(rect, style: style, in: &c) }
                    var glyphs = c
                    glyphs.clipToLayer { $0.draw(run) }
                    glyphs.fill(Path(rect.insetBy(dx: -2, dy: -2)), with: .color(style.tint))
                } else if let mark = run[RestoredMark.self] {
                    let seen = firstSeen[mark.index] ?? .distantPast
                    let p = min(1, max(0, now.timeIntervalSince(seen) / 0.7))
                    let rect = run.typographicBounds.rect
                    let eased = Motion.easeOutCubic(p)
                    if eased < 1 {
                        ctx.fill(
                            Path(roundedRect: rect.insetBy(dx: -1.5, dy: -1), cornerRadius: 4),
                            with: .color(Palette.seal.opacity(0.28 * (1 - eased))))
                    }
                    var c = ctx
                    let sharp = min(1, p / 0.6)
                    if sharp < 1 { c.addFilter(.blur(radius: 3 * (1 - sharp))) }
                    c.draw(run)
                    let y = rect.maxY - run.typographicBounds.descent + 3
                    var underline = Path()
                    underline.move(to: CGPoint(x: rect.minX, y: y))
                    underline.addLine(to: CGPoint(x: rect.maxX, y: y))
                    ctx.stroke(underline, with: .color(Palette.seal.opacity(eased)), lineWidth: 2)
                } else {
                    ctx.draw(run)
                }
            }
        }
    }

    private func drawChipBackground(_ rect: CGRect, style: ChipStyle, in c: inout GraphicsContext) {
        let box = rect.insetBy(dx: -1, dy: -1.5)
        let shape = Path(roundedRect: box, cornerRadius: Metrics.chipRadius - 2)
        switch style {
        case .generalised:
            c.stroke(shape, with: .color(Palette.muted), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
        case .secret:
            c.fill(shape, with: .color(Palette.riskTint))
        default:
            c.fill(shape, with: .color(style.tint.opacity(0.16)))
        }
        let iconSize = min(rect.height * 0.66, 16)
        let iconRect = CGRect(x: rect.minX + 3, y: rect.midY - iconSize / 2, width: iconSize, height: iconSize)
        c.stroke(style.glyph.path(in: iconRect), with: .color(style.tint), style: Glyph.stroke(for: iconSize))
        if case .protected(_, true) = style {
            let d: CGFloat = 6
            c.fill(Path(ellipseIn: CGRect(x: rect.maxX - d - 3, y: rect.midY - d / 2, width: d, height: d)), with: .color(Palette.review))
        }
    }
}

#Preview("Inline chips") {
    VStack(alignment: .leading, spacing: 20) {
        InlineText(
            pieces: [
                .text("Hi "), .chip(label: "Person 1 · landlord", spoken: "Protected person, Person 1, landlord", style: .protected(.person, lowConfidence: false), entityID: nil),
                .text(", the heater at "), .chip(label: "Place 1", spoken: "Protected place", style: .protected(.location, lowConfidence: true), entityID: nil),
                .text(" has been broken since Oct 28. I work nights at "), .chip(label: "a large hospital", spoken: "Made less specific: a large hospital", style: .generalised, entityID: nil),
                .text("."),
            ], popChips: true)
        InlineText(pieces: [.text("Hi "), .restored("Raj"), .text(", the heater at "), .restored("14 Elm St, Apt 3B"), .text(" is still broken.")], unsealNew: true)
    }
    .padding()
    .background(Palette.bg)
}
