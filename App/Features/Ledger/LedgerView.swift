import AirlockCore
import AirlockLedger
import SwiftUI

/// Every request that left this device, as a hash-chained receipt.
struct LedgerView: View {
    let session: AirlockSession

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollViewReader { proxy in
            screen
                .onChange(of: session.receiptFocusRun, initial: true) { _, _ in
                    guard let id = session.focusedReceiptID else { return }
                    Task {
                        // Let the row expand before scrolling to it.
                        try? await Task.sleep(for: .milliseconds(150))
                        withAnimation(Motion.animation(Motion.easeOut(Motion.med), reduce: reduceMotion)) { proxy.scrollTo(id, anchor: .top) }
                    }
                }
        }
    }

    private var screen: some View {
        ScreenScroll {
            ScreenHeader(
                title: String(localized: "Ledger"),
                subtitle: String(localized: "Every request that left this device has a receipt. Receipts are chained, so editing or deleting one breaks the chain."))
            hero.enter()
            verifyRow
            VStack(alignment: .leading, spacing: 0) {
                Text("Receipts").font(.headline).foregroundStyle(Palette.text).padding(.bottom, 8).accessibilityAddTraits(.isHeader)
                if session.receipts.isEmpty {
                    EmptyState(
                        glyph: .ledger, title: String(localized: "No receipts yet."),
                        detail: String(localized: "A receipt is created every time something leaves your device. Answers made on this device don't need one."))
                } else {
                    let rows = Array(session.receipts.reversed())
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, r in
                        ReceiptRow(
                            receipt: r, order: rows.count - 1 - i, run: session.chainRun, chain: session.chain,
                            focusRun: session.focusedReceiptID == r.id ? session.receiptFocusRun : 0
                        )
                        .id(r.id)
                    }
                }
            }
            .card()
            .enter(1)
        }
        .navigationTitle(Text("Ledger"))
        .hidesNavigationBarOnPhone()
        .task { await session.refreshStats() }
    }

    private var hero: some View {
        let stats = session.stats
        return ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 28) { heroNumber(stats); heroDetail(stats) }
            VStack(alignment: .leading, spacing: 14) { heroNumber(stats); heroDetail(stats) }
        }
        .card()
    }

    private func heroNumber(_ stats: LedgerStats?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            CountUpText(value: stats?.sealedDetails ?? 0, font: .system(size: 56, weight: .heavy, design: .rounded))
                .foregroundStyle(Palette.seal)
            Text("details kept off the cloud this week").font(.footnote).foregroundStyle(Palette.text2)
        }
        .accessibilityElement(children: .combine)
    }

    private func heroDetail(_ stats: LedgerStats?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("**^[\(stats?.requests ?? 0) request](inflect: true)** sent to Gemini").foregroundStyle(Palette.text)
            Text("**\(stats?.onDeviceAnswers ?? 0)** answered on this device").foregroundStyle(Palette.text)
            Text(verbatim: breakdown(stats)).font(.footnote).foregroundStyle(Palette.text2)
        }
        .font(.callout)
    }

    private func breakdown(_ stats: LedgerStats?) -> String {
        let names: [String: (one: String, many: String)] = [
            "person": (String(localized: "person"), String(localized: "people")),
            "org": (String(localized: "organisation"), String(localized: "organisations")),
            "location": (String(localized: "place"), String(localized: "places")),
            "contact": (String(localized: "contact detail"), String(localized: "contact details")),
            "id": (String(localized: "ID"), String(localized: "IDs")), "date": (String(localized: "date"), String(localized: "dates")),
            "health": (String(localized: "health detail"), String(localized: "health details")),
            "secret": (String(localized: "secret"), String(localized: "secrets")),
            "quasi": (String(localized: "other detail"), String(localized: "other details")),
        ]
        let parts = (stats?.byCategory ?? [:]).filter { $0.value > 0 }.sorted { $0.key < $1.key }.map { k, v in
            "\(v) \(names[k].map { v == 1 ? $0.one : $0.many } ?? k)"
        }
        return parts.isEmpty ? String(localized: "No details sealed yet.") : parts.joined(separator: " · ")
    }

    @ViewBuilder private var verifyRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                Task { await session.verifyChain() }
            } label: {
                IconLabel(title: "Verify chain", glyph: .link)
            }
            .buttonStyle(.secondary)
            .accessibilityHint(Text("Recomputes every receipt's hash from the first one"))
            switch session.chain {
            case .valid(let count)?:
                Banner(tone: .ok, title: String(AttributedString(localized: "Chain intact · ^[\(count) receipt](inflect: true)").characters))
                    .id(session.chainRun)
            case .broken(_, let seq, let reason)?:
                Banner(tone: .risk, title: String(localized: "Receipt #\(seq) doesn't match. Something changed it."), message: reasonText(reason))
            case nil:
                EmptyView()
            }
        }
        .sensoryFeedback(.success, trigger: session.chainRun)
    }

    private func reasonText(_ r: ChainVerification.Reason) -> String {
        switch r {
        case .hashMismatch: String(localized: "Its contents don't match its hash.")
        case .prevHashMismatch: String(localized: "It doesn't link to the receipt before it.")
        case .seqGap: String(localized: "A receipt is missing before it.")
        case .genesisMismatch: String(localized: "The first receipt doesn't start the chain.")
        }
    }
}

/// One receipt: tap to see exactly what left, its hashes and checks.
struct ReceiptRow: View {
    let receipt: Receipt
    /// Position from the start of the chain (for the verify sequence).
    let order: Int
    let run: Int
    let chain: ChainVerification?
    /// Non-zero when ⌘R or "See receipt" asked for this receipt: it opens.
    var focusRun = 0
    @State private var open = false
    @State private var lit = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var broken: Bool {
        if case .broken(_, let seq, _)? = chain { return seq == receipt.seq }
        return false
    }
    private var verified: Bool { chain?.isValid == true && run > 0 }
    private var onDevice: Bool { receipt.modelVersion == EngineResult.appleOnDeviceModelVersion }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(Motion.animation(Motion.easeOut(Motion.med), reduce: reduceMotion)) { open.toggle() }
            } label: {
                HStack(spacing: 12) {
                    HStack(spacing: 4) {
                        Icon(.link, size: 14).foregroundStyle(Palette.seal).opacity(verified ? 1 : 0)
                        Text(verbatim: "#\(receipt.seq)").font(.airlockMono)
                    }
                    .frame(minWidth: 56, alignment: .leading)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Icon(onDevice ? .device : .cloud, size: 14)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(modelName) · \(receipt.outboundChars) characters").foregroundStyle(Palette.text)
                            Text(verbatim: date).font(.footnote).foregroundStyle(Palette.text2)
                        }
                        .multilineTextAlignment(.leading)
                    }
                    .font(.subheadline)
                    Spacer(minLength: 6)
                    Circle().fill(receipt.gate.passed ? Palette.seal : Palette.risk).frame(width: 10, height: 10)
                    Icon(.chevron, size: 14).foregroundStyle(Palette.text2).rotationEffect(.degrees(open ? 90 : 0))
                }
                .padding(.vertical, 12)
                .padding(.horizontal, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                Text(
                    "Receipt \(receipt.seq), \(modelName), \(receipt.outboundChars) characters, \(date). \(receipt.gate.passed ? String(localized: "Gate passed") : String(localized: "Gate bypassed"))"
                )
            )
            .accessibilityValue(Text(open ? "Expanded" : "Collapsed"))
            if open { detail.transition(.opacity.combined(with: .move(edge: .top))) }
            Divider().overlay(Palette.stroke)
        }
        .background(
            RoundedRectangle(cornerRadius: 8).fill(broken ? Palette.riskTint : lit ? Palette.sealTint : .clear)
        )
        .onChange(of: run) { _, _ in light() }
        .onChange(of: focusRun, initial: true) { _, new in
            if new > 0 { open = true }
        }
    }

    private var modelName: String {
        onDevice ? Pieces.prettyModel(receipt.modelVersion) : "Gemini \(Pieces.prettyModel(receipt.modelVersion))"
    }

    private var date: String {
        (try? Date(receipt.createdAt, strategy: .iso8601))?.formatted(date: .abbreviated, time: .shortened) ?? receipt.createdAt
    }

    private func light() {
        guard chain?.isValid == true else { return }
        if reduceMotion {
            lit = false
            return
        }
        Task {
            try? await Task.sleep(for: .milliseconds(120 * order))
            withAnimation(Motion.easeOut(0.3)) { lit = true }
            try? await Task.sleep(for: .milliseconds(450))
            withAnimation(Motion.easeOut(0.6)) { lit = false }
        }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Exactly what left (sealed):").font(.footnote).foregroundStyle(Palette.text2)
            Text(verbatim: receipt.outboundText ?? String(localized: "(not kept)")).font(.callout.monospaced()).foregroundStyle(Palette.text)
                .textSelection(.enabled)
            Group {
                Text(verbatim: "sha256 \(receipt.outboundSha256)")
                Text(verbatim: "prev \(receipt.prevHash.prefix(16))… · hash \(receipt.hash.prefix(16))…")
            }
            .font(.airlockMono).foregroundStyle(Palette.text2).textSelection(.enabled)
            Text(
                "Checks passed: \(receipt.gate.checks.joined(separator: " ")) · Seal \(receipt.latencyMs["seal"] ?? 0) ms · Network \(receipt.latencyMs["network"] ?? 0) ms"
            )
            .font(.footnote).foregroundStyle(Palette.text2)
        }
        .card(padding: 14, tint: Palette.bg)
        .padding(.bottom, 10)
    }
}

#Preview("Ledger") {
    NavigationStack { LedgerView(session: PreviewSession.make(scenario: .ledger)) }
}

#Preview("Ledger empty") {
    NavigationStack { LedgerView(session: PreviewSession.make()) }
}
