import AirlockCore
import AirlockDetect
import SwiftUI

/// Names and details Airlock always protects. Encrypted, on this device only (INV-6).
struct VaultView: View {
    let session: AirlockSession
    @State private var name = ""
    @State private var aliases = ""
    @State private var role = ""
    @State private var category: PrivacyCategory = .person

    private let kinds: [PrivacyCategory] = [.person, .org, .location, .contact, .id]

    var body: some View {
        ScreenScroll {
            ScreenHeader(
                title: String(localized: "Vault"),
                subtitle: String(localized: "Names and details Airlock always protects, even if the on-device model misses them. Encrypted and kept only on this device, never synced."))
            addCard.enter()
            VStack(alignment: .leading, spacing: 8) {
                if session.vault.isEmpty {
                    EmptyState(
                        glyph: .vault, title: String(localized: "Nothing here yet."),
                        detail: String(localized: "Add the names you never want to share. Airlock catches them even if the on-device model misses one."))
                } else {
                    ForEach(Array(session.vault.enumerated()), id: \.element.id) { i, v in
                        VaultRow(entry: v) { Task { await session.removeVaultEntry(v.id) } }.enter(i)
                    }
                }
            }
            .card()
        }
        .navigationTitle(Text("Vault"))
    }

    private var addCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { kindMenu; nameField.frame(minWidth: 180); roleField.frame(minWidth: 120) }
                VStack(alignment: .leading, spacing: 10) { kindMenu; nameField; roleField }
            }
            TextField(String(localized: "Other ways you write it, comma-separated (e.g. Raj, Mr Patel)"), text: $aliases)
                .textFieldStyle(AirlockFieldStyle())
                .accessibilityLabel(Text("Aliases"))
            Button {
                Task { await add() }
            } label: {
                IconLabel(title: "Add", glyph: .plus)
            }
            .buttonStyle(.primary)
            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .card()
    }

    private var kindMenu: some View {
        Picker(selection: $category) {
            ForEach(kinds, id: \.self) { k in Text(k == .id ? String(localized: "ID number") : k.label).tag(k) }
        } label: {
            Text("Kind")
        }
        .pickerStyle(.menu)
        .tint(Palette.text)
        .frame(minHeight: 44)
        .padding(.horizontal, 6)
        .background(Palette.raised, in: RoundedRectangle(cornerRadius: Metrics.controlRadius))
        .overlay(RoundedRectangle(cornerRadius: Metrics.controlRadius).strokeBorder(Palette.stroke))
        .accessibilityLabel(Text("Kind"))
    }

    private var nameField: some View {
        TextField(String(localized: "e.g. Raj Patel"), text: $name).textFieldStyle(AirlockFieldStyle()).accessibilityLabel(Text("Name or detail"))
    }

    private var roleField: some View {
        TextField(String(localized: "role, e.g. landlord"), text: $role).textFieldStyle(AirlockFieldStyle()).accessibilityLabel(Text("Role"))
    }

    private func add() async {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { return }
        let r = role.trimmingCharacters(in: .whitespaces)
        let entry = VaultEntry(
            id: UUID().uuidString, canonical: n,
            aliases: aliases.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }, category: category,
            roleHint: r.isEmpty ? nil : "my \(r)")
        await session.addVaultEntries([entry])
        name = ""
        aliases = ""
        role = ""
    }
}

private struct VaultRow: View {
    let entry: VaultEntry
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            ChipView(label: "", style: .protected(entry.category, lowConfidence: false), iconOnly: true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: entry.canonical + (entry.isUser ? String(localized: " (you)") : "")).font(.body.weight(.semibold)).foregroundStyle(Palette.text)
                Text(verbatim: detail).font(.footnote).foregroundStyle(Palette.text2)
            }
            Spacer(minLength: 8)
            Button("Remove", action: remove)
                .buttonStyle(AirlockButtonStyle(kind: .danger, compact: true))
                .accessibilityLabel(Text("Remove \(entry.canonical)"))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .overlay(RoundedRectangle(cornerRadius: Metrics.controlRadius).strokeBorder(Palette.stroke))
    }

    private var detail: String {
        var parts = [entry.category == .id ? String(localized: "ID number") : entry.category.label]
        if let r = entry.roleHint { parts.append(r) }
        if !entry.aliases.isEmpty { parts.append(String(localized: "also “\(entry.aliases.joined(separator: "”, “"))”")) }
        return parts.joined(separator: " · ")
    }
}

#Preview("Vault") {
    NavigationStack { VaultView(session: PreviewSession.make(scenario: .seeded)) }
}
