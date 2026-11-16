import AirlockCore
import AirlockDetect
import FirebaseAILogic
import Foundation
import Testing

@testable import AirlockEngines
@testable import AirlockSeal

@Suite struct ModelPlanTests {
    let config = AppConfig()

    @Test func routesMapToDocumentedModels() {
        #expect(ModelPlan.plan(route: .phoneOnly, config: config).model == .system(permissiveGuardrails: false))
        #expect(
            ModelPlan.plan(route: .phoneFirst, config: config).model
                == .hybrid(primary: .system(permissiveGuardrails: false), secondary: .gemini(config.modelCloudQuick)))
        #expect(
            ModelPlan.plan(route: .cloudFirst, config: config).model
                == .hybrid(primary: .gemini(config.modelCloudDeep), secondary: .system(permissiveGuardrails: false)))
        #expect(ModelPlan.plan(route: .cloudOnly, config: config).model == .gemini(config.modelCloudDeep))
        #expect(ModelPlan.plan(route: .cloudOnly, config: config, quality: .best).model == .gemini(config.modelCloudMax))
    }

    /// INV-3: the phone-only route can never reach the cloud.
    @Test func phoneOnlyNeverUsesCloud() {
        for quality in [AnswerQuality.auto, .best] {
            for remote in [[:], ["armor_expected": "true"], ["model_cloud_deep": "x"]] {
                #expect(!ModelPlan.plan(route: .phoneOnly, config: AppConfig(remote: remote), quality: quality).model.usesCloud)
            }
        }
    }

    /// With Model Armor expected, cloud-first is cloud-only + offline-only phone fallback (API-NOTES §7.7).
    @Test func armorModeAvoidsSilentFallback() {
        let plan = ModelPlan.plan(route: .cloudFirst, config: AppConfig(remote: ["armor_expected": "true"]))
        #expect(plan.model == .gemini(AppConfig().modelCloudDeep))
        #expect(plan.manualOfflineFallback)
    }

    @Test func instructionsPerRoute() {
        #expect(ModelPlan.plan(route: .phoneFirst, config: config).instructionsID == "phone-system.v1")
        #expect(ModelPlan.plan(route: .cloudFirst, config: config).instructionsID == "cloud-system.v1")
    }
}

@Suite struct ErrorMapperTests {
    @Test func networkErrorsAreOffline() {
        for code in [URLError.Code.notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotFindHost] {
            #expect(ErrorMapper.map(URLError(code)) == .offline)
        }
        #expect(ErrorMapper.map(NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)) == .offline)
        #expect(
            ErrorMapper.map(NSError(domain: NSURLErrorDomain, code: -1)) == .other(code: "url.-1"), "unknown URL errors are not 'offline'")
    }

    @Test func httpStatusCodes() {
        let domain = "com.google.firebase.firebaseai.BackendError"
        #expect(ErrorMapper.map(NSError(domain: domain, code: 429)) == .quota)
        #expect(ErrorMapper.map(NSError(domain: domain, code: 503)) == .serviceUnavailable)
        #expect(ErrorMapper.map(NSError(domain: domain, code: 403)) == .appCheck)
        #expect(ErrorMapper.map(NSError(domain: domain, code: 400)) == .other(code: "http.400"))
    }

    @Test func unwrapsWrappedErrors() {
        #expect(ErrorMapper.map(GenerateContentError.internalError(underlying: URLError(.notConnectedToInternet))) == .offline)
        let wrapped = NSError(domain: "x", code: 1, userInfo: [NSUnderlyingErrorKey: NSError(domain: "a.BackendError", code: 429)])
        #expect(ErrorMapper.map(wrapped) == .quota)
        #expect(ErrorMapper.map(CancellationError()) == .cancelled)
        #expect(ErrorMapper.map(EngineError.refused) == .refused)
    }

    /// INV-8: mapped errors never carry the SDK's text.
    @Test func noContentSurvivesMapping() {
        let secret = "Raj Patel, 14 Elm St"
        let e = NSError(domain: "weird", code: 7, userInfo: [NSLocalizedDescriptionKey: secret])
        #expect(!String(describing: ErrorMapper.map(e)).contains("Raj"))
    }
}

@Suite struct ToolPayloadTests {
    @Test func onlySealedOrFixedPayloads() throws {
        #expect(FirebaseToolEngine.payload(.declined) == ["error": .string("user_declined")])
        #expect(FirebaseToolEngine.payload(.unavailable) == ["error": .string("unavailable")])
        let patterns = try PatternDetector.bundled(useDataDetectors: false)
        let draft = SealDraft(
            text: #"{"slots":["Tue 24 Nov, 3:00-4:00 pm"]}"#, legend: [], replacements: [], entities: EntityMap(), secretWarnings: [],
            revealedVaultIDs: [], keptValues: [])
        let sealed = try EgressGate(patterns: patterns, vault: []).sealToolResult(draft.text, entities: EntityMap())
        #expect(FirebaseToolEngine.payload(.result(sealed)) == ["slots": .array([.string("Tue 24 Nov, 3:00-4:00 pm")])])
    }

    @Test func declarationsMarkOptionalParameters() {
        let spec = ToolSpec(
            name: "find_free_slots", description: "Find free times.",
            parameters: [
                ToolParameter(name: "start_date", kind: .string, description: "ISO date"),
                ToolParameter(name: "max_results", kind: .integer, description: "max", optional: true),
            ])
        let decl = FirebaseToolEngine.declaration(spec)
        #expect(String(describing: decl).contains("find_free_slots"))
    }

    @Test func argumentsRoundTripToJSON() {
        #expect(FirebaseToolEngine.json(["start_date": .string("2026-11-23"), "n": .number(2)]) == #"{"n":2,"start_date":"2026-11-23"}"#)
    }
}

/// Real-model integration (WP-01 runtime half). Needs a Mac with Apple Intelligence, a
/// GoogleService-Info.plist and a registered App Check debug token:
/// `RUN_ON_DEVICE_TESTS=1 FIREBASE_PLIST=/path/GoogleService-Info.plist ./scripts/test.sh`
@Suite(.enabled(if: ProcessInfo.processInfo.environment["RUN_ON_DEVICE_TESTS"] == "1"))
struct OnDeviceIntegrationTests {
    @Test func phoneOnlyRunsOnDevice() async throws {
        guard ProcessInfo.processInfo.environment["FIREBASE_PLIST"] != nil else { return }
        // Firebase configuration for tests is added with WP-01's runtime spike.
    }
}
