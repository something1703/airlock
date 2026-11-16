import AirlockCore
import SwiftUI

/// Placeholder shell (WP-00). Replaced by the tab / split navigation in WP-10.
struct RootView: View {
    let firebaseStatus: FirebaseStatus

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "shield.lefthalf.filled")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("Airlock")
                .font(.largeTitle.bold())
            Text("The best AI, without giving yourself away.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if firebaseStatus == .missingConfig {
                Label("Firebase isn't set up on this build yet.", systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .accessibilityLabel("Firebase isn't set up on this build yet. Cloud features are off.")
            }
        }
        .padding(32)
    }
}

#Preview("Configured") { RootView(firebaseStatus: .configured) }
#Preview("No Firebase config") { RootView(firebaseStatus: .missingConfig) }
