import SwiftUI

/// Boots services, then shows onboarding or the app. iPhone: tabs; iPad / Mac: sidebar split view.
struct BootView: View {
    let boot: AppBoot

    var body: some View {
        Group {
            if let session = boot.session, session.isLoaded {
                RootView(session: session)
            } else if boot.failed {
                VStack(spacing: 12) {
                    AirlockLogo(size: 56)
                    Text("Airlock couldn't start. Please reinstall the app.").font(.body).foregroundStyle(Palette.text)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                AirlockLogo(size: 72, animated: true)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel(Text("Airlock is starting"))
            }
        }
        .background(Palette.bg.ignoresSafeArea())
        .task { await boot.start() }
    }
}

struct RootView: View {
    let session: AirlockSession
    #if os(iOS)
        @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    var body: some View {
        Group {
            if !session.prefs.onboarded {
                OnboardingView(session: session)
            } else {
                #if os(macOS)
                    SplitRoot(session: session)
                #else
                    if sizeClass == .compact { TabRoot(session: session) } else { SplitRoot(session: session) }
                #endif
            }
        }
        .tint(Palette.seal)
        #if os(macOS)
            .frame(minWidth: 900, minHeight: 600)
        #endif
    }
}

/// The Ask stack (compose → review → thread), shared by both layouts.
struct AskStack: View {
    @Bindable var session: AirlockSession

    var body: some View {
        NavigationStack(path: $session.askPath) {
            AskView(session: session)
                .navigationDestination(for: AskRoute.self) { route in
                    switch route {
                    case .review: ReviewView(session: session)
                    case .thread(let id): ThreadView(session: session, threadID: id)
                    }
                }
        }
    }
}

struct TabRoot: View {
    @Bindable var session: AirlockSession

    var body: some View {
        TabView(selection: $session.section) {
            ForEach(AppSection.allCases, id: \.self) { s in
                Tab(value: s) {
                    sectionView(s)
                } label: {
                    Label {
                        Text(s.title)
                    } icon: {
                        GlyphImage.image(s.glyph)
                    }
                }
            }
        }
    }

    @ViewBuilder private func sectionView(_ s: AppSection) -> some View {
        switch s {
        case .ask: AskStack(session: session)
        case .ledger: NavigationStack { LedgerView(session: session) }
        case .vault: NavigationStack { VaultView(session: session) }
        case .settings: NavigationStack { SettingsView(session: session) }
        }
    }
}

struct SplitRoot: View {
    @Bindable var session: AirlockSession

    var body: some View {
        NavigationSplitView {
            Sidebar(session: session)
                .navigationSplitViewColumnWidth(min: 220, ideal: 250, max: 320)
        } detail: {
            switch session.section {
            case .ask: AskStack(session: session)
            case .ledger: NavigationStack { LedgerView(session: session) }
            case .vault: NavigationStack { VaultView(session: session) }
            case .settings: NavigationStack { SettingsView(session: session) }
            }
        }
    }
}

/// Sidebar: sections + conversations (web `.sidebar`).
struct Sidebar: View {
    @Bindable var session: AirlockSession

    var body: some View {
        List(selection: $session.sidebarSelection) {
            Section {
                ForEach(AppSection.allCases, id: \.self) { s in
                    Label {
                        Text(s.title)
                    } icon: {
                        Icon(s.glyph, size: 18)
                    }
                    .tag(SidebarItem.section(s))
                }
            } header: {
                HStack(spacing: 10) {
                    AirlockLogo(size: 30, animated: true)
                    Text(verbatim: "Airlock").font(.title3.bold()).foregroundStyle(Palette.text)
                }
                .padding(.vertical, 8)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
            }
            if !session.threads.isEmpty {
                Section(String(localized: "Conversations")) {
                    ForEach(session.threads.prefix(20)) { t in
                        Label {
                            Text(verbatim: t.title).lineLimit(1)
                        } icon: {
                            Icon(t.lastAnswer?.summary?.ranOnDevice == true ? .device : .cloud, size: 16)
                        }
                        .tag(SidebarItem.thread(t.id))
                        .accessibilityLabel(Text(verbatim: t.title))
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            Text("Private details are sealed on this device before anything reaches Gemini.")
                .font(.footnote).foregroundStyle(Palette.text2)
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(Text(verbatim: "Airlock"))
    }
}

#Preview("iPhone tabs") {
    RootView(session: PreviewSession.make(scenario: .thread))
}

#Preview("Split") {
    SplitRoot(session: PreviewSession.make(scenario: .thread))
}
