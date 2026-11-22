import AirlockCore
import AirlockDetect
import AirlockLedger
import AirlockRestore
import AirlockRoute
import AirlockSeal
import Foundation

/// Top-level sections (iPhone tabs, Mac/iPad sidebar).
enum AppSection: String, CaseIterable, Hashable, Sendable {
    case ask, ledger, vault, settings

    var title: String {
        switch self {
        case .ask: String(localized: "Ask")
        case .ledger: String(localized: "Ledger")
        case .vault: String(localized: "Vault")
        case .settings: String(localized: "Settings")
        }
    }

    var glyph: Glyph {
        switch self {
        case .ask: .ask
        case .ledger: .ledger
        case .vault: .vault
        case .settings: .settings
        }
    }
}

/// Screens pushed on the Ask stack.
enum AskRoute: Hashable, Sendable {
    case review
    case thread(String)
}

/// Sidebar rows on Mac / iPad.
enum SidebarItem: Hashable, Sendable {
    case section(AppSection)
    case thread(String)
}

/// The intent pills (web `TASKS`). Stored with each conversation.
enum TaskOption: String, Codable, CaseIterable, Sendable, Hashable {
    case help, reply, explain, summary, questions, actions

    var kind: TaskKind {
        switch self {
        case .help: .help
        case .reply: .reply(tone: "firm but polite")
        case .explain: .explain
        case .summary: .summary
        case .questions: .questions
        case .actions: .actions
        }
    }

    var title: String {
        switch self {
        case .help: String(localized: "Help me with this")
        case .reply: String(localized: "Draft a reply")
        case .explain: String(localized: "Explain simply")
        case .summary: String(localized: "Summarise")
        case .questions: String(localized: "Questions to ask")
        case .actions: String(localized: "List actions")
        }
    }
}

/// Saved preferences (not sensitive; UserDefaults).
struct Prefs: Codable, Equatable, Sendable {
    var dial: DialPreset = .balanced
    var preference: AnswerPreference = .auto
    var onboarded = false
}

/// Why an answer failed, as a stable code (never content; INV-8). Wording is localised.
enum AnswerFailure: String, Codable, Sendable {
    case offline, busy, armorBlocked, cloudBlocked, appCheck, unavailable, noCloud, other

    init(_ error: any Error) {
        guard let e = error as? EngineError else {
            self = .other
            return
        }
        switch e {
        case .offline: self = .offline
        case .quota, .serviceUnavailable, .busy: self = .busy
        case .armorBlocked: self = .armorBlocked
        case .cloudBlocked, .refused: self = .cloudBlocked
        case .appCheck: self = .appCheck
        case .unavailable: self = .unavailable
        case .other(let code) where code == "no-firebase": self = .noCloud
        default: self = .other
        }
    }

    var message: String {
        switch self {
        case .offline: String(localized: "You're offline. Quick tasks still work on this device; Gemini needs a connection.")
        case .busy: String(localized: "Gemini is busy right now. Try again in a moment, or answer on this device instead.")
        case .armorBlocked:
            String(
                localized: "Google's safety check stopped this request. Something identifying may have slipped past Airlock. Nothing was answered.")
        case .cloudBlocked: String(localized: "The model declined to answer this request.")
        case .appCheck: String(localized: "This app couldn't prove it's genuine to Firebase (App Check). Please try again later.")
        case .unavailable: String(localized: "Apple's on-device model isn't available on this device right now.")
        case .noCloud: String(localized: "Firebase isn't set up on this build, so Gemini can't be reached. Nothing was sent.")
        case .other: String(localized: "Something went wrong. Nothing private was sent.")
        }
    }
}

/// What the answer screen needs about a finished answer (live or reloaded).
struct AnswerSummary: Sendable {
    let modelText: String
    let route: Route
    let modelVersion: String
    let ranOnDevice: Bool
    let fellBackToPhone: Bool
    let latencyMs: Int
    let receipt: Receipt?
    let fidelity: FidelityReport

    init(_ o: AnswerOutcome) {
        modelText = o.modelText
        route = o.route
        modelVersion = o.modelVersion
        ranOnDevice = o.ranOnDevice
        fellBackToPhone = o.fellBackToPhone
        latencyMs = Int(o.latency.components.seconds * 1000 + o.latency.components.attoseconds / 1_000_000_000_000_000)
        receipt = o.receipt
        fidelity = o.fidelity
    }

    init(stored: StoredOutcome, modelText: String, receipt: Receipt?, fidelity: FidelityReport) {
        self.modelText = modelText
        route = stored.route
        modelVersion = stored.modelVersion
        ranOnDevice = stored.ranOnDevice
        fellBackToPhone = stored.fellBackToPhone
        latencyMs = stored.latencyMs
        self.receipt = receipt
        self.fidelity = fidelity
    }
}

/// A user turn: what they wrote (local only) and the sealed text that left.
struct UserTurn: Identifiable, Sendable {
    let id = UUID()
    /// Shown locally only ("Show what I wrote").
    let raw: String
    /// The sealed text as it left (for display).
    let display: String
    /// Gate-checked sealed text for follow-up history; nil if a reloaded turn no longer passes the gate.
    let sealed: SealedText?
    let stored: StoredSealed
    /// FX-02: answered on the device from this raw text. There is no sealed version (`sealed` is nil) and nothing was sent.
    var local = false
}

/// An assistant turn, streaming or finished.
struct AssistantTurn: Identifiable, Sendable {
    enum Status: String, Codable, Sendable { case streaming, done, error }
    let id = UUID()
    var task: TaskOption
    var status: Status
    var segments: [RestoredSegment]
    var summary: AnswerSummary?
    var failure: AnswerFailure?
    /// Restored names animate in (false for reloaded answers).
    var animate: Bool
    /// F-27: the placeholder text the user pasted back (an answer they got elsewhere), before restore.
    var pasted: String?
    /// FX-02: written by the on-device model from the raw message, so it may hold real names; never sent or backed up.
    var local = false
}

enum Turn: Identifiable, Sendable {
    case user(UserTurn)
    case assistant(AssistantTurn)

    var id: UUID {
        switch self {
        case .user(let u): u.id
        case .assistant(let a): a.id
        }
    }
}

/// How a conversation started.
enum ThreadMode: String, Codable, Sendable {
    /// F-27 Scrub & copy: the user copied the sealed text to use elsewhere; Airlock sent nothing.
    /// Answers are pasted back and restored on this device.
    case scrub
}

/// One conversation. The entity map stays on device (INV-6).
struct ChatThread: Identifiable, Sendable {
    let id: String
    var title: String
    /// nil for an ordinary Seal & send conversation.
    var mode: ThreadMode?
    var task: TaskOption
    var entities: EntityMap
    var turns: [Turn]
    let createdAt: Date

    var isStreaming: Bool {
        turns.contains { if case .assistant(let a) = $0 { a.status == .streaming } else { false } }
    }

    var lastAnswer: AssistantTurn? {
        for t in turns.reversed() { if case .assistant(let a) = t { return a } }
        return nil
    }
}

/// F-25 "What could Gemini still guess?" for one conversation (kept by the session so it
/// survives navigation; reset when the conversation gets a new turn).
struct GuessState: Sendable {
    enum Phase: Sendable {
        case asking
        case done(inferences: [Inference], unreadable: Bool, receiptID: String)
        case failed(AnswerFailure)
    }

    /// `turns.count` when the guess was asked.
    let turnCount: Int
    var phase: Phase
}

/// The Review screen's state.
struct ReviewState: Sendable {
    let id = UUID()
    let raw: String
    var task: TaskOption
    let threadID: String?
    var progress: SealProgress?
    /// FX-02: Vault and rule hits, known before the model starts (local only).
    var found: RulesPreview?
    var result: SealResult?
    var overrides: [PlaceholderID: UserOverride] = [:]
    var accepted: [Risk] = []
    var dismissed: Set<Int> = []
    /// Gate checks that blocked the last "Seal & send" (no values; INV-8).
    var blocked: [GateHit]?
    let startedAt: Date
}

extension GateCheck {
    /// Plain words for the blocked banner (web `GATE_CHECK_NAMES`).
    var blockedWords: String {
        switch self {
        case .g1VaultTerms: String(localized: "a name from your Vault")
        case .g2SurfaceForms: String(localized: "a detail Airlock sealed elsewhere in the text")
        case .g3Patterns: String(localized: "an email, phone number, ID or code")
        case .g4PlaceholdersWellFormed: String(localized: "a malformed placeholder")
        case .g5LegendClean: String(localized: "an explanation that reveals too much")
        case .g6Normalised: String(localized: "hidden or look-alike characters")
        case .g7Size: String(localized: "a message that's too long")
        }
    }
}

extension DialPreset {
    var title: String {
        switch self {
        case .strict: String(localized: "Strict")
        case .balanced: String(localized: "Balanced")
        case .open: String(localized: "Open")
        }
    }

    var line: String {
        switch self {
        case .strict: String(localized: "Hides more and always shows you what leaves. Best for very sensitive things.")
        case .balanced: String(localized: "Hides names, places and numbers; keeps dates and amounts so answers stay useful.")
        case .open: String(localized: "Hides names, contact details and IDs only.")
        }
    }

    var level: Int {
        switch self {
        case .strict: 3
        case .balanced: 2
        case .open: 1
        }
    }

    static let ordered: [DialPreset] = [.strict, .balanced, .open]
}

extension AnswerPreference {
    var title: String {
        switch self {
        case .auto: String(localized: "Automatic")
        case .phoneOnly: String(localized: "This device")
        case .best: String(localized: "Best (Gemini)")
        }
    }
}
