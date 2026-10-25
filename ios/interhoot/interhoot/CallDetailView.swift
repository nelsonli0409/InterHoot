import SwiftUI

struct CallDetailView: View {
    let call: CallRecord

    private var claims: [Claim] {
        guard let data = call.claimsJson.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([Claim].self, from: data)) ?? []
    }

    var body: some View {
        List {
            Section("Verdict") {
                HStack {
                    FlagBadge(flag: call.flag)
                    Spacer()
                    Text("Score \(call.score, format: .number.precision(.fractionLength(2)))")
                        .foregroundStyle(.secondary)
                }
                LabeledContent("Caller", value: call.callerDisplay)
                LabeledContent("Type", value: call.scamType.replacingOccurrences(of: "_", with: " "))
                if !call.summary.isEmpty { Text(call.summary) }
            }

            if !claims.isEmpty {
                Section("What the caller claimed") {
                    ForEach(claims, id: \.self) { claim in
                        VStack(alignment: .leading) {
                            Text(claim.creditor).font(.headline)
                            Text("\(claim.claim.replacingOccurrences(of: "_", with: " ")), \(claim.account_type), $\(claim.amount, specifier: "%.2f")")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            Section("Credit-report check (CRS)") {
                Text(call.crsEvidenceJson).font(.system(.footnote, design: .monospaced))
            }

            Section("Transcript") {
                Text(call.transcript.isEmpty ? "No transcript" : call.transcript)
            }
        }
        .navigationTitle("Call details")
        .navigationBarTitleDisplayMode(.inline)
    }
}
