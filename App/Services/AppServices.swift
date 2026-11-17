import AirlockCore
import AirlockDetect
import AirlockEngineMocks
import AirlockEngines
import AirlockPrompts
import AirlockStore
import Foundation
import os

@preconcurrency import FirebaseRemoteConfig

/// How this run talks to models.
enum AppMode: Equatable, Sendable {
    /// Firebase AI Logic: Apple's on-device model + Gemini.
    case live
    /// Scripted engines; `noFirebase` when the build has no Firebase config.
    case demo(noFirebase: Bool)

    var isDemo: Bool { self != .live }
}

/// Everything the session needs, chosen once at launch.
struct AppServices: Sendable {
    let mode: AppMode
    let config: AppConfig
    let prompts: PromptLibrary
    let patterns: PatternDetector
    let engines: any EngineProvider
    let availability: @Sendable () async -> PhoneAvailability
    let stores: AirlockStores
    let conversations: ConversationStore
    /// False when the Keychain key can't be created (e.g. an unsigned Mac build): data is then kept
    /// in memory only — never written unencrypted (INV-6).
    let persistent: Bool
    /// Demo-only launch options for scripted screenshots.
    let demoScript: DemoScript?

    enum StartError: Error { case resources }

    private static let log = Logger(subsystem: "app.airlock", category: "services")

    /// Live mode only with Firebase configured and no `-demo` flag (or the Demo scheme).
    @MainActor
    static func make(firebase: FirebaseStatus, arguments: [String] = ProcessInfo.processInfo.arguments) async throws(StartError) -> AppServices {
        var demoRequested = arguments.contains("-demo")
        #if AIRLOCK_DEMO
            demoRequested = true
        #endif
        let mode: AppMode = firebase == .missingConfig ? .demo(noFirebase: true) : demoRequested ? .demo(noFirebase: false) : .live

        let config = mode == .live ? AppConfig(remote: await RemoteConfigLoader.fetch()) : AppConfig()
        guard let prompts = (try? PromptLibrary(overridesJSON: config.string("prompt_overrides_json"))) ?? (try? PromptLibrary()),
            let patterns = try? PatternDetector.bundled(disabledPacks: config.disabledPatternPacks)
        else { throw .resources }

        let engines: any EngineProvider
        let availability: @Sendable () async -> PhoneAvailability
        if mode == .live {
            let firebaseEngines = FirebaseEngines(config: config, prompts: prompts)
            engines = firebaseEngines
            availability = { firebaseEngines.phoneAvailability() }
        } else {
            engines = DemoEngines.make()
            availability = { .available }
        }

        // Demo mode keeps its own encrypted data and key, so scripted receipts never mix with real ones.
        let folder = mode == .live ? "live" : "demo"
        let base = (FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory)
            .appendingPathComponent("Airlock", isDirectory: true).appendingPathComponent(folder, isDirectory: true)
        let keychain = KeychainKeyProvider(account: mode == .live ? "master-key-v1" : "demo-master-key-v1")
        let keys: any KeyProvider
        let persistent: Bool
        do {
            _ = try keychain.key()
            keys = keychain
            persistent = true
        } catch {
            log.warning("Keychain key unavailable; keeping data in memory only")
            keys = InMemoryKeyProvider()
            persistent = false
        }
        let storeDir = persistent ? base : FileManager.default.temporaryDirectory.appendingPathComponent("airlock-\(UUID().uuidString)")
        return AppServices(
            mode: mode, config: config, prompts: prompts, patterns: patterns, engines: engines, availability: availability,
            stores: AirlockStores(directory: storeDir.appendingPathComponent("store", isDirectory: true), keys: keys),
            conversations: ConversationStore(directory: storeDir.appendingPathComponent("conversations", isDirectory: true), keys: keys),
            persistent: persistent, demoScript: mode.isDemo ? DemoScript(arguments: arguments) : nil)
    }

    /// In-memory services on demo engines (previews, tests).
    static func preview(latency: Duration = .milliseconds(150)) -> AppServices {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("airlock-preview-\(UUID().uuidString)")
        let keys = InMemoryKeyProvider()
        let config = AppConfig()
        // Bundled resources; previews have nothing to fall back to.
        let prompts = (try? PromptLibrary()) ?? PreviewFallback.prompts
        let patterns = (try? PatternDetector.bundled()) ?? PreviewFallback.patterns
        return AppServices(
            mode: .demo(noFirebase: false), config: config, prompts: prompts, patterns: patterns, engines: DemoEngines.make(latency: latency),
            availability: { .available }, stores: AirlockStores(directory: dir.appendingPathComponent("store"), keys: keys),
            conversations: ConversationStore(directory: dir.appendingPathComponent("conversations"), keys: keys), persistent: true, demoScript: nil)
    }
}

/// Last-resort empty resources for previews only.
private enum PreviewFallback {
    static var prompts: PromptLibrary {
        guard let p = try? PromptLibrary(overridesJSON: "{}") else { fatalError("Bundled prompts missing") }
        return p
    }
    static var patterns: PatternDetector {
        guard let p = try? PatternDetector(packs: []) else { fatalError("Pattern detector unavailable") }
        return p
    }
}

/// Remote Config (model names, thresholds, prompt overrides) with bundled defaults as fallback.
enum RemoteConfigLoader {
    @MainActor
    static func fetch() async -> [String: String] {
        let rc = RemoteConfig.remoteConfig()
        let settings = RemoteConfigSettings()
        settings.fetchTimeout = 5
        #if DEBUG
            settings.minimumFetchInterval = 0
        #endif
        rc.configSettings = settings
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            rc.fetchAndActivate { _, _ in done.resume() }
        }
        var out: [String: String] = [:]
        for key in rc.allKeys(from: .remote) { out[key] = rc.configValue(forKey: key).stringValue }
        return out
    }
}

/// Demo-only launch arguments that script the app for screenshots:
/// `-demoSeed` (fictional Vault + onboarded), `-demoScreen onboarding|review|thread|ledger|vault|settings`.
struct DemoScript: Sendable {
    let seed: Bool
    let screen: String?

    init(arguments: [String]) {
        seed = arguments.contains("-demoSeed")
        screen = arguments.firstIndex(of: "-demoScreen").flatMap { i in i + 1 < arguments.count ? arguments[i + 1] : nil }
    }
}
