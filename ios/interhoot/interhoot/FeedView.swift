import SwiftUI

struct FeedView: View {
    @Environment(FeedStore.self) private var store

    var body: some View {
        NavigationStack {
            Group {
                if store.calls.isEmpty {
                    ContentUnavailableView(
                        "No calls yet",
                        systemImage: "phone.arrow.down.left",
                        description: Text(store.lastError ?? "Screened calls will show up here.")
                    )
                } else {
                    List(store.calls) { call in
                        NavigationLink(value: call) {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(call.callerDisplay).font(.headline)
                                    Spacer()
                                    FlagBadge(flag: call.flag)
                                }
                                if !call.summary.isEmpty {
                                    Text(call.summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                                }
                                if let date = call.startedDate {
                                    Text(date, style: .relative).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Calls")
            .navigationDestination(for: CallRecord.self) { CallDetailView(call: $0) }
            .refreshable { await store.refresh() }
        }
    }
}
