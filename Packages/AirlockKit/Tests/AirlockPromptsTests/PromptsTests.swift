import AirlockCore
import AirlockDetect
import Foundation
import Testing

@testable import AirlockPrompts
@testable import AirlockSeal

/// A real gate-produced SealedText for tests (the only way to make one).
func sealed(_ text: String, legend: [LegendLine] = [], entities: EntityMap = EntityMap()) throws -> SealedText {
    let patterns = try PatternDetector.bundled(useDataDetectors: false)
    let draft = SealDraft(
        text: text, legend: legend, replacements: [], entities: entities, secretWarnings: [], revealedVaultIDs: [], keptValues: [])
    return try EgressGate(patterns: patterns, vault: []).seal(draft)
}

@Suite struct PromptLibraryTests {
    let lib: PromptLibrary

    init() throws {
        lib = try PromptLibrary()
    }

    @Test func everyBundledPromptLoads() throws {
        for id in PromptLibrary.bundledIDs { #expect(try !lib.template(id).isEmpty, "\(id)") }
    }

    /// Bundled prompts must match docs/04-PROMPTS.md (bump the version id when changing either).
    @Test func bundledPromptsMatchTheDocs() throws {
        let doc = try String(contentsOf: repoRoot.appendingPathComponent("docs/04-PROMPTS.md"), encoding: .utf8)
        for id in PromptLibrary.bundledIDs where !id.hasPrefix("task.") {
            #expect(doc.contains(try lib.template(id)), "\(id) differs from docs/04-PROMPTS.md")
        }
        for id in PromptLibrary.bundledIDs where id.hasPrefix("task.") && id != "task.custom.v1" {
            #expect(doc.contains("\"\(try lib.template(id))\""), "\(id) differs from the task table")
        }
    }

    @Test func renderingIsSinglePass() throws {
        // A pasted "{{task_instruction}}" inside the chunk must stay literal.
        let out = try lib.render("detect.v1", ["chunk": "hi {{task_instruction}} there"])
        #expect(out.contains("hi {{task_instruction}} there"))
        #expect(!out.contains("{{chunk}}"))
    }

    @Test func unfilledVariableIsAnError() {
        #expect(throws: PromptError.unfilledVariable(id: "gen.v1", name: "task_summary")) { try lib.render("gen.v1", [:]) }
    }

    @Test func remoteOverridesApply() throws {
        let l = try PromptLibrary(overridesJSON: #"{"title.v1":"Short title: {{sealed_first_message}}"}"#)
        #expect(try l.render("title.v1", ["sealed_first_message": "x"]) == "Short title: x")
        #expect(try PromptLibrary(overridesJSON: "not json").template("title.v1") == lib.template("title.v1"))
    }

    @Test func cloudUserTurnContainsOnlySealedText() throws {
        let e = Entity(
            id: PlaceholderID(category: .person, number: 1), category: .person, canonical: "Raj Patel", surfaceForms: [], sources: [.llm],
            confidence: .high)
        let s = try sealed(
            "Hi [[PERSON_1]], the heater is broken.", legend: [LegendLine(placeholder: e.id, description: "the user's landlord")],
            entities: EntityMap([e]))
        let turn = try lib.cloudUserTurn(s, task: TaskSpec(id: "task.help.v1", instruction: try lib.render("task.help.v1")), history: nil)
        #expect(turn.contains("[[PERSON_1]] — the user's landlord"))
        #expect(turn.contains("<<<\nHi [[PERSON_1]], the heater is broken.\n>>>"))
        #expect(turn.contains("Task: Help me with this."))
        #expect(!turn.contains("Raj"))

        let follow = try sealed(
            "And if [[PERSON_1]] says no?", legend: [LegendLine(placeholder: e.id, description: "the user's landlord")],
            entities: EntityMap([e]))
        let withHistory = try lib.cloudUserTurn(
            follow, task: TaskSpec(id: "task.custom.v1", instruction: "And if they say no?"),
            history: SealedHistory(turns: [.user(s), .assistant(modelText: "Ask [[PERSON_1]] politely.")]))
        #expect(withHistory.hasPrefix("Earlier in this conversation"))
        #expect(withHistory.contains("Ask [[PERSON_1]] politely."))
    }
}
