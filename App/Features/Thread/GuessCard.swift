import AirlockCore
import AirlockRoute
import SwiftUI

/// F-25 "What could Gemini still guess?" — asks Gemini (cloudOnly) what it can infer from the exact
/// sealed text it already saw, so the user sees what sealing does not hide: their situation.
struct GuessCard: View {
    let session: AirlockSession
    let thread: ChatThread

    var body: some View {
        let state = session.guess(for: thread)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Icon(.eye, size: 18).foregroundStyle(Palette.cloud)
                    .frame(width: 34, height: 34)
                    .background(Palette.cloudTint, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text("What could Gemini still guess?").font(.headline).foregroundStyle(Palette.text).accessibilityAddTraits(.isHeader)
                    Text(
                        "Sealing hides who you are, not what happened. Ask Gemini what it can infer from the exact sealed text it already saw. Nothing new is sent, and you get a receipt."
                    )
                    .font(.footnote).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
                }
            }
            switch state?.phase {
            case nil:
                Button {
                    Task { await session.inferGuesses(thread.id) }
                } label: {
                    IconLabel(title: "Ask Gemini what it can infer", glyph: .sparkle)
                }
                .buttonStyle(.secondary)
                .accessibilityHint(Text("Sends the same sealed text again and writes a receipt"))
            case .asking?:
                HStack(spacing: 8) {
                    PulseDot(color: Palette.cloud, size: 8)
                    Text("Asking Gemini with the same sealed text…").font(.subheadline).foregroundStyle(Palette.text2)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
            case .failed(let failure)?:
                Banner(tone: .risk, title: failure.message) {
                    Button("Try again") { Task { await session.inferGuesses(thread.id) } }
                        .buttonStyle(AirlockButtonStyle(kind: .secondary, compact: true))
                        .padding(.top, 6)
                }
            case .done(let items, let unreadable, let receiptID)?:
                results(items, unreadable: unreadable, receiptID: receiptID)
            }
        }
        .card(padding: 16)
        .enter()
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func results(_ items: [Inference], unreadable: Bool, receiptID: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if unreadable {
                Banner(tone: .warn, title: String(localized: "Gemini's reply couldn't be read as a list. Try again.")) {
                    Button("Try again") { Task { await session.inferGuesses(thread.id) } }
                        .buttonStyle(AirlockButtonStyle(kind: .secondary, compact: true))
                        .padding(.top, 6)
                }
            } else if items.isEmpty {
                Banner(tone: .ok, title: String(localized: "Gemini couldn't infer anything specific about you from the sealed text."))
            }
            ForEach(Array(items.enumerated()), id: \.offset) { i, g in
                GuessRow(inference: g, entities: thread.entities).enter(i + 1)
            }
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 10) { footer(items, receiptID: receiptID) }
                VStack(alignment: .leading, spacing: 8) { footer(items, receiptID: receiptID) }
            }
        }
    }

    @ViewBuilder
    private func footer(_ items: [Inference], receiptID: String) -> some View {
        Group {
            if items.isEmpty {
                Text("Receipt \(receiptID) is in the Ledger.")
            } else {
                Text(
                    "Too much? Next time, use **Protect this** on Review or a stricter dial. The details that give these away will be sealed too. Receipt \(receiptID) is in the Ledger."
                )
            }
        }
        .font(.footnote).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
        Button {
            session.openReceipt(receiptID)
        } label: {
            HStack(spacing: 4) {
                Icon(.ledger, size: 14)
                Text("See receipt")
            }
        }
        .buttonStyle(AirlockButtonStyle(kind: .ghost, compact: true))
        .fixedSize()
        .accessibilityHint(Text("Opens this receipt in the Ledger"))
    }
}

/// One guess: attribute, confidence badge, value and the words that gave it away (placeholders as chips).
struct GuessRow: View {
    let inference: Inference
    let entities: EntityMap

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(verbatim: inference.attribute.uppercased())
                    .font(.caption.weight(.bold)).tracking(0.7).foregroundStyle(Palette.text2)
                ConfidenceBadge(confidence: inference.confidence)
            }
            InlineText(pieces: Pieces.withChips(inference.value, entities: entities), font: .body.weight(.semibold))
            if !inference.evidence.isEmpty {
                InlineText(
                    pieces: [.text(String(localized: "because of “"))] + Pieces.withChips(inference.evidence, entities: entities) + [.text("”")],
                    font: .footnote)
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(alignment: .leading) {
            Rectangle().fill(inference.confidence.tint).frame(width: 4)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.stroke))
        .accessibilityElement(children: .combine)
    }
}

/// "high confidence" pill, coloured by how sure Gemini is (risk / review / cloud).
struct ConfidenceBadge: View {
    let confidence: Confidence

    var body: some View {
        Text(confidence.phrase)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 1)
            .foregroundStyle(confidence.tint)
            .background(confidence.tintBackground, in: Capsule())
    }
}

extension Confidence {
    var tint: Color {
        switch self {
        case .high: Palette.risk
        case .medium: Palette.review
        case .low: Palette.cloud
        }
    }

    var tintBackground: Color {
        switch self {
        case .high: Palette.riskTint
        case .medium: Palette.reviewTint
        case .low: Palette.cloudTint
        }
    }

    var phrase: String {
        switch self {
        case .high: String(localized: "high confidence")
        case .medium: String(localized: "medium confidence")
        case .low: String(localized: "low confidence")
        }
    }
}

/// F-27: paste an answer from anywhere; the real details go back in on this device.
struct PasteBackCard: View {
    let session: AirlockSession
    let threadID: String
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Icon(.device, size: 18).foregroundStyle(Palette.seal)
                    .frame(width: 34, height: 34)
                    .background(Palette.sealTint, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text("Paste the answer you got back").font(.headline).foregroundStyle(Palette.text).accessibilityAddTraits(.isHeader)
                    Text("Use the sealed text with any AI or person. Paste their reply here and Airlock puts the real details back, on this device only.")
                        .font(.footnote).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
                }
            }
            ComposeBox(
                text: $text, placeholder: String(localized: "e.g. Dear [[PERSON_1]], thanks for letting me know about [[LOC_1]]…"),
                accessibilityTitle: String(localized: "Answer to restore"), minHeight: 110)
            Button {
                let t = text
                text = ""
                Task { await session.restorePasted(threadID, text: t) }
            } label: {
                IconLabel(title: "Restore real details", glyph: .device)
            }
            .buttonStyle(.primary)
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityHint(Text("Puts the real names back into the pasted answer on this device. Nothing is sent."))
        }
        .card(padding: 16)
        .enter()
    }
}

#Preview("Guess card") {
    PreviewGuessHost(session: PreviewSession.make(scenario: .guess))
}

#Preview("Paste back") {
    PasteBackCard(session: PreviewSession.make(), threadID: "preview").padding().background(Palette.bg)
}

private struct PreviewGuessHost: View {
    let session: AirlockSession

    var body: some View {
        ScreenScroll {
            if let t = session.threads.first {
                GuessCard(session: session, thread: t)
            } else {
                TypingIndicator()
            }
        }
    }
}
