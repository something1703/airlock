import FirebaseAppCheck
import FirebaseCore
import Foundation
import os

/// Whether Firebase is configured for this run.
enum FirebaseStatus: Equatable {
    case configured
    /// No `GoogleService-Info.plist` in the bundle (fresh clone). The app still runs; cloud features are off.
    case missingConfig
}

/// Configures App Check **before** `FirebaseApp.configure()` (required by Firebase AI Logic; API-NOTES §4).
enum FirebaseBootstrap {
    private static let log = Logger(subsystem: "app.airlock", category: "firebase")

    static func configure() -> FirebaseStatus {
        guard Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil else {
            log.warning("GoogleService-Info.plist missing — running with Firebase disabled")
            return .missingConfig
        }
        #if DEBUG
            // The debug token is printed by the SDK on first launch; register it in the console. Never commit it.
            AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())
        #else
            AppCheck.setAppCheckProviderFactory(AirlockAppCheckProviderFactory())
        #endif
        if FirebaseApp.app() == nil { FirebaseApp.configure() }
        return .configured
    }
}

/// Release App Check: App Attest on real devices, debug provider in the Simulator (App Attest can't run there).
final class AirlockAppCheckProviderFactory: NSObject, AppCheckProviderFactory {
    func createProvider(with app: FirebaseApp) -> (any AppCheckProvider)? {
        #if targetEnvironment(simulator)
            return AppCheckDebugProvider(app: app)
        #else
            return AppAttestProvider(app: app)
        #endif
    }
}
