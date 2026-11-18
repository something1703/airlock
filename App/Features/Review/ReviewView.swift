import AirlockCore
import AirlockSeal
import SwiftUI

/// The border: exactly what will leave, with every detail under the user's control.
struct ReviewView: View {
    let session: AirlockSession
    @State private var showRaw = false
    @State private var sending = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if os(iOS)
        @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    var body: some View {
        Group {
            if let review = session.review {
                if let result = review.result {
                    content(review, result)
                } else {
                    SealingView(review: review, demo: session.services.mode.isDemo)
                }
            } else {
                ScreenScroll { EmptyState(glyph: .shield, title: String(localized: "Nothing to review.")) }
            }
        }
        .overlay {
            if sending { SealDoorOverlay().transition(.opacity) }
        }
        .navigationTitle(Text("Review"))
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .sensoryFeedback(.error, trigger: session.blockCount)
        .onChange(of: session.sealRequest) { _, _ in
            guard session.canSealAndSend, !sending else { return }
            Task { await sealAndSend() }
        }
        .sensoryFeedback(.warning, trigger: session.pendingRisks.count) { old, new in new > old }
    }

    private var sideBySide: Bool {
        #if os(macOS)
            return true
        #else
            return sizeClass == .regular
        #endif
    }

    @ViewBuilder
    private func content(_ review: ReviewState, _ result: SealResult) -> some View {
        let entities = result.draft.entities.sorted.filter { e in result.merge.mentions.contains { $0.entityID == e.id } }
        let sealedCount = entities.filter { $0.action != .keep }.count
        let keptCount = entities.count - sealedCount
        let generalised = result.draft.replacements.filter { $0.kind == .generalised || $0.kind == .bucketed || $0.kind == .redteam }.count
        let risks = session.pendingRisks
        ScrollViewReader { proxy in
            ScreenScroll {
                ScreenHeader(
                    title: String(localized: "Check before sending"),
                    subtitle: String(localized: "This is exactly what will leave your device. Tap a protected detail to send it as written instead."))
                if !sideBySide {
                    Segmented(
                        options: [
                            .init(value: false, title: String(localized: "Leaves your device"), glyph: .shield),
                            .init(value: true, title: String(localized: "You wrote"), glyph: .eye),
                        ], selection: $showRaw, accessibilityTitle: String(localized: "Show"))
                }
                ForEach(Array(result.reasons.enumerated()), id: \.offset) { _, reason in
                    if let text = reasonText(reason, pending: risks.count) {
                        Banner(tone: reason.isSevere ? .risk : .warn, title: text)
                    }
                }
                if let blocked = review.blocked {
                    Banner(
                        tone: .risk, title: String(localized: "Airlock stopped this before it left"),
                        message: String(
                            localized:
                                "The final check found \(Self.list(Set(blocked.map(\.check)).sorted { $0.rawValue < $1.rawValue }.map(\.blockedWords))) still in the text. Protect it above, or edit your message."
                        ))
                }
                if sideBySide {
                    HStack(alignment: .top, spacing: 16) {
                        sealedCard(result, sealed: sealedCount, generalised: generalised, kept: keptCount)
                        rawCard(result)
                    }
                } else if showRaw {
                    rawCard(result)
                } else {
                    sealedCard(result, sealed: sealedCount, generalised: generalised, kept: keptCount)
                }
                if !risks.isEmpty {
                    Text("What someone could still guess").font(.title3.weight(.semibold)).foregroundStyle(Palette.text).accessibilityAddTraits(.isHeader)
                    ForEach(Array(risks.enumerated()), id: \.element.id) { i, r in
                        RiskCard(risk: r, entities: result.draft.entities, index: i) {
                            Task { await session.acceptRisk(r) }
                        } keep: {
                            session.dismissRisk(r)
                        }
                    }
                }
                if !entities.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Details").font(.headline).foregroundStyle(Palette.text).accessibilityAddTraits(.isHeader)
                        ForEach(entities) { e in
                            EntityRow(entity: e) { Task { await session.toggleEntity(e.id) } }
                        }
                    }
                    .card()
                    .enter(2)
                }
                TaskPills(selection: Binding(get: { review.task }, set: { session.setReviewTask($0) }))
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { sendButtons }
                    VStack(alignment: .leading, spacing: 10) { sendButtons }
                }
                Text("Gemini sees only the sealed version. Real names come back on your device.").font(.footnote).foregroundStyle(Palette.text2)
                    .id("actions")
            }
            .task {
                // Demo screenshots of Scrub & copy start at the buttons.
                guard session.revealReviewActions else { return }
                try? await Task.sleep(for: .milliseconds(900))
                proxy.scrollTo("actions", anchor: .bottom)
            }
        }
    }

    @ViewBuilder private var sendButtons: some View {
        Button {
            Task { await sealAndSend() }
        } label: {
            IconLabel(title: "Seal & send", glyph: .shield)
        }
        .buttonStyle(.primary)
        .disabled(sending)
        .touchKeyboardShortcut(.return, modifiers: .command)
        .accessibilityHint(Text("Runs the final check and sends only the sealed version"))
        if session.review?.threadID == nil {
            Button {
                Task { await session.copySealedVersion() }
            } label: {
                IconLabel(title: "Copy sealed version", glyph: .copy)
            }
            .buttonStyle(.secondary)
            .disabled(sending)
            .touchKeyboardShortcut("c", modifiers: [.command, .shift])
            .accessibilityHint(Text("Copies the sealed text to use with any other AI or person. Airlock sends nothing."))
        }
        Button("Cancel") { session.cancelReview() }.buttonStyle(.ghost)
    }

    private func sealAndSend() async {
        // The gate decides; the door only closes if it passed.
        guard session.gateCheck().isEmpty else {
            await session.send()
            return
        }
        withAnimation(.easeOut(duration: 0.12)) { sending = true }
        try? await Task.sleep(for: .milliseconds(reduceMotion ? 250 : 950))
        await session.send()
        sending = false
    }

    private func sealedCard(_ result: SealResult, sealed: Int, generalised: Int, kept: Int) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if sideBySide { CardLabel(glyph: .shield, title: String(localized: "Leaves your device")) }
            InlineText(pieces: Pieces.draft(result.draft, tappable: true), onChip: { id in Task { await session.toggleEntity(id) } }, popChips: true)
            FlowLayout(spacing: 14, lineSpacing: 6) {
                CountLabel(value: sealed, label: String(localized: "protected"))
                CountLabel(value: generalised, label: String(localized: "made less specific"))
                CountLabel(value: kept, label: String(localized: "sent as written"))
                HStack(spacing: 4) {
                    Icon(.device, size: 14)
                    Text("Sealed on this device in \(seconds(result.sealDuration)) s")
                }
                .font(.footnote).foregroundStyle(Palette.text2)
            }
        }
        .card()
        .enter()
        .sensoryFeedback(.selection, trigger: sealed)
    }

    private func rawCard(_ result: SealResult) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if sideBySide { CardLabel(glyph: .eye, title: String(localized: "You wrote · stays here")) }
            Text(verbatim: result.normalised.text).font(.body).foregroundStyle(Palette.text).lineSpacing(5).textSelection(.enabled)
        }
        .card()
        .enter()
    }

    private func seconds(_ d: Duration) -> String {
        (Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18).formatted(.number.precision(.fractionLength(1)))
    }

    static func list(_ items: [String]) -> String { items.formatted(.list(type: .and)) }

    private func reasonText(_ r: ReviewReason, pending: Int) -> String? {
        switch r {
        case .phoneUnavailable: String(localized: "Apple's on-device model isn't available, so Airlock used strict rules. Please check everything.")
        case .llmFailed: String(localized: "The on-device model couldn't read part of this. Rules were used there. Please check it.")
        case .refused: String(localized: "The on-device model declined to read part of this. Rules were used there. Please check it.")
        case .lowConfidence: String(localized: "Some details might be private (amber dot). Decide whether to protect them.")
        case .ambiguous: String(localized: "Some words could be a name or an ordinary word. Please check.")
        case .secretsFound: String(localized: "This contains a code or password. It has been removed. Never share these.")
        case .risks: pending == 0 ? nil : pending == 1 ? String(localized: "Someone could still guess one thing about you. See below.") : String(localized: "Someone could still guess \(pending) things about you. See below.")
        case .redTeamUnavailable: String(localized: "Airlock couldn't check what someone could still guess. Read the sealed text carefully.")
        }
    }
}

extension ReviewReason {
    var isSevere: Bool {
        switch self {
        case .secretsFound, .phoneUnavailable: true
        default: false
        }
    }
}

private struct CardLabel: View {
    let glyph: Glyph
    let title: String

    var body: some View {
        HStack(spacing: 6) {
            Icon(glyph, size: 14)
            Text(title)
        }
        .font(.footnote.weight(.semibold)).foregroundStyle(Palette.text2)
    }
}

private struct CountLabel: View {
    let value: Int
    let label: String

    var body: some View {
        HStack(spacing: 4) {
            Text(verbatim: "\(value)").bold().foregroundStyle(Palette.text).contentTransition(.numericText(value: Double(value)))
            Text(label).foregroundStyle(Palette.text2)
        }
        .font(.subheadline)
        .animation(.snappy, value: value)
        .accessibilityElement(children: .combine)
    }
}

/// One detail with its switch: protected ↔ sent as written.
struct EntityRow: View {
    let entity: Entity
    let toggle: () -> Void

    var body: some View {
        let isProtected = entity.action != .keep
        let locked = entity.category == .secret
        HStack(spacing: 10) {
            ChipView(label: "", style: Pieces.style(entity), iconOnly: true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: entity.canonical).font(.body.weight(.semibold)).foregroundStyle(Palette.text)
                Text(verbatim: detail).font(.footnote).foregroundStyle(Palette.text2)
            }
            Spacer(minLength: 8)
            Toggle(isOn: Binding(get: { isProtected }, set: { _ in toggle() })) {
                Text("Protect \(Pieces.chipLabel(entity))")
            }
            .labelsHidden()
            .tint(Palette.seal)
            .disabled(locked)
            .accessibilityLabel(Text("Protect \(Pieces.chipLabel(entity))"))
            .accessibilityValue(Text(isProtected ? "Protected" : "Sent as written"))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .overlay(RoundedRectangle(cornerRadius: Metrics.controlRadius).strokeBorder(Palette.stroke))
    }

    private var detail: String {
        var parts = [Pieces.chipLabel(entity)]
        switch entity.action {
        case .keep: parts.append(String(localized: "sent as written"))
        case .generalise: parts.append(String(localized: "sent as “\(entity.generalisedText ?? String(localized: "a general description"))”"))
        case .block: parts.append(String(localized: "removed"))
        case .placeholder: parts.append(String(localized: "replaced"))
        }
        if entity.vaultEntryID != nil { parts.append(String(localized: "from your Vault")) }
        if entity.confidence < .high { parts.append(String(localized: "possibly private")) }
        return parts.joined(separator: " · ")
    }
}

/// "A reader could guess …, because of …" with the on-device suggestion.
struct RiskCard: View {
    let risk: Risk
    let entities: EntityMap
    let index: Int
    let use: () -> Void
    let keep: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Icon(.eye, size: 16).foregroundStyle(Palette.review)
                    .frame(width: 30, height: 30).background(Palette.review.opacity(0.22), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 4) {
                    InlineText(pieces: [.text(String(localized: "A reader could guess: "))] + Pieces.withChips(risk.guess, entities: entities), font: .body.weight(.semibold))
                    InlineText(pieces: [.text(String(localized: "because of “"))] + Pieces.withChips(risk.evidence, entities: entities) + [.text("”")], font: .footnote)
                    if let s = risk.suggestion {
                        InlineText(pieces: [.text(String(localized: "Suggestion: “"))] + Pieces.withChips(s, entities: entities) + [.text("”")], font: .footnote)
                    }
                }
            }
            HStack(spacing: 10) {
                if risk.suggestion != nil { Button("Use suggestion", action: use).buttonStyle(.primary) }
                Button("Keep as is", action: keep).buttonStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.reviewTint, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.review))
        .enter(index + 3)
    }
}

/// The wait, made legible: the user's own text (local), a scanning beam and the steps ticking off.
struct SealingView: View {
    let review: ReviewState
    var demo = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var current: Int {
        switch review.progress {
        case nil, .detecting?: 0
        case .generalising?: 1
        case .checkingRisks?: 2
        case .done?: 3
        }
    }

    var body: some View {
        ScreenScroll {
            ScreenHeader(
                title: String(localized: "Sealing on your device"),
                subtitle: String(localized: "Nothing has left this device. You'll see exactly what will be sent before it goes."))
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Icon(.device, size: 16)
                    Text("On this device · nothing sent yet")
                }
                .font(.subheadline.weight(.semibold)).foregroundStyle(Palette.seal)
                Text(verbatim: review.raw.count > 900 ? String(review.raw.prefix(900)) + "…" : review.raw)
                    .font(.body).foregroundStyle(Palette.text2).lineSpacing(5)
            }
            .card()
            .overlay { if !reduceMotion { ScanSweep().clipShape(RoundedRectangle(cornerRadius: Metrics.radius)) } }
            .enter()
            VStack(alignment: .leading, spacing: 12) {
                StepRow(title: detectingTitle, state: state(0))
                StepRow(title: String(localized: "Making details less specific"), state: state(1))
                StepRow(title: String(localized: "Checking what someone could still guess"), state: state(2))
                TimelineView(.periodic(from: review.startedAt, by: 0.1)) { tl in
                    let s = max(0, tl.date.timeIntervalSince(review.startedAt))
                    Text(
                        demo
                            ? "\(s.formatted(.number.precision(.fractionLength(1)))) s · Demo mode: scripted on-device steps"
                            : "\(s.formatted(.number.precision(.fractionLength(1)))) s · Apple's on-device model is doing this work locally"
                    )
                    .font(.footnote).monospacedDigit().foregroundStyle(Palette.text2)
                }
                .padding(.top, 4)
            }
            .card()
            .enter(1)
            .accessibilityElement(children: .contain)
        }
    }

    private var detectingTitle: String {
        if case .detecting(let section, let of)? = review.progress, of > 1 {
            return String(localized: "Reading on your device · part \(section) of \(of)")
        }
        return String(localized: "Reading on your device")
    }

    private func state(_ i: Int) -> StepRow.State { i < current ? .done : i == current ? .active : .waiting }
}

private struct StepRow: View {
    enum State { case waiting, active, done }
    let title: String
    let state: State
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().strokeBorder(state == .waiting ? Palette.stroke : Palette.seal, lineWidth: 1.8)
                if state == .done {
                    Circle().fill(Palette.seal)
                    Icon(.check, size: 13).foregroundStyle(Palette.onSeal).transition(.scale.combined(with: .opacity))
                }
                if state == .active && !reduceMotion { PingRing() }
            }
            .frame(width: 22, height: 22)
            .animation(Motion.animation(Motion.pop(0.36), reduce: reduceMotion), value: state)
            Text(title)
                .font(.subheadline.weight(state == .active ? .semibold : .regular))
                .foregroundStyle(state == .waiting ? Palette.text2 : Palette.text)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(Text(state == .done ? "Done" : state == .active ? "In progress" : "Waiting"))
    }
}

/// An expanding ring around the active step.
private struct PingRing: View {
    var body: some View {
        TimelineView(.animation) { tl in
            let p = tl.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.4) / 1.4
            Circle().stroke(Palette.seal.opacity(0.45 * (1 - p)), lineWidth: 4)
                .frame(width: 22 + 20 * p, height: 22 + 20 * p)
        }
        .allowsHitTesting(false)
    }
}

/// A soft beam sweeping across the card (sealing in progress).
private struct ScanSweep: View {
    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation) { tl in
                let p = Motion.easeOutCubic(tl.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.8) / 1.8)
                let w = geo.size.width * 0.3
                LinearGradient(colors: [.clear, Palette.seal.opacity(0.22), .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: w)
                    .offset(x: -w + (geo.size.width + w) * p)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

#Preview("Review") {
    NavigationStack { ReviewView(session: PreviewSession.make(scenario: .review)) }
}

#Preview("Sealing") {
    SealingView(review: ReviewState(raw: AirlockSession.sample, task: .reply, threadID: nil, progress: .generalising, startedAt: Date()), demo: true)
}
