import AirlockCore
import SwiftUI

/// "On this device · nothing sent · 0.6 s" / "Gemini · 3.8 Flash · 2.1 s" — from `modelVersion`.
struct RouteBadge: View {
    let summary: AnswerSummary?
    let status: AssistantTurn.Status

    var body: some View {
        HStack(spacing: 6) {
            content
        }
        .font(.footnote.weight(.semibold))
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .foregroundStyle(colors.fg)
        .background(colors.bg, in: Capsule())
        .accessibilityElement(children: .combine)
        .enter()
    }

    private var secs: String {
        guard let s = summary else { return "" }
        return (Double(s.latencyMs) / 1000).formatted(.number.precision(.fractionLength(1)))
    }

    @ViewBuilder private var content: some View {
        if status == .error && summary == nil {
            ScaledIcon(.alert, size: 14, relativeTo: .footnote)
            Text("Not answered")
        } else if let s = summary {
            if s.fellBackToPhone {
                ScaledIcon(.device, size: 14, relativeTo: .footnote)
                Text("On this device · cloud unavailable · \(secs) s")
            } else if s.ranOnDevice {
                ScaledIcon(.device, size: 14, relativeTo: .footnote)
                Text("On this device · nothing sent · \(secs) s")
            } else {
                ScaledIcon(.cloud, size: 14, relativeTo: .footnote)
                Text("Gemini · \(Pieces.prettyModel(s.modelVersion)) · \(secs) s")
            }
        } else {
            PulseDot(color: Palette.cloud, size: 7)
            Text("Sealed request sent · answering…")
        }
    }

    private var colors: (fg: Color, bg: Color) {
        if status == .error && summary == nil { return (Palette.risk, Palette.riskTint) }
        guard let s = summary else { return (Palette.cloud, Palette.cloudTint) }
        if s.fellBackToPhone { return (Palette.review, Palette.reviewTint) }
        if s.ranOnDevice { return (Palette.seal, Palette.sealTint) }
        return (Palette.cloud, Palette.cloudTint)
    }
}

/// Apple's on-device model state, demo mode and storage warnings (web `OnDeviceStatus`).
struct OnDeviceStatus: View {
    let session: AirlockSession

    var body: some View {
        VStack(spacing: 10) {
            switch session.services.mode {
            case .demo(let noFirebase):
                if noFirebase {
                    Banner(
                        tone: .warn, title: String(localized: "Firebase isn't configured · demo mode"),
                        message: String(localized: "This build has no Firebase config, so answers are scripted and nothing is sent. See the README to add your config."))
                } else {
                    Banner(
                        tone: .warn, title: String(localized: "Demo mode · scripted answers"),
                        message: String(localized: "No real AI calls are made. Launch without “-demo” to use Apple's on-device model and Gemini."))
                }
            case .live:
                availabilityBanner
            }
            if !session.services.persistent {
                Banner(
                    tone: .warn, title: String(localized: "Saving is off on this build"),
                    message: String(localized: "The Keychain isn't available to this build, so your Vault and conversations are kept only until you quit."))
            }
        }
    }

    @ViewBuilder private var availabilityBanner: some View {
        switch session.availability {
        case nil:
            Banner(tone: .info, title: String(localized: "Checking for Apple's on-device model…"))
        case .available?:
            Banner(
                tone: .ok, title: String(localized: "On-device AI is ready"),
                message: String(localized: "Apple's model reads your text on this device before anything is sent."))
        case .appleIntelligenceNotEnabled?:
            Banner(
                tone: .warn, title: String(localized: "Turn on Apple Intelligence"),
                message: String(
                    localized: "Airlock still works: it seals with strict rules and asks you to check everything. Turn on Apple Intelligence in Settings for the full experience."))
        case .modelNotReady?:
            Banner(
                tone: .warn, title: String(localized: "Apple's model is still getting ready"),
                message: String(localized: "It downloads in the background. Until then Airlock uses strict rules and asks you to check everything."))
        default:
            Banner(
                tone: .warn, title: String(localized: "This device can't run Apple's on-device model"),
                message: String(localized: "Airlock still works: it seals with strict rules and asks you to review everything before anything is sent."))
        }
    }
}

/// Seal & send: the airlock doors shut over the screen, a ring pulses, the mark appears.
struct SealDoorOverlay: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shut = false
    @State private var ring = false
    @State private var glyph = false

    var body: some View {
        GeometryReader { geo in
            ZStack {
                HStack(spacing: 0) {
                    panel.overlay(alignment: .trailing) { Rectangle().fill(Palette.seal).frame(width: 2) }
                        .offset(x: shut || reduceMotion ? 0 : -geo.size.width / 2)
                    panel.overlay(alignment: .leading) { Rectangle().fill(Palette.seal).frame(width: 2) }
                        .offset(x: shut || reduceMotion ? 0 : geo.size.width / 2)
                }
                Circle().strokeBorder(Palette.seal, lineWidth: 2).frame(width: 120, height: 120)
                    .scaleEffect(ring ? 2.4 : 0.6).opacity(ring ? 0 : (shut ? 0.9 : 0))
                VStack(spacing: 12) {
                    AirlockLogo(size: 84, animated: true)
                    Text("Sealed · leaving your device").font(.headline).foregroundStyle(Palette.seal)
                }
                .opacity(glyph || reduceMotion ? 1 : 0)
                .scaleEffect(glyph || reduceMotion ? 1 : 0.85)
            }
        }
        .ignoresSafeArea()
        .opacity(reduceMotion && !shut ? 0 : 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Sealed · leaving your device"))
        .onAppear {
            if reduceMotion {
                withAnimation(.easeOut(duration: 0.15)) { shut = true }
                return
            }
            withAnimation(Motion.easeIn(0.38)) { shut = true }
            withAnimation(Motion.easeOut(0.7).delay(0.36)) { ring = true }
            withAnimation(Motion.pop(0.5).delay(0.3)) { glyph = true }
        }
    }

    private var panel: some View {
        Rectangle().fill(Palette.bg).overlay(Palette.seal.opacity(0.04))
    }
}

#Preview("Route badges") {
    VStack(spacing: 12) {
        RouteBadge(summary: nil, status: .streaming)
        RouteBadge(summary: nil, status: .error)
    }
    .padding()
    .background(Palette.bg)
}

#Preview("Seal door") { SealDoorOverlay() }
