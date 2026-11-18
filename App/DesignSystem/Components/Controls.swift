import SwiftUI

// MARK: Card

/// A raised card: `bg.raised`, 1-pt stroke, radius 20, one soft shadow in light mode only.
struct CardModifier: ViewModifier {
    var padding: CGFloat = 20
    var tint: Color? = nil
    var border: Color? = nil
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint ?? Palette.raised, in: RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous).strokeBorder(border ?? Palette.stroke, lineWidth: 1))
            .shadow(color: scheme == .dark ? .clear : Palette.shadow.opacity(0.06), radius: 4, y: 2)
    }
}

extension View {
    func card(padding: CGFloat = 20, tint: Color? = nil, border: Color? = nil) -> some View {
        modifier(CardModifier(padding: padding, tint: tint, border: border))
    }

    /// Top-level screens draw their own large header; hide the bar's title on iPhone.
    func hidesNavigationBarOnPhone() -> some View { modifier(HidesBarOnPhone()) }

    /// Entrance: fade + rise 10 pt, staggered by `index` × 60 ms (web `.enter`).
    func enter(_ index: Int = 0) -> some View { modifier(EnterModifier(index: index)) }

    /// A keyboard shortcut on the button itself on iPhone and iPad. On the Mac the menu bar command
    /// (`AirlockCommands`) owns the shortcut, so the two never compete.
    @ViewBuilder
    func touchKeyboardShortcut(_ key: KeyEquivalent, modifiers: EventModifiers = .command) -> some View {
        #if os(macOS)
            self
        #else
            keyboardShortcut(key, modifiers: modifiers)
        #endif
    }
}

struct HidesBarOnPhone: ViewModifier {
    #if os(iOS)
        @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    func body(content: Content) -> some View {
        #if os(iOS)
            content.toolbar(sizeClass == .compact ? .hidden : .automatic, for: .navigationBar)
        #else
            content
        #endif
    }
}

struct EnterModifier: ViewModifier {
    let index: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown || reduceMotion ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 10)
            .onAppear {
                guard !shown else { return }
                withAnimation(Motion.animation(Motion.easeOut().delay(Double(index) * 0.06), reduce: reduceMotion)) { shown = true }
            }
    }
}

// MARK: Buttons

enum AirlockButtonKind { case primary, secondary, ghost, danger }

/// Airlock buttons: 44-pt minimum, radius 12, press scales to 0.97 (web `.btn`).
struct AirlockButtonStyle: ButtonStyle {
    var kind: AirlockButtonKind = .secondary
    var compact = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.semibold) : .body.weight(.semibold))
            .lineLimit(2)
            .multilineTextAlignment(.center)
            .padding(.horizontal, compact ? 10 : 16)
            .padding(.vertical, compact ? 4 : 10)
            .frame(minHeight: compact ? 32 : 44)
            .foregroundStyle(foreground)
            .background(background, in: RoundedRectangle(cornerRadius: Metrics.controlRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Metrics.controlRadius, style: .continuous).strokeBorder(border, lineWidth: 1))
            .opacity(isEnabled ? 1 : 0.5)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(Motion.animation(Motion.easeOut(Motion.fast), reduce: reduceMotion), value: configuration.isPressed)
            .contentShape(RoundedRectangle(cornerRadius: Metrics.controlRadius))
    }

    private var foreground: Color {
        switch kind {
        case .primary: Palette.onSeal
        case .secondary: Palette.text
        case .ghost: Palette.text2
        case .danger: Palette.risk
        }
    }
    private var background: Color {
        switch kind {
        case .primary: Palette.seal
        case .secondary, .danger: Palette.raised
        case .ghost: .clear
        }
    }
    private var border: Color {
        switch kind {
        case .primary: Palette.seal
        case .secondary, .danger: Palette.stroke
        case .ghost: .clear
        }
    }
}

extension ButtonStyle where Self == AirlockButtonStyle {
    static var primary: AirlockButtonStyle { AirlockButtonStyle(kind: .primary) }
    static var secondary: AirlockButtonStyle { AirlockButtonStyle(kind: .secondary) }
    static var ghost: AirlockButtonStyle { AirlockButtonStyle(kind: .ghost) }
    static var danger: AirlockButtonStyle { AirlockButtonStyle(kind: .danger) }
}

/// Label with a leading or trailing icon.
struct IconLabel: View {
    let title: LocalizedStringKey
    let glyph: Glyph
    var trailing = false

    var body: some View {
        HStack(spacing: 8) {
            if !trailing { ScaledIcon(glyph, size: 16) }
            Text(title)
            if trailing { ScaledIcon(glyph, size: 16) }
        }
    }
}

// MARK: Pills and segmented control

/// A selectable capsule (task intents). Selected = inverted (web `.pill[aria-pressed]`).
struct PillButton: View {
    let title: String
    let selected: Bool
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .frame(minHeight: 40)
                .foregroundStyle(selected ? Palette.bg : Palette.text)
                .background(selected ? Palette.text : Palette.raised, in: Capsule())
                .overlay(Capsule().strokeBorder(selected ? Palette.text : Palette.stroke, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .animation(Motion.animation(Motion.easeOut(Motion.med), reduce: reduceMotion), value: selected)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A row of options with one selected (web `.segmented`).
struct Segmented<Value: Hashable>: View {
    struct Option: Identifiable {
        let value: Value
        let title: String
        var glyph: Glyph?
        var id: Value { value }
    }

    let options: [Option]
    @Binding var selection: Value
    var accessibilityTitle: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var ns

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options) { o in
                let on = o.value == selection
                Button {
                    withAnimation(Motion.animation(Motion.spring, reduce: reduceMotion)) { selection = o.value }
                } label: {
                    HStack(spacing: 6) {
                        if let g = o.glyph { ScaledIcon(g, size: 14, relativeTo: .subheadline) }
                        Text(o.title).lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .font(.subheadline.weight(on ? .semibold : .regular))
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .foregroundStyle(on ? Palette.bg : Palette.text)
                    .background {
                        if on { RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.text).matchedGeometryEffect(id: "seg", in: ns) }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(o.title)
                .accessibilityAddTraits(on ? [.isSelected, .isButton] : .isButton)
            }
        }
        .padding(2)
        .overlay(RoundedRectangle(cornerRadius: Metrics.controlRadius, style: .continuous).strokeBorder(Palette.stroke, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityTitle)
    }
}

// MARK: Banner

enum BannerTone { case info, ok, warn, risk }

/// Status / warning banner (web `Banner`). Risk banners are announced.
struct Banner<Action: View>: View {
    let tone: BannerTone
    let title: String
    var message: String?
    @ViewBuilder var action: () -> Action

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ScaledIcon(glyph, size: 18).foregroundStyle(iconColor).padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text)
                if let message { Text(message).font(.footnote).foregroundStyle(Palette.text) }
                action()
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(tone == .risk ? .isHeader : [])
        .enter()
    }

    private var glyph: Glyph {
        switch tone {
        case .info: .sparkle
        case .ok: .shield
        case .warn, .risk: .alert
        }
    }
    private var iconColor: Color {
        switch tone {
        case .info: Palette.cloud
        case .ok: Palette.seal
        case .warn: Palette.review
        case .risk: Palette.risk
        }
    }
    private var background: Color {
        switch tone {
        case .info: Palette.cloudTint
        case .ok: Palette.sealTint
        case .warn: Palette.reviewTint
        case .risk: Palette.riskTint
        }
    }
}

extension Banner where Action == EmptyView {
    init(tone: BannerTone, title: String, message: String? = nil) {
        self.init(tone: tone, title: title, message: message) { EmptyView() }
    }
}

// MARK: Small pieces

/// A stand-alone chip (Vault rows, entity list, onboarding hero).
struct ChipView: View {
    let label: String
    let style: ChipStyle
    var iconOnly = false

    var body: some View {
        HStack(spacing: 4) {
            ScaledIcon(style.glyph, size: iconOnly ? 16 : 13, relativeTo: .callout)
            if !iconOnly { Text(label).font(.callout.weight(.semibold)).lineLimit(1) }
            if case .protected(_, true) = style {
                Circle().fill(Palette.review).frame(width: 6, height: 6)
            }
        }
        .foregroundStyle(style.tint)
        .padding(.horizontal, iconOnly ? 6 : 8)
        .padding(.vertical, iconOnly ? 6 : 2)
        .background {
            let shape = RoundedRectangle(cornerRadius: Metrics.chipRadius, style: .continuous)
            switch style {
            case .generalised: shape.strokeBorder(Palette.muted, style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
            case .secret: shape.fill(Palette.riskTint)
            default: shape.fill(style.tint.opacity(0.16))
            }
        }
    }
}

/// Three bouncing dots while waiting for the first words.
struct TypingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { i in
                    let phase = (t - Double(i) * 0.15).truncatingRemainder(dividingBy: 1.1) / 1.1
                    let up = phase < 0.4 ? sin(phase / 0.4 * .pi) : 0
                    Circle().fill(Palette.text2).frame(width: 7, height: 7)
                        .offset(y: reduceMotion ? 0 : -5 * up)
                        .opacity(reduceMotion ? 0.7 : 0.4 + 0.6 * up)
                }
            }
            .padding(.vertical, 6)
        }
        .accessibilityElement()
        .accessibilityLabel(Text("Waiting for the answer"))
    }
}

/// A pulsing dot (live states).
struct PulseDot: View {
    var color: Color = Palette.seal
    var size: CGFloat = 10
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false

    var body: some View {
        Circle().fill(color).frame(width: size, height: size)
            .scaleEffect(on ? 1 : 0.8).opacity(on ? 1 : 0.3)
            .onAppear {
                if reduceMotion { on = true } else { withAnimation(.easeInOut(duration: 0.5).repeatForever()) { on = true } }
            }
            .accessibilityHidden(true)
    }
}

/// Animated count from the previous value (ease-out cubic, 0.9 s; instant under Reduce Motion).
struct CountUpText: View {
    let value: Int
    var font: Font = .airlockDisplay
    var duration: Double = 0.9
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var from = 0
    @State private var startedAt = Date.distantPast

    var body: some View {
        TimelineView(.animation(paused: reduceMotion || Date().timeIntervalSince(startedAt) > duration + 0.1)) { tl in
            let k = Motion.easeOutCubic(tl.date.timeIntervalSince(startedAt) / duration)
            Text(verbatim: "\(reduceMotion ? value : Int((Double(from) + Double(value - from) * k).rounded()))")
                .font(font)
                .monospacedDigit()
        }
        .onAppear { startedAt = Date() }
        .onChange(of: value) { old, _ in
            from = old
            startedAt = Date()
        }
        .accessibilityLabel(Text(verbatim: "\(value)"))
    }
}

/// Strength meter: `level` of 3 bars lit (dial cards).
struct StrengthMeter: View {
    let level: Int
    var on: Bool

    var body: some View {
        HStack(spacing: 3) {
            ForEach(1...3, id: \.self) { n in
                RoundedRectangle(cornerRadius: 3).fill(on && n <= level ? Palette.seal : Palette.stroke).frame(width: 6, height: 18)
            }
        }
        .accessibilityHidden(true)
    }
}

/// Screen title + subtitle.
struct ScreenHeader: View {
    let title: String
    var subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.airlockTitle).foregroundStyle(Palette.text).accessibilityAddTraits(.isHeader)
            if let subtitle { Text(subtitle).font(.callout).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Scrollable screen container: background, readable width, gutters.
struct ScreenScroll<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) { content() }
                .frame(maxWidth: Metrics.readableWidth, alignment: .leading)
                .padding(.horizontal, Metrics.gutter)
                .padding(.vertical, 20)
                .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.bg.ignoresSafeArea())
    }
}

#Preview("Controls") {
    ScreenScroll {
        ScreenHeader(title: "Ask", subtitle: "Paste anything. Your device reads it first.")
        HStack {
            Button("Seal & send") {}.buttonStyle(.primary)
            Button("Cancel") {}.buttonStyle(.ghost)
            Button("Delete") {}.buttonStyle(.danger)
        }
        HStack {
            PillButton(title: "Draft a reply", selected: true) {}
            PillButton(title: "Summarise", selected: false) {}
        }
        Banner(tone: .ok, title: "On-device AI is ready", message: "Apple's model reads your text on this device.")
        Banner(tone: .risk, title: "Airlock stopped this before it left")
        HStack {
            ChipView(label: "Person 1 · landlord", style: .protected(.person, lowConfidence: false))
            ChipView(label: "a large hospital", style: .generalised)
            ChipView(label: "", style: .secret, iconOnly: true)
        }
        HStack(spacing: 20) {
            TypingIndicator()
            PulseDot()
            CountUpText(value: 42)
            StrengthMeter(level: 2, on: true)
        }
        .card()
    }
}
