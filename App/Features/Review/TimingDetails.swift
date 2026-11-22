import AirlockSeal
import SwiftUI

/// FX-02: where the seal's time went, on this device. Numbers only.
struct TimingDetails: View {
    let timings: SealTimings
    @State private var open = false

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(rows, id: \.label) { row in
                    HStack {
                        Text(row.label)
                        Spacer(minLength: 12)
                        Text(row.value).monospacedDigit()
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.top, 6)
        } label: {
            Text("Timing")
        }
        .font(.footnote)
        .foregroundStyle(Palette.text2)
        .accessibilityHint(Text("Shows how long each step took on this device"))
    }

    private struct Row {
        let label: String
        let value: String
    }

    private var rows: [Row] {
        var out = [
            Row(label: String(localized: "Your Vault and the rules"), value: Self.seconds(timings.rules)),
            Row(
                label: String(localized: "On-device model reading"),
                value: String(localized: "\(Self.seconds(timings.detect)) · calls: \(timings.detectCalls + timings.repairCalls)")),
        ]
        if timings.generaliseCalls > 0 {
            out.append(
                Row(
                    label: String(localized: "Making details less specific"),
                    value: String(localized: "\(Self.seconds(timings.generalise)) · calls: \(timings.generaliseCalls)")))
        }
        if timings.redTeamCalls > 0 {
            out.append(
                Row(
                    label: String(localized: "Checking what could be guessed"),
                    value: String(localized: "\(Self.seconds(timings.redTeam)) · calls: \(timings.redTeamCalls)")))
        }
        if let first = timings.firstModelOutput {
            out.append(Row(label: String(localized: "First reply from the model"), value: String(localized: "after \(Self.seconds(first))")))
        }
        out.append(Row(label: String(localized: "Ready to review"), value: String(localized: "after \(Self.seconds(timings.total))")))
        return out
    }

    static func seconds(_ d: Duration) -> String {
        let s = Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18
        return String(localized: "\(s.formatted(.number.precision(.fractionLength(1)))) s")
    }
}

#Preview {
    var t = SealTimings()
    t.rules = .milliseconds(4)
    t.detect = .milliseconds(11_200)
    t.detectCalls = 1
    t.generalise = .milliseconds(2_800)
    t.generaliseCalls = 2
    t.firstModelOutput = .milliseconds(11_210)
    t.total = .milliseconds(14_050)
    return TimingDetails(timings: t).padding()
}
