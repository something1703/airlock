import Observation
import SwiftUI

@main
struct AirlockApp: App {
    @State private var boot = AppBoot()

    var body: some Scene {
        WindowGroup {
            BootView(boot: boot)
        }
        .commands { AirlockCommands(boot: boot) }
        #if os(macOS)
            .defaultSize(width: 1100, height: 720)
            .windowResizability(.contentMinSize)
        #endif
    }
}

/// Menu bar and hardware-keyboard commands (docs/06-UI-UX.md §8): ⌘N new, ⌘↩ seal (Ask) or
/// Seal & send (Review), ⌘⇧C copy sealed version, ⌘R open the latest receipt. Each runs the same
/// session action as its on-screen button, so the egress gate is never bypassed.
struct AirlockCommands: Commands {
    let boot: AppBoot

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Sealed Request") { boot.session?.go(.ask) }
                .keyboardShortcut("n")
        }
        CommandMenu(Text("Request")) {
            let session = boot.session
            Button {
                session?.requestSeal()
            } label: {
                if session?.isReviewShowing == true { Text("Seal & Send") } else { Text("Seal on This Device") }
            }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!(session?.canSealAndSend ?? false) && !(session.map { $0.section == .ask && $0.askPath.isEmpty } ?? false))
            Button("Copy Sealed Version") { Task { await session?.copySealedVersion() } }
                .keyboardShortcut("c", modifiers: [.command, .shift])
                .disabled(!(session?.canCopySealed ?? false))
            Divider()
            Button("Open Latest Receipt") { session?.openReceipt() }
                .keyboardShortcut("r")
                .disabled(session?.receipts.isEmpty ?? true)
        }
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
