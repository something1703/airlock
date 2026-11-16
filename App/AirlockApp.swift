import SwiftUI

@main
struct AirlockApp: App {
    @State private var firebase = FirebaseBootstrap.configure()

    var body: some Scene {
        WindowGroup {
            RootView(firebaseStatus: firebase)
        }
        #if os(macOS)
            .defaultSize(width: 1100, height: 720)
        #endif
    }
}
