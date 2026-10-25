import SwiftUI

struct BlockedView: View {
    @Environment(FeedStore.self) private var store

    private var blocked: [FlaggedNumber] { store.flagged.filter { $0.flag != "green" } }

    var body: some View {
        NavigationStack {
            Group {
                if blocked.isEmpty {
                    ContentUnavailableView("No flagged numbers", systemImage: "hand.raised",
                                           description: Text(store.lastError ?? "Numbers InterHoot flags will be listed here."))
                } else {
                    List(blocked) { number in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(number.e164).font(.headline)
                                Spacer()
                                FlagBadge(flag: number.flag)
                            }
                            Text("\(number.reason) · seen \(number.hitCount)x").font(.caption).foregroundStyle(.secondary)
                            Button("Not a scam") {
                                Task { await store.markNotScam(number) }
                            }
                            .buttonStyle(.bordered)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            .navigationTitle("Blocked")
            .refreshable { await store.refresh() }
        }
    }
}
