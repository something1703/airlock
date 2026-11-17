import Observation
import SwiftUI

@main
struct AirlockApp: App {
    @State private var boot = AppBoot()

    var body: some Scene {
        WindowGroup {
            BootView(boot: boot)
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Sealed Request") { boot.session?.go(.ask) }
                    .keyboardShortcut("n")
            }
        }
        #if os(macOS)
            .defaultSize(width: 1100, height: 720)
            .windowResizability(.contentMinSize)
        #endif
    }
}

/// Configures Firebase (App Check first) at launch, then builds services and the session.
@Observable
@MainActor
final class AppBoot {
    let firebase: FirebaseStatus
    private(set) var session: AirlockSession?
    private(set) var failed = false

    init() {
        firebase = FirebaseBootstrap.configure()
    }

    func start() async {
        guard session == nil else { return }
        do {
            let services = try await AppServices.make(firebase: firebase)
            let s = AirlockSession(services: services)
            session = s
            await s.load()
        } catch {
            failed = true
        }
    }
}
