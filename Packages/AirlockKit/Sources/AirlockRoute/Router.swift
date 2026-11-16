import AirlockCore
import AirlockPrompts

/// What the user asked for (intent chips + free question).
public enum TaskKind: Sendable, Hashable {
    case help, explain, questions, summary, actions
    case reply(tone: String)
    case rewrite(tone: String)
    /// A free-text question — itself sealed through the pipeline first.
    case custom

    public var promptID: String {
        switch self {
        case .help: "task.help.v1"
        case .explain: "task.explain.v1"
        case .questions: "task.questions.v1"
        case .summary: "task.summary.v1"
        case .actions: "task.actions.v1"
        case .reply: "task.reply.v1"
        case .rewrite: "task.rewrite.v1"
        case .custom: "task.custom.v1"
        }
    }

    /// Quick tasks run phone-first (free, instant); deep ones cloud-first (`02-ARCHITECTURE.md` §5).
    public var isQuick: Bool {
        switch self {
        case .summary, .actions, .rewrite, .explain: true
        case .help, .questions, .reply, .custom: false
        }
    }

    /// The answer is written as the user (signature restores `[[PERSON_ME]]` to their first name).
    public var writesAsUser: Bool {
        switch self {
        case .reply, .rewrite: true
        default: false
        }
    }
}

/// Settings → Answers.
public enum AnswerPreference: String, Sendable, Hashable, Codable {
    /// The route table.
    case auto
    /// Never call the cloud; deep answers become phone answers.
    case phoneOnly
    /// Deep tasks use `model_cloud_max`.
    case best
}

/// The routing table (`docs/02-ARCHITECTURE.md` §5).
///
/// Guarantees: `.phoneOnly` preference always yields `.phoneOnly`; text too long for the
/// on-device window never goes to a phone-first route (it would fail on device anyway).
public enum Router {
    /// Sealed text + legend above this (UTF-16) exceeds the on-device window with room for instructions and output.
    public static let onDeviceLimit = 7_000

    public static func route(for task: TaskKind, sealed: SealedText, preference: AnswerPreference) -> (route: Route, quality: AnswerQuality)
    {
        if preference == .phoneOnly { return (.phoneOnly, .auto) }
        let size = sealed.value.utf16.count + sealed.renderedLegend.utf16.count
        let quality: AnswerQuality = preference == .best && !task.isQuick ? .best : .auto
        if size > onDeviceLimit { return (.cloudOnly, quality) }
        return (task.isQuick ? .phoneFirst : .cloudFirst, quality)
    }
}

/// Renders `task.*.v1` into a `TaskSpec`.
public struct TaskCatalog: Sendable {
    public let prompts: PromptLibrary

    public init(prompts: PromptLibrary) {
        self.prompts = prompts
    }

    /// `question` is required for `.custom` and must be sealed (it's the user's own words).
    public func spec(_ task: TaskKind, question: SealedText? = nil) throws(PromptError) -> TaskSpec {
        let instruction: String
        switch task {
        case .reply(let tone), .rewrite(let tone): instruction = try prompts.render(task.promptID, ["tone": tone])
        case .custom: instruction = try prompts.render(task.promptID, ["user_question": question?.value ?? "Help me with this."])
        default: instruction = try prompts.render(task.promptID)
        }
        return TaskSpec(id: task.promptID, instruction: instruction, maxOutputTokens: task.isQuick ? 600 : 1_500)
    }
}
