import AirlockCore
import AirlockDetect
import Foundation

/// Preview fixtures: an in-memory session on demo engines with fictional data only.
@MainActor
enum PreviewSession {
    enum Scenario { case empty, seeded, review, thread, ledger, guess, scrub }

    static let vault = [
        VaultEntry(id: "v-me", canonical: "Maya Chen", aliases: ["Maya"], category: .person, roleHint: "me", isUser: true),
        VaultEntry(id: "v-raj", canonical: "Raj Patel", aliases: ["Raj"], category: .person, roleHint: "my landlord"),
    ]

    static func make(scenario: Scenario = .empty) -> AirlockSession {
        let defaults = UserDefaults(suiteName: "airlock.preview.\(UUID().uuidString)") ?? .standard
        let session = AirlockSession(services: .preview(), defaults: defaults)
        session.setPrefs { $0.onboarded = scenario != .empty }
        Task {
            await session.load()
            guard scenario != .empty else { return }
            await session.saveVault(vault)
            switch scenario {
            case .review: await session.startReview(AirlockSession.sample, task: .reply)
            case .thread, .ledger:
                await session.startReview(AirlockSession.sample, task: .reply)
                await session.send()
                await session.startReview("Raj says he can only come next Tuesday. Is that reasonable?", task: .help, threadID: session.threads.first?.id)
                await session.send()
                if scenario == .ledger { await session.verifyChain() }
            case .guess:
                await session.startReview(AirlockSession.sample, task: .reply)
                await session.send()
                if let id = session.threads.first?.id { await session.inferGuesses(id) }
            case .scrub:
                await session.startReview(AirlockSession.sample, task: .reply)
                await session.copySealedVersion()
                if let id = session.threads.first?.id { await session.restorePasted(id, text: AirlockSession.samplePasted) }
            default: break
            }
        }
        return session
    }
}
