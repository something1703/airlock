import AirlockCore
import AirlockDetect
import SwiftUI

/// Three steps: what Airlock does (hero animation), who to always protect (Vault quick-add),
/// how careful to be (privacy dial) + on-device status.
struct OnboardingView: View {
    let session: AirlockSession
    @State private var step = 0
    @State private var me = ""
    @State private var others: [PersonDraft] = [PersonDraft()]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    struct PersonDraft: Identifiable {
        let id = UUID()
        var name = ""
        var role = ""
    }

    var body: some View {
        ScreenScroll {
            Group {
                switch step {
                case 0: intro
                case 1: vault
                default: dial
                }
            }
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
            .id(step)
            .transition(.asymmetric(insertion: .opacity.combined(with: .move(edge: .trailing)), removal: .opacity))
        }
    }

    private func next(_ s: Int) {
        withAnimation(Motion.animation(Motion.easeOut(), reduce: reduceMotion)) { step = s }
    }

    // MARK: Step 1

    private var intro: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                AirlockLogo(size: 40, animated: true)
                StepDots(step: 0)
            }
            Text("AI is great. Oversharing isn't.").font(.airlockDisplay).foregroundStyle(Palette.text).accessibilityAddTraits(.isHeader)
            Text("Airlock lets you ask the smartest AI about private things, while the details that identify you stay on your device.")
                .font(.body).foregroundStyle(Palette.text2)
            HeroAnimation().enter(1)
            VStack(alignment: .leading, spacing: 12) {
                HowItWorksRow(number: 1, title: String(localized: "Your device reads it first."), detail: String(localized: "Apple's on-device model finds names, places and numbers and seals them, on this device."))
                HowItWorksRow(number: 2, title: String(localized: "Gemini gets the problem, not the person."), detail: String(localized: "Only the sealed version is sent, after a final check."))
                HowItWorksRow(number: 3, title: String(localized: "The real names come back on your device."), detail: String(localized: "Every request gets a receipt showing exactly what left."))
            }
            .card()
            .enter(2)
            Text(
                "Airlock hides who you are, not what happened. Detection isn't perfect, which is why you can review everything before it's sent. Airlock helps you understand and prepare; it doesn't give legal, medical or financial advice."
            )
            .font(.footnote).foregroundStyle(Palette.text2)
            Button { next(1) } label: { IconLabel(title: "Get started", glyph: .arrow, trailing: true) }
                .buttonStyle(.primary)
                .accessibilityHint(Text("Step 2 of 3: choose who to always protect"))
        }
    }

    // MARK: Step 2

    private var vault: some View {
        VStack(alignment: .leading, spacing: 16) {
            StepDots(step: 1)
            ScreenHeader(
                title: String(localized: "Who should always be protected?"),
                subtitle: String(localized: "Add your name and the people you never want to share. Stored only on this device, encrypted."))
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Your name").font(.footnote).foregroundStyle(Palette.text2)
                    TextField(String(localized: "e.g. Maya Chen"), text: $me)
                        .textFieldStyle(AirlockFieldStyle())
                        #if os(iOS)
                            .textContentType(.name)
                        #endif
                        .accessibilityLabel(Text("Your name"))
                }
                ForEach($others) { $o in
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) {
                            nameField($o.name).frame(minWidth: 180)
                            roleField($o.role).frame(minWidth: 120)
                        }
                        VStack(spacing: 8) {
                            nameField($o.name)
                            roleField($o.role)
                        }
                    }
                }
                Button {
                    others.append(PersonDraft())
                } label: {
                    IconLabel(title: "Add someone", glyph: .plus)
                }
                .buttonStyle(.ghost)
            }
            .card()
            HStack {
                Button("Continue") { Task { await saveVault() } }.buttonStyle(.primary)
                Button("Skip") { next(2) }.buttonStyle(.ghost)
            }
        }
    }

    private func nameField(_ text: Binding<String>) -> some View {
        TextField(String(localized: "Someone else, e.g. Raj Patel"), text: text)
            .textFieldStyle(AirlockFieldStyle())
            .accessibilityLabel(Text("Person's name"))
    }

    private func roleField(_ text: Binding<String>) -> some View {
        TextField(String(localized: "role, e.g. landlord"), text: text)
            .textFieldStyle(AirlockFieldStyle())
            .accessibilityLabel(Text("Their role to you"))
    }

    private func saveVault() async {
        var entries: [VaultEntry] = []
        let mine = me.trimmingCharacters(in: .whitespaces)
        if !mine.isEmpty {
            entries.append(
                VaultEntry(
                    id: UUID().uuidString, canonical: mine, aliases: AirlockSession.firstNameAlias(mine), category: .person, roleHint: "me", isUser: true))
        }
        for o in others {
            let name = o.name.trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { continue }
            let role = o.role.trimmingCharacters(in: .whitespaces)
            entries.append(
                VaultEntry(
                    id: UUID().uuidString, canonical: name, aliases: AirlockSession.firstNameAlias(name), category: .person,
                    roleHint: role.isEmpty ? nil : "my \(role)"))
        }
        if !entries.isEmpty { await session.addVaultEntries(entries) }
        next(2)
    }

    // MARK: Step 3

    private var dial: some View {
        VStack(alignment: .leading, spacing: 16) {
            StepDots(step: 2)
            ScreenHeader(title: String(localized: "Choose how careful to be."), subtitle: String(localized: "You can change this any time in Settings."))
            DialCards(session: session)
            OnDeviceStatus(session: session)
            Button { session.finishOnboarding() } label: { IconLabel(title: "Start", glyph: .arrow, trailing: true) }
                .buttonStyle(.primary)
        }
    }
}

/// The three dial cards with strength meters (radio group).
struct DialCards: View {
    let session: AirlockSession
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 12) {
            ForEach(Array(DialPreset.ordered.enumerated()), id: \.element) { i, d in
                let on = session.prefs.dial == d
                Button {
                    withAnimation(Motion.animation(Motion.easeOut(Motion.med), reduce: reduceMotion)) { session.setPrefs { $0.dial = d } }
                } label: {
                    HStack(spacing: 14) {
                        StrengthMeter(level: d.level, on: on)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(d.title).font(.headline).foregroundStyle(Palette.text)
                            Text(d.line).font(.footnote).foregroundStyle(Palette.text2).multilineTextAlignment(.leading)
                        }
                        Spacer(minLength: 0)
                    }
                    .card(padding: 16, border: on ? Palette.seal : nil)
                    .overlay(RoundedRectangle(cornerRadius: Metrics.radius).stroke(on ? Palette.sealTint : .clear, lineWidth: 3).padding(-2))
                    .contentShape(RoundedRectangle(cornerRadius: Metrics.radius))
                }
                .buttonStyle(.plain)
                .enter(i)
                .accessibilityLabel(Text("\(d.title). \(d.line)"))
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Privacy dial"))
    }
}

/// Onboarding progress dots; the current one stretches.
struct StepDots: View {
    let step: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<3, id: \.self) { i in
                Capsule().fill(i == step ? Palette.seal : Palette.stroke).frame(width: i == step ? 24 : 8, height: 8)
            }
        }
        .accessibilityElement()
        .accessibilityLabel(Text("Step \(step + 1) of 3"))
    }
}

private struct HowItWorksRow: View {
    let number: Int
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(verbatim: "\(number)").font(.subheadline.weight(.bold)).foregroundStyle(Palette.seal)
                .frame(width: 24, height: 24).background(Palette.sealTint, in: Circle())
            Text("\(Text(title).bold()) \(Text(detail).foregroundStyle(Palette.text2))")
                .font(.callout).foregroundStyle(Palette.text)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Fictional details flow left → right through the airlock and come out as chips.
struct HeroAnimation: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct Lane: Identifiable {
        let before: String
        let after: String
        let category: PrivacyCategory
        let offset: Double
        var id: String { before }
    }

    private let lanes = [
        Lane(before: "Raj Patel", after: String(localized: "Person 1 · landlord"), category: .person, offset: 0),
        Lane(before: "14 Elm St, Apt 3B", after: String(localized: "Place 1"), category: .location, offset: 2),
        Lane(before: "312-555-0147", after: String(localized: "Contact 1"), category: .contact, offset: 4),
    ]
    private let period = 6.0

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            ZStack(alignment: .topLeading) {
                gate.position(x: w / 2, y: 75)
                TimelineView(.animation(paused: reduceMotion)) { tl in
                    let t = tl.date.timeIntervalSinceReferenceDate
                    ForEach(Array(lanes.enumerated()), id: \.element.id) { i, lane in
                        token(lane, t: t, width: w, y: 34 + CGFloat(i) * 34)
                    }
                }
                HStack {
                    HStack(spacing: 6) { Icon(.device, size: 14); Text("Your device") }
                    Spacer()
                    HStack(spacing: 6) { Text("Gemini"); Icon(.cloud, size: 14) }
                }
                .font(.caption).foregroundStyle(Palette.text2)
                .padding(.horizontal, 14)
                .frame(width: w, height: 150, alignment: .bottom)
                .padding(.bottom, 8)
            }
        }
        .frame(height: 150)
        .background(Palette.raised, in: RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous).strokeBorder(Palette.stroke))
        .clipShape(RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous))
        .accessibilityElement()
        .accessibilityLabel(Text("Animation: names, an address and a phone number pass through the airlock and come out as protected placeholders."))
    }

    private var gate: some View {
        ZStack {
            HStack(spacing: 48) {
                ForEach(0..<2, id: \.self) { _ in
                    LinearGradient(colors: [Palette.seal, Palette.seal.opacity(0)], startPoint: .top, endPoint: .bottom).frame(width: 2)
                }
            }
            AirlockLogo(size: 44, animated: true)
        }
        .frame(width: 64, height: 114)
    }

    @ViewBuilder
    private func token(_ lane: Lane, t: Double, width: CGFloat, y: CGFloat) -> some View {
        if reduceMotion {
            HStack {
                before(lane)
                Spacer()
                ChipView(label: lane.after, style: .protected(lane.category, lowConfidence: false))
            }
            .padding(.horizontal, 14)
            .frame(width: width)
            .position(x: width / 2, y: y)
        } else {
            let phase = ((t + lane.offset).truncatingRemainder(dividingBy: period)) / period
            let x = -140 + (width + 160) * phase
            let swapped = phase > 0.5
            let k = min(1, max(0, (phase - 0.46) / 0.06))
            ZStack(alignment: .leading) {
                before(lane).opacity(1 - k).blur(radius: 4 * k)
                ChipView(label: lane.after, style: .protected(lane.category, lowConfidence: false))
                    .opacity(swapped ? 1 : 0).scaleEffect(swapped ? 1 : 0.7, anchor: .leading)
            }
            .fixedSize()
            .position(x: x + 60, y: y)
        }
    }

    private func before(_ lane: Lane) -> some View {
        Text(verbatim: lane.before).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text)
            .padding(.horizontal, 10).padding(.vertical, 2)
            .background(Palette.reviewTint, in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Text field look (web `input.field`).
struct AirlockFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .background(Palette.raised, in: RoundedRectangle(cornerRadius: Metrics.controlRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Metrics.controlRadius, style: .continuous).strokeBorder(Palette.stroke))
            .foregroundStyle(Palette.text)
    }
}

#Preview("Onboarding") {
    OnboardingView(session: PreviewSession.make())
}

#Preview("Hero") {
    HeroAnimation().padding().background(Palette.bg)
}
