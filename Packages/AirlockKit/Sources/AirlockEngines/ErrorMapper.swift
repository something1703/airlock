import AirlockCore
import FirebaseAILogic
import Foundation

#if canImport(FoundationModels)
    // Allowed here only, for Apple's error types — never to run inference (AGENTS.md §3, 16 Nov override).
    import FoundationModels
#endif

/// Maps every SDK error to an `EngineError`.
///
/// Guarantees: the result never contains the SDK's description or any prompt/answer text
/// (INV-8) — only a case, or a stable code like `http.400`. Wrapped errors are unwrapped.
enum ErrorMapper {
    static func map(_ error: any Error, depth: Int = 0) -> EngineError {
        if let e = error as? EngineError { return e }
        if error is CancellationError { return .cancelled }

        #if canImport(FoundationModels)
            if let mapped = mapFoundationModels(error) { return mapped }
        #endif

        if let e = error as? GenerativeModelSession.GenerationError {
            switch e {
            case .assetsUnavailable: return .unavailable(.modelNotReady)
            case .decodingFailure: return .parse
            case .concurrentRequests: return .busy
            case .internalError(_, let underlying) where depth < 4: return map(underlying, depth: depth + 1)
            default: return .other(code: "session")
            }
        }
        if let e = error as? GenerateContentError {
            switch e {
            case .promptBlocked(let response):
                return response.promptFeedback?.blockReason?.rawValue == "MODEL_ARMOR" ? .armorBlocked : .cloudBlocked
            case .responseStoppedEarly(let reason, _):
                return [.safety, .blocklist, .prohibitedContent, .spii].contains(reason) ? .cloudBlocked : .other(code: "stopped")
            case .internalError(let underlying) where depth < 4:
                return map(underlying, depth: depth + 1)
            default:
                return .other(code: "generate")
            }
        }
        if let u = error as? URLError {
            switch u.code {
            case .notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotFindHost, .cannotConnectToHost, .dataNotAllowed,
                .internationalRoamingOff:
                return .offline
            default: return .other(code: "url.\(u.code.rawValue)")
            }
        }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain { return .offline }
        if ns.domain.hasSuffix("BackendError") {
            switch ns.code {
            case 429: return .quota
            case 500, 502, 503, 504: return .serviceUnavailable
            case 401, 403: return .appCheck
            default: return .other(code: "http.\(ns.code)")
            }
        }
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? any Error, depth < 4 { return map(underlying, depth: depth + 1) }
        return .other(code: "unknown")
    }

    #if canImport(FoundationModels)
        @available(iOS, deprecated: 27.0)
        @available(macOS, deprecated: 27.0)
        private static func mapFoundationModels(_ error: any Error) -> EngineError? {
            #if compiler(>=6.4)
                if #available(iOS 27.0, macOS 27.0, visionOS 27.0, *), let e = error as? LanguageModelError {
                    switch e {
                    case .contextSizeExceeded: return .contextTooLong
                    case .guardrailViolation, .refusal: return .refused
                    case .unsupportedLanguageOrLocale: return .unsupportedLanguage
                    case .rateLimited, .timeout: return .busy
                    default: return .other(code: "fm.27")
                    }
                }
            #endif
            if let e = error as? LanguageModelSession.GenerationError {
                switch e {
                case .exceededContextWindowSize: return .contextTooLong
                case .guardrailViolation, .refusal: return .refused
                case .unsupportedLanguageOrLocale: return .unsupportedLanguage
                case .rateLimited, .concurrentRequests: return .busy
                case .assetsUnavailable: return .unavailable(.modelNotReady)
                case .decodingFailure: return .parse
                default: return .other(code: "fm.26")
                }
            }
            return nil
        }
    #endif

    /// Phone availability from the SDK's wrapper type.
    static func availability(_ a: FirebaseAI.SystemLanguageModel.Availability) -> PhoneAvailability {
        switch a {
        case .available: return .available
        case .unavailable(let reason):
            switch reason {
            case .deviceNotEligible: return .deviceNotEligible
            case .appleIntelligenceNotEnabled: return .appleIntelligenceNotEnabled
            case .modelNotReady: return .modelNotReady
            default: return .unknown
            }
        }
    }
}
