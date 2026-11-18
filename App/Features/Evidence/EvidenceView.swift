import AirlockLedger
import Foundation
import SwiftUI

/// "How Airlock is tested" (docs/06-UI-UX.md §5.12; web `EvidenceScreen`): what AirlockBench measured
/// on synthetic documents. Headline tiles with 95% intervals, the leak rate as each layer is added,
/// what the engine still misses, and how it was measured. A mock run is always labelled as one.
struct EvidenceView: View {
    let evidence: Evidence?

    var body: some View {
        ScreenScroll {
            ScreenHeader(
                title: String(localized: "How Airlock is tested"),
                subtitle: String(
                    localized:
                        "AirlockBench runs the same privacy engine on synthetic documents — fictional people, places and numbers — and measures what still gets through."
                ))
            if let e = evidence {
                EvidenceContent(e: e)
            } else {
                Banner(tone: .info, title: String(localized: "No benchmark results are bundled with this build yet."))
            }
        }
        .navigationTitle(Text("How Airlock is tested"))
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

private struct EvidenceContent: View {
    let e: Evidence
    @ScaledMetric(relativeTo: .body) private var tileMinWidth: CGFloat = 300

    var body: some View {
        if e.mock {
            Banner(
                tone: .warn, title: e.label ?? String(localized: "MOCK RUN — not real model results"),
                message: String(
                    localized:
                        "These numbers come from scripted stand-in models, to show what the report looks like. Real results are published here after the final evaluation run."
                ))
        }
        LazyVGrid(columns: [GridItem(.adaptive(minimum: tileMinWidth), spacing: 14, alignment: .top)], alignment: .leading, spacing: 14) {
            EvidenceTile(
                index: 0, glyph: .shield, label: String(localized: "Leak rate"), m: e.leakRate, better: .lower, mock: e.mock,
                definition: String(localized: "Share of documents where at least one direct identifier (name, address, number) left the device."))
            EvidenceTile(
                index: 1, glyph: .sparkle, label: String(localized: "Names caught"), m: e.namesCaught, better: .higher, mock: e.mock,
                definition: String(localized: "Share of all personal names in the documents that were sealed before anything was sent."))
            EvidenceTile(
                index: 2, glyph: .ledger, label: String(localized: "Answer quality"), m: e.quality, better: .higher, mock: e.mock,
                definition: String(localized: "Answers judged as good as or better than sending the raw text unprotected."))
            if let onDevice = e.onDevice {
                EvidenceTile(
                    index: 3, glyph: .device, label: String(localized: "Quick tasks on device"), m: onDevice, better: .higher, mock: e.mock,
                    definition: String(localized: "Quick tasks answered entirely on the device — nothing sent at all."))
            }
        }
        VStack(alignment: .leading, spacing: 10) {
            Text("Each layer lowers the leak rate").font(.headline).foregroundStyle(Palette.text).accessibilityAddTraits(.isHeader)
            Text("Same documents, one layer added at a time. Bars show the leak rate; whiskers its 95% interval.")
                .font(.footnote).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
            AblationChart(rows: e.ablation)
        }
        .card()
        .enter(4)
        if !e.misses.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    ScaledIcon(.alert, size: 16, relativeTo: .headline).foregroundStyle(Palette.review)
                    Text("What we still miss").font(.headline).foregroundStyle(Palette.text)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(e.misses.enumerated()), id: \.offset) { _, miss in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(verbatim: "•").foregroundStyle(Palette.text2).accessibilityHidden(true)
                            Text(verbatim: miss).font(.subheadline).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                Text(
                    "Every miss above is from a synthetic document. This is why Review always shows you exactly what will leave, and why “Protect this” exists."
                )
                .font(.footnote).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
            }
            .card()
            .enter(5)
        }
        footer.enter(6)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Measured on \(e.n) synthetic documents in \(languages) on \(date) (\(e.dataset), \(e.split) split).")
                .font(.footnote).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
            if let url = URL(string: e.method), url.scheme == "https" {
                HStack(spacing: 4) {
                    Text("Method and code:").font(.footnote).foregroundStyle(Palette.text2)
                    Link(destination: url) {
                        Text(verbatim: "github.com/something1703/airlock/eval").font(.footnote.weight(.semibold)).foregroundStyle(Palette.cloud)
                    }
                    .accessibilityLabel(Text("Method and code on GitHub"))
                }
            }
        }
    }

    private var languages: String {
        e.languages.map { Locale.current.localizedString(forLanguageCode: $0) ?? $0 }.formatted(.list(type: .and))
    }

    private var date: String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        guard let d = iso.date(from: e.createdAt) ?? plain.date(from: e.createdAt) else { return e.createdAt }
        return d.formatted(date: .long, time: .omitted)
    }
}

/// Percent with `digits` decimals ("41.7%"), like the web `pct`.
private func pct(_ v: Double, _ digits: Int = 0) -> String {
    v.formatted(.percent.precision(.fractionLength(digits)))
}

// MARK: Tiles

private enum Better { case lower, higher }

/// One headline number: count-up value, 95% interval bar, n and a plain definition.
private struct EvidenceTile: View {
    let index: Int
    let glyph: Glyph
    let label: String
    let m: Evidence.Measure
    let better: Better
    let mock: Bool
    let definition: String
    @ScaledMetric(relativeTo: .subheadline) private var badge: CGFloat = 28

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                ZStack {
                    RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Palette.sealTint)
                    Icon(glyph, size: badge * 0.57).foregroundStyle(Palette.seal)
                }
                .frame(width: badge, height: badge)
                Text(label).font(.subheadline.weight(.bold)).foregroundStyle(Palette.text)
            }
            CountUpPercent(value: m.value)
                .font(.system(.largeTitle, design: .default).weight(.heavy))
                .foregroundStyle(mock ? Palette.text2 : Palette.text)
                .padding(.top, 4)
            IntervalBar(m: m).frame(height: 12)
            Text("95% interval \(pct(m.low, 1))–\(pct(m.high, 1)) · n = \(m.n) · \(betterText)")
                .font(.footnote).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
            Text(definition).font(.footnote).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(border: mock ? .clear : nil)
        .overlay {
            if mock {
                RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous)
                    .strokeBorder(Palette.muted.opacity(0.6), style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            Text(
                "\(label): \(pct(m.value, 1)), 95% interval \(pct(m.low, 1)) to \(pct(m.high, 1)), \(m.n) samples, \(betterText). \(definition)"
            )
        )
        .enter(index)
    }

    private var betterText: String {
        switch better {
        case .lower: String(localized: "lower is better")
        case .higher: String(localized: "higher is better")
        }
    }
}

/// Counts up from 0 to `value` with one decimal (ease-out cubic, 0.9 s); instant under Reduce Motion.
private struct CountUpPercent: View {
    let value: Double
    var duration = 0.9
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var startedAt: Date?

    var body: some View {
        TimelineView(.animation(paused: reduceMotion || finished)) { tl in
            let k = startedAt.map { Motion.easeOutCubic(tl.date.timeIntervalSince($0) / duration) } ?? 0
            Text(verbatim: pct(reduceMotion ? value : value * k, 1))
                .monospacedDigit()
        }
        .onAppear { if startedAt == nil { startedAt = Date() } }
    }

    private var finished: Bool { startedAt.map { Date().timeIntervalSince($0) > duration + 0.1 } ?? false }
}

/// The 95% interval on a 0–100% track: track, shaded range, point estimate.
private struct IntervalBar: View {
    let m: Evidence.Measure

    var body: some View {
        GeometryReader { g in
            let w = g.size.width
            let h = g.size.height
            ZStack(alignment: .leading) {
                Capsule().fill(Palette.stroke).frame(height: 2)
                Capsule().fill(Palette.seal.opacity(0.35))
                    .frame(width: max(3, (clamp(m.high) - clamp(m.low)) * w), height: 6)
                    .offset(x: clamp(m.low) * w)
                Rectangle().fill(Palette.seal)
                    .frame(width: 2, height: h)
                    .offset(x: min(max(clamp(m.value) * w - 1, 0), w - 2))
            }
            .frame(width: w, height: h, alignment: .leading)
        }
        .accessibilityHidden(true)
    }
}

private func clamp(_ v: Double) -> CGFloat { CGFloat(min(max(v, 0), 1)) }

// MARK: Ablation chart

/// Leak rate as each layer is added: hand-drawn bars with 95% interval whiskers. The last row (every
/// layer on) is drawn in the seal colour. Real text labels, so it scales with Dynamic Type.
private struct AblationChart: View {
    let rows: [Evidence.AblationRow]
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var grown = false
    @ScaledMetric(relativeTo: .subheadline) private var barHeight: CGFloat = 22
    @ScaledMetric(relativeTo: .subheadline) private var labelWidth: CGFloat = 128
    @ScaledMetric(relativeTo: .caption2) private var axisRoom: CGFloat = 220
    @ScaledMetric(relativeTo: .caption2) private var axisHeight: CGFloat = 18

    private static let ticks: [Double] = [0, 0.25, 0.5, 0.75, 1]

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                stacked
            } else {
                Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                        GridRow {
                            label(r, i).frame(width: labelWidth, alignment: .trailing).multilineTextAlignment(.trailing)
                            bar(r, i).frame(height: barHeight + 18)
                            value(r, i).gridColumnAlignment(.trailing)
                        }
                    }
                    GridRow {
                        Color.clear.frame(width: labelWidth, height: 1)
                        axis
                        Color.clear.frame(width: 0, height: 1)  // The value column stays as wide as its numbers.
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Leak rate by configuration: \(summary)"))
        .onAppear { grown = true }  // Each bar animates itself (staggered); Reduce Motion draws them full.
    }

    /// Accessibility sizes: label and value above each bar, full width.
    private var stacked: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        label(r, i)
                        Spacer(minLength: 8)
                        value(r, i)
                    }
                    bar(r, i).frame(height: barHeight + 12)
                }
            }
            axis
        }
    }

    private var summary: String {
        rows.map { "\($0.label) \(pct($0.leak.value))" }.formatted(.list(type: .and))
    }

    private func isBest(_ i: Int) -> Bool { i == rows.count - 1 }

    private func label(_ r: Evidence.AblationRow, _ i: Int) -> some View {
        Text(verbatim: r.label)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(isBest(i) ? Palette.seal : Palette.text)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func value(_ r: Evidence.AblationRow, _ i: Int) -> some View {
        Text(verbatim: pct(r.leak.value))
            .font(.subheadline.weight(.bold)).monospacedDigit()
            .foregroundStyle(Palette.text)
    }

    private func bar(_ r: Evidence.AblationRow, _ i: Int) -> some View {
        GeometryReader { g in
            let w = g.size.width
            let mid = g.size.height / 2
            ZStack(alignment: .topLeading) {
                // Grid lines at 0, 25, 50, 75 and 100%; consecutive rows join into one grid.
                ForEach(Self.ticks, id: \.self) { t in
                    Rectangle().fill(Palette.stroke).frame(width: 1, height: g.size.height).offset(x: min(t * w, w - 1))
                }
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(isBest(i) ? Palette.seal : Palette.risk.opacity(0.55))
                    .frame(width: max(2, clamp(r.leak.value) * w), height: barHeight)
                    .scaleEffect(x: grown || reduceMotion ? 1 : 0.001, anchor: .leading)
                    .animation(Motion.animation(Motion.easeOut(0.7).delay(Double(i) * 0.12), reduce: reduceMotion), value: grown)
                    .offset(y: mid - barHeight / 2)
                Whisker(low: clamp(r.leak.low), high: clamp(r.leak.high), cap: barHeight * 0.55)
                    .stroke(Palette.text.opacity(0.7), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
            }
        }
    }

    private var axis: some View {
        GeometryReader { g in
            // 0% and 100% sit inside the ends; the quarter marks only where there is room for them.
            let ticks = g.size.width < axisRoom ? [0, 0.5, 1] : Self.ticks
            ZStack {
                ForEach(ticks, id: \.self) { t in
                    let text = Text(verbatim: pct(t)).font(.caption2).monospacedDigit().foregroundStyle(Palette.text2).fixedSize()
                    if t == 0 {
                        text.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                    } else if t == 1 {
                        text.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
                    } else {
                        text.position(x: t * g.size.width, y: g.size.height / 2)
                    }
                }
            }
        }
        .frame(height: axisHeight)
    }
}

/// An interval whisker: a horizontal line from `low` to `high` (fractions of the width) with end caps.
private struct Whisker: Shape {
    let low: CGFloat
    let high: CGFloat
    let cap: CGFloat

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let y = rect.midY
        let x0 = rect.minX + low * rect.width
        let x1 = rect.minX + high * rect.width
        p.move(to: CGPoint(x: x0, y: y))
        p.addLine(to: CGPoint(x: x1, y: y))
        for x in [x0, x1] {
            p.move(to: CGPoint(x: x, y: y - cap / 2))
            p.addLine(to: CGPoint(x: x, y: y + cap / 2))
        }
        return p
    }
}

// MARK: Bundled reports

extension Evidence {
    /// `eval/reports/<run>/evidence.json`, copied into the app as `Evidence/<run>.json` by project.yml.
    static func bundledReports(in bundle: Bundle = .main) -> [Data] {
        (bundle.urls(forResourcesWithExtension: "json", subdirectory: "Evidence") ?? [])
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .compactMap { try? Data(contentsOf: $0) }
    }
}

#Preview("Evidence · mock run") {
    NavigationStack { EvidenceView(evidence: PreviewEvidence.mock) }
}

#Preview("Evidence · real run") {
    NavigationStack { EvidenceView(evidence: PreviewEvidence.real) }
}

#Preview("Evidence · none bundled") {
    NavigationStack { EvidenceView(evidence: nil) }
}
