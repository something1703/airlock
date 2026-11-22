import SwiftUI
import UniformTypeIdentifiers

/// Compose: paste anything, pick what you want, seal it on this device.
struct AskView: View {
    let session: AirlockSession
    @State private var text = ""
    @State private var task: TaskOption = .help
    @FocusState private var focused: Bool
    @State private var dropTargeted = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScreenScroll {
            ScreenHeader(title: String(localized: "Ask"), subtitle: String(localized: "Paste anything. Your device reads it first and seals what identifies you."))
            OnDeviceStatus(session: session)
            ComposeBox(
                text: $text, placeholder: String(localized: "Paste a tense text thread, a lease clause, a strange message…"),
                accessibilityTitle: String(localized: "Your message"), minHeight: 200
            )
            .focused($focused)
            .overlay {
                if dropTargeted {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(Palette.seal, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                        .background(Palette.sealTint.opacity(0.35), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay {
                            Text("Drop text to read it on this device").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.seal)
                        }
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
            }
            .animation(Motion.animation(Motion.easeOut(Motion.fast), reduce: reduceMotion), value: dropTargeted)
            .dropDestination(for: DroppedText.self) { items, _ in
                let dropped = items.map(\.text).filter { !$0.isEmpty }.joined(separator: "\n\n")
                guard !dropped.isEmpty else { return false }
                text = text.isEmpty ? dropped : text + "\n\n" + dropped
                return true
            } isTargeted: { dropTargeted = $0 }
            .accessibilityHint(Text("You can also drop text or a .txt file here"))
            .enter(1)
            TaskPills(selection: $task)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { sealButton; sampleButton }
                VStack(alignment: .leading, spacing: 10) { sealButton; sampleButton }
            }
            recent.enter(2)
        }
        .navigationTitle(Text("Ask"))
        .hidesNavigationBarOnPhone()
        .onChange(of: session.sealRequest) { _, _ in
            if session.section == .ask && session.askPath.isEmpty { seal() }
        }
    }

    private func seal() {
        let t = text
        guard !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        focused = false
        Task { await session.submit(t, task: task) }
    }

    private var sealButton: some View {
        Button {
            seal()
        } label: {
            IconLabel(
                title: session.staysOnDevice(task, text) ? "Answer on this device" : "Seal on this device", glyph: .arrow, trailing: true)
        }
        .buttonStyle(.primary)
        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .touchKeyboardShortcut(.return, modifiers: .command)
        .accessibilityHint(Text("Finds and seals private details on this device. Nothing is sent yet."))
    }

    private var sampleButton: some View {
        Button {
            text = AirlockSession.sample
        } label: {
            IconLabel(title: "Try a sample (fictional)", glyph: .sparkle)
        }
        .buttonStyle(.ghost)
    }

    @ViewBuilder private var recent: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Recent").font(.headline).foregroundStyle(Palette.text).padding(.bottom, 6).accessibilityAddTraits(.isHeader)
            if session.threads.isEmpty {
                EmptyState(glyph: .ask, title: String(localized: "Your sealed conversations will appear here."))
            } else {
                ForEach(session.threads) { t in
                    ThreadRow(thread: t) { session.openThread(t.id) }
                    if t.id != session.threads.last?.id { Divider().overlay(Palette.stroke) }
                }
            }
        }
        .card()
    }
}

/// A recent conversation row: title + where the last answer came from.
struct ThreadRow: View {
    let thread: ChatThread
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                Text(verbatim: thread.title).font(.body).foregroundStyle(Palette.text).lineLimit(2).multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                HStack(spacing: 4) {
                    if thread.mode == .scrub {
                        Icon(.copy, size: 14)
                        Text("copied, not sent")
                    } else if thread.lastAnswer?.summary?.ranOnDevice == true {
                        Icon(.device, size: 14)
                        Text("on device")
                    } else {
                        Icon(.cloud, size: 14)
                        Text("Gemini")
                    }
                }
                .font(.footnote).foregroundStyle(Palette.text2)
                Icon(.chevron, size: 14).foregroundStyle(Palette.text2)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: thread.title))
        .accessibilityHint(Text("Opens the conversation"))
    }
}

/// Text dragged onto the compose area: a text selection or a plain-text file (.txt), read locally.
/// Anything larger than 200 000 characters is cut (the egress gate's size check would block it anyway).
struct DroppedText: Transferable {
    let text: String

    static let maxCharacters = 200_000

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(importedContentType: .plainText) { data in
            DroppedText(text: String(String(decoding: data, as: UTF8.self).prefix(maxCharacters)))
        }
        ProxyRepresentation(importing: { (s: String) in DroppedText(text: String(s.prefix(maxCharacters))) })
    }
}

/// Multi-line compose field with placeholder (web `textarea.compose`).
struct ComposeBox: View {
    @Binding var text: String
    let placeholder: String
    let accessibilityTitle: String
    var minHeight: CGFloat = 120

    var body: some View {
        TextEditor(text: $text)
            .font(.body)
            .foregroundStyle(Palette.text)
            .scrollContentBackground(.hidden)
            .padding(12)
            .frame(minHeight: minHeight)
            .background(alignment: .topLeading) {
                if text.isEmpty {
                    Text(placeholder).font(.body).foregroundStyle(Palette.text2.opacity(0.8)).padding(.horizontal, 17).padding(.vertical, 20)
                        .accessibilityHidden(true)
                }
            }
            .background(Palette.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.stroke))
            .accessibilityLabel(Text(accessibilityTitle))
    }
}

/// Intent pills (single choice).
struct TaskPills: View {
    @Binding var selection: TaskOption

    var body: some View {
        FlowLayout {
            ForEach(TaskOption.allCases, id: \.self) { t in
                PillButton(title: t.title, selected: selection == t) { selection = t }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("What do you want?"))
    }
}

/// Empty state: icon + line (+ optional detail).
struct EmptyState: View {
    let glyph: Glyph
    let title: String
    var detail: String?

    var body: some View {
        VStack(spacing: 8) {
            Icon(glyph, size: 36).foregroundStyle(Palette.seal.opacity(0.8))
            Text(title).font(.callout).foregroundStyle(Palette.text2)
            if let detail { Text(detail).font(.footnote).foregroundStyle(Palette.text2) }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
        .accessibilityElement(children: .combine)
    }
}

#Preview("Ask") {
    NavigationStack { AskView(session: PreviewSession.make()) }
}

#Preview("Ask with recent") {
    NavigationStack { AskView(session: PreviewSession.make(scenario: .thread)) }
}
