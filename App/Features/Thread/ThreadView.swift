import AirlockCore
import SwiftUI

#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif

/// A conversation: what Gemini saw, the restored answer, receipts, follow-ups.
struct ThreadView: View {
    let session: AirlockSession
    let threadID: String
    @State private var followUp = ""
    @State private var confirmDelete = false

    var body: some View {
        Group {
            if let thread = session.thread(threadID) {
                content(thread)
            } else {
                ScreenScroll {
                    EmptyState(glyph: .ask, title: String(localized: "This conversation was deleted."))
                    Button("Back to Ask") { session.go(.ask) }.buttonStyle(.secondary)
                }
            }
        }
        .navigationTitle(Text(verbatim: session.thread(threadID)?.title ?? ""))
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private func content(_ thread: ChatThread) -> some View {
        ScrollViewReader { proxy in
            ScreenScroll {
                HStack(alignment: .top) {
                    Text(verbatim: thread.title).font(.airlockTitle).foregroundStyle(Palette.text).accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    Button {
                        confirmDelete = true
                    } label: {
                        Icon(.trash, size: 18)
                    }
                    .buttonStyle(AirlockButtonStyle(kind: .danger, compact: true))
                    .accessibilityLabel(Text("Delete this conversation"))
                }
                if confirmDelete {
                    Banner(
                        tone: .risk, title: String(localized: "Delete this conversation from this device?"),
                        message: String(
                            localized:
                                "Your words, the answers and the real names for this conversation are removed. Its receipts stay in the Ledger so the chain can still be verified. They only ever held the sealed text."
                        )
                    ) {
                        HStack {
                            Button("Delete") { Task { await session.deleteThread(thread.id) } }.buttonStyle(.danger)
                            Button("Cancel") { confirmDelete = false }.buttonStyle(.ghost)
                        }
                        .padding(.top, 6)
                    }
                }
                ForEach(thread.turns) { turn in
                    switch turn {
                    case .user(let u): UserBubble(turn: u, entities: thread.entities)
                    case .assistant(let a):
                        AssistantBubble(turn: a, retry: { onDevice in Task { await session.retry(thread.id, onDeviceOnly: onDevice) } })
                    }
                }
                followUpBox(thread).id("followUp")
            }
            .onChange(of: thread.turns.count) { _, _ in
                withAnimation { proxy.scrollTo("followUp", anchor: .bottom) }
            }
        }
    }

    private func followUpBox(_ thread: ChatThread) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ComposeBox(
                text: $followUp, placeholder: String(localized: "Ask a follow-up. It gets sealed too."),
                accessibilityTitle: String(localized: "Follow-up question"), minHeight: 90)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { followUpButtons(thread) }
                VStack(alignment: .leading, spacing: 10) { followUpButtons(thread) }
            }
        }
        .card(padding: 16)
    }

    @ViewBuilder private func followUpButtons(_ thread: ChatThread) -> some View {
        Button("Continue") {
            let text = followUp
            followUp = ""
            Task { await session.startReview(text, task: .help, threadID: thread.id) }
        }
        .buttonStyle(.primary)
        .disabled(followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || thread.isStreaming)
        Text("Real names show underlined: Gemini wrote placeholders and your device filled them in.")
            .font(.footnote).foregroundStyle(Palette.text2)
    }
}

/// What the user sent: the sealed version by default, "Show what I wrote" locally.
struct UserBubble: View {
    let turn: UserTurn
    let entities: EntityMap
    @State private var showRaw = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Icon(showRaw ? .eye : .shield, size: 14)
                Text(showRaw ? "You wrote · never sent" : "What Gemini saw")
                Spacer(minLength: 8)
                Button(showRaw ? "Show sealed" : "Show what I wrote") { showRaw.toggle() }
                    .buttonStyle(AirlockButtonStyle(kind: .ghost, compact: true))
                    .accessibilityAddTraits(showRaw ? .isSelected : [])
            }
            .font(.footnote).foregroundStyle(Palette.text2)
            if showRaw {
                Text(verbatim: turn.raw).font(.body).foregroundStyle(Palette.text).lineSpacing(5).textSelection(.enabled)
            } else {
                InlineText(pieces: Pieces.sealed(turn.display, entities: entities))
            }
            if turn.sealed == nil {
                Text("This message no longer passes Airlock's check (your Vault changed), so it isn't sent again with follow-ups.")
                    .font(.footnote).foregroundStyle(Palette.review)
            }
        }
        .card(padding: 16)
        .padding(.leading, 40)
        .enter()
    }
}

/// The answer: route badge, restored text (names unseal as they arrive), receipt line.
struct AssistantBubble: View {
    let turn: AssistantTurn
    let retry: (_ onDeviceOnly: Bool) -> Void
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            RouteBadge(summary: turn.summary, status: turn.status)
            if turn.status == .error {
                Banner(tone: .risk, title: (turn.failure ?? .other).message) {
                    HStack {
                        Button("Try again") { retry(false) }.buttonStyle(AirlockButtonStyle(kind: .secondary, compact: true))
                        if turn.failure == .busy || turn.failure == .offline {
                            Button("Answer on this device") { retry(true) }.buttonStyle(AirlockButtonStyle(kind: .secondary, compact: true))
                        }
                    }
                    .padding(.top, 6)
                }
            } else if turn.segments.isEmpty {
                TypingIndicator()
            } else {
                InlineText(pieces: Pieces.restored(turn.segments), unsealNew: turn.animate)
                    .textSelection(.enabled)
            }
            if let s = turn.summary { receiptLine(s) }
        }
        .card(padding: 16)
        .padding(.trailing, 20)
        .enter()
        .accessibilityElement(children: .contain)
    }

    private func receiptLine(_ s: AnswerSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider().overlay(Palette.stroke)
            FlowLayout(spacing: 10, lineSpacing: 4) {
                if let r = s.receipt {
                    HStack(spacing: 4) { Icon(.ledger, size: 14); Text("Receipt \(r.id)") }
                    Text(verbatim: String(r.outboundSha256.prefix(12)) + "…").font(.airlockMono)
                    Text("\(r.outboundChars) characters sent")
                } else {
                    Text("Nothing left this device, so no receipt was needed.")
                }
                if !s.fidelity.guessedEntities.isEmpty { Text("Gemini wrote a real detail it guessed. Check the answer.").foregroundStyle(Palette.review) }
                if !s.fidelity.unknownIDs.isEmpty { Text("The answer mentioned a placeholder Airlock doesn't know.").foregroundStyle(Palette.review) }
                Button {
                    copy(Pieces.plain(turn.segments))
                    copied = true
                } label: {
                    HStack(spacing: 4) { Icon(.copy, size: 14); Text(copied ? "Copied" : "Copy answer") }
                }
                .buttonStyle(AirlockButtonStyle(kind: .ghost, compact: true))
                .accessibilityHint(Text("Copies the answer with the real names, on this device"))
            }
            .font(.footnote).foregroundStyle(Palette.text2)
        }
    }

    private func copy(_ text: String) {
        #if canImport(UIKit)
            UIPasteboard.general.string = text
        #elseif canImport(AppKit)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}

#Preview("Thread") {
    PreviewThreadHost(session: PreviewSession.make(scenario: .thread))
}

/// Shows the preview session's first conversation once the scripted send has run.
private struct PreviewThreadHost: View {
    let session: AirlockSession

    var body: some View {
        NavigationStack {
            if let id = session.threads.first?.id {
                ThreadView(session: session, threadID: id)
            } else {
                TypingIndicator()
            }
        }
    }
}
