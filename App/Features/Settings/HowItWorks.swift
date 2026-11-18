import SwiftUI

/// "How Airlock works": the 7 steps from your words to a receipt, as a native diagram drawn with the
/// design tokens and Airlock's own glyphs (the same story as `docs/images/how-it-works.svg`).
/// Everything is real text, so it scales with Dynamic Type and reads in order with VoiceOver.
struct HowItWorksDiagram: View {
    struct Step: Identifiable {
        let id: Int
        let glyph: Glyph
        let title: String
        let detail: String
    }

    static let device: [Step] = [
        Step(
            id: 1, glyph: .detect, title: String(localized: "Detect"),
            detail: String(localized: "Your Vault, pattern rules and Apple's on-device model find names, places, contact details and IDs.")),
        Step(
            id: 2, glyph: .shield, title: String(localized: "Seal"),
            detail: String(localized: "Each detail becomes a placeholder like PERSON_1, or something general like “a large hospital”.")),
        Step(
            id: 3, glyph: .target, title: String(localized: "Red-team"),
            detail: String(localized: "Your device attacks its own draft: what could a stranger still guess? You can accept a safer rewrite.")),
        Step(
            id: 4, glyph: .gate, title: String(localized: "Egress gate"),
            detail: String(localized: "7 fixed checks, and the only way to make sealed text. If a known detail or code is left, it blocks.")),
    ]
    static let cloud: [Step] = [
        Step(
            id: 5, glyph: .cloud, title: String(localized: "Gemini answers"),
            detail: String(localized: "Gemini sees only the sealed text, through Firebase AI Logic with App Check, and answers with placeholders."))
    ]
    static let back: [Step] = [
        Step(
            id: 6, glyph: .restore, title: String(localized: "Restore"),
            detail: String(localized: "Real names go back in on your device as the answer arrives. Codes and passwords are never put back.")),
        Step(
            id: 7, glyph: .ledger, title: String(localized: "Receipt"),
            detail: String(localized: "A SHA-256 hash of exactly what left, chained to the receipt before it. Verify it any time in the Ledger.")),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Zone(glyph: .device, title: String(localized: "On your device · your words never leave"), tint: Palette.seal, background: Palette.sealTint) {
                StepList(steps: Self.device, tint: Palette.seal, start: 0)
            }
            Handoff(title: String(localized: "Only the sealed text goes out"), tint: Palette.cloud, index: 4)
            Zone(glyph: .cloud, title: String(localized: "In the cloud"), tint: Palette.cloud, background: Palette.cloudTint) {
                StepList(steps: Self.cloud, tint: Palette.cloud, start: 5)
            }
            Handoff(title: String(localized: "The answer comes back with placeholders"), tint: Palette.seal, index: 6)
            Zone(glyph: .device, title: String(localized: "Back on your device"), tint: Palette.seal, background: Palette.sealTint) {
                StepList(steps: Self.back, tint: Palette.seal, start: 7)
            }
            Text("Quick tasks like summaries can be answered on this device. Then nothing leaves and no receipt is needed.")
                .font(.footnote).foregroundStyle(Palette.text2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("How Airlock works, 7 steps"))
    }
}

/// A tinted band: where the steps inside it happen.
private struct Zone<Content: View>: View {
    let glyph: Glyph
    let title: String
    let tint: Color
    let background: Color
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                ScaledIcon(glyph, size: 14, relativeTo: .caption)
                Text(title.uppercased()).font(.caption.weight(.bold)).tracking(0.6)
            }
            .foregroundStyle(tint)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text(title))
            .accessibilityAddTraits(.isHeader)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background.opacity(0.55), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(tint.opacity(0.35)))
    }
}

/// Numbered steps joined by a line through their icons.
private struct StepList: View {
    let steps: [HowItWorksDiagram.Step]
    let tint: Color
    let start: Int
    @ScaledMetric(relativeTo: .body) private var node: CGFloat = 34

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { i, step in
                HStack(alignment: .top, spacing: 12) {
                    ZStack {
                        Circle().fill(Palette.raised)
                        Circle().strokeBorder(tint, lineWidth: 1.5)
                        Icon(step.glyph, size: node * 0.53).foregroundStyle(tint)
                    }
                    .frame(width: node, height: node)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(verbatim: "\(step.id)").font(.footnote.weight(.bold)).monospacedDigit().foregroundStyle(tint)
                            Text(step.title).font(.body.weight(.semibold)).foregroundStyle(Palette.text)
                        }
                        Text(step.detail).font(.footnote).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 5)
                    .padding(.bottom, i < steps.count - 1 ? 14 : 0)
                }
                .background(alignment: .topLeading) {
                    // The line to the next step runs the full height of this row.
                    if i < steps.count - 1 {
                        Rectangle().fill(tint.opacity(0.45)).frame(width: 2)
                            .padding(.top, node)
                            .padding(.leading, node / 2 - 1)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text("Step \(step.id) of 7, \(step.title). \(step.detail)"))
                .enter(start + i)
            }
        }
    }
}

/// The arrow between zones: what crosses the border.
private struct Handoff: View {
    let title: String
    let tint: Color
    let index: Int
    @ScaledMetric(relativeTo: .body) private var node: CGFloat = 34

    var body: some View {
        HStack(spacing: 12) {
            VStack(spacing: 2) {
                Rectangle().fill(tint.opacity(0.6)).frame(width: 2, height: 10)
                Icon(.arrow, size: 14).rotationEffect(.degrees(90)).foregroundStyle(tint)
            }
            .frame(width: node)
            Text(title).font(.footnote.weight(.semibold)).foregroundStyle(tint)
        }
        .padding(.leading, 14)
        .padding(.vertical, 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(title))
        .enter(index)
    }
}

#Preview("How Airlock works") {
    ScrollView {
        HowItWorksDiagram().card().padding()
    }
    .background(Palette.bg)
}
