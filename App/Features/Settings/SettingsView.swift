import AirlockCore
import AirlockRoute
import SwiftUI

/// Dial, where answers come from, honest limits, delete everything.
struct SettingsView: View {
    let session: AirlockSession
    @State private var confirm = false
    @State private var showDiagram = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollViewReader { proxy in
            screen
                .onAppear {
                    guard session.showAbout else { return }
                    showDiagram = true
                    Task {
                        try? await Task.sleep(for: .milliseconds(200))
                        proxy.scrollTo("about", anchor: .top)
                    }
                }
        }
    }

    private var screen: some View {
        ScreenScroll {
            ScreenHeader(title: String(localized: "Settings"))
            OnDeviceStatus(session: session)
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Privacy dial").font(.headline).foregroundStyle(Palette.text)
                    Segmented(
                        options: DialPreset.ordered.map { .init(value: $0, title: $0.title) },
                        selection: Binding(get: { session.prefs.dial }, set: { d in session.setPrefs { $0.dial = d } }),
                        accessibilityTitle: String(localized: "Privacy dial"))
                    Text(session.prefs.dial.line).font(.footnote).foregroundStyle(Palette.text2)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Where answers come from").font(.headline).foregroundStyle(Palette.text)
                    Segmented(
                        options: [AnswerPreference.auto, .phoneOnly, .best].map { .init(value: $0, title: $0.title) },
                        selection: Binding(get: { session.prefs.preference }, set: { p in session.setPrefs { $0.preference = p } }),
                        accessibilityTitle: String(localized: "Answer preference"))
                    Text(preferenceLine).font(.footnote).foregroundStyle(Palette.text2)
                }
            }
            .card()
            .enter()
            about.id("about").enter(1)
            VStack(alignment: .leading, spacing: 8) {
                Text("What Airlock does and doesn't do").font(.headline).foregroundStyle(Palette.text)
                Text(
                    "Airlock hides who you are, not what happened. It finds names, places, contact details and IDs on your device and replaces them before anything is sent. Detection isn't perfect, so you always see exactly what leaves. Airlock helps you understand and prepare; it doesn't give legal, medical or financial advice."
                )
                .font(.footnote).foregroundStyle(Palette.text2)
                Text("Raw text you paste is kept encrypted on this device for \(session.services.config.int("raw_purge_days")) days, then deleted.")
                    .font(.footnote).foregroundStyle(Palette.text2)
                Text(verbatim: modeLine).font(.footnote).foregroundStyle(Palette.text2)
            }
            .card()
            .enter(2)
            VStack(alignment: .leading, spacing: 10) {
                Text("Delete everything").font(.headline).foregroundStyle(Palette.text)
                Text("Removes your Vault, conversations, receipts and the encryption key from this device.").font(.footnote).foregroundStyle(Palette.text2)
                if confirm {
                    HStack {
                        Button("Yes, delete everything") { Task { await session.deleteEverything() } }.buttonStyle(.danger)
                        Button("Cancel") { confirm = false }.buttonStyle(.ghost)
                    }
                } else {
                    Button("Delete everything…") { confirm = true }.buttonStyle(.danger)
                }
            }
            .card()
            .enter(3)
        }
        .navigationTitle(Text("Settings"))
        .hidesNavigationBarOnPhone()
    }

    /// "How Airlock works": a one-line summary that opens the 7-step diagram.
    private var about: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(Motion.animation(Motion.easeOut(Motion.med), reduce: reduceMotion)) { showDiagram.toggle() }
            } label: {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("How Airlock works").font(.headline).foregroundStyle(Palette.text)
                        Text("Seven steps, from your words to a receipt.").font(.footnote).foregroundStyle(Palette.text2)
                    }
                    Spacer(minLength: 8)
                    Icon(.chevron, size: 14).foregroundStyle(Palette.text2).rotationEffect(.degrees(showDiagram ? 90 : 0))
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("How Airlock works"))
            .accessibilityValue(Text(showDiagram ? "Expanded" : "Collapsed"))
            .accessibilityHint(Text("Shows the 7 steps from your words to a receipt"))
            .accessibilityAddTraits(.isHeader)
            if showDiagram {
                HowItWorksDiagram().transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .card()
    }

    private var preferenceLine: String {
        switch session.prefs.preference {
        case .auto: String(localized: "Quick tasks are answered on this device; harder ones go to Gemini, sealed.")
        case .phoneOnly: String(localized: "Nothing is ever sent. Answers may be shorter.")
        case .best: String(localized: "Harder tasks use Gemini's most capable model, sealed.")
        }
    }

    private var modeLine: String {
        switch session.services.mode {
        case .live: String(localized: "Mode: live (Firebase AI Logic: Apple's on-device model and Gemini).")
        case .demo(let noFirebase):
            noFirebase ? String(localized: "Mode: demo (no Firebase config on this build).") : String(localized: "Mode: demo (scripted answers).")
        }
    }
}

#Preview("Settings") {
    NavigationStack { SettingsView(session: PreviewSession.make()) }
}

#Preview("Settings · How Airlock works") {
    let session = PreviewSession.make()
    session.showAbout = true
    return NavigationStack { SettingsView(session: session) }
}
