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
            .safeAreaInset(edge: .top) {
                if !store.callBlockingEnabled {
                    Button {
                        Task { await store.openCallBlockingSettings() }
                    } label: {
                        Label("Turn on InterHoot under Call Blocking & Identification", systemImage: "phone.badge.checkmark")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(.horizontal)
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 6) {
                    if let error = store.callBlockingError {
                        Text("Call blocking error: \(error)").foregroundStyle(.red)
                    }
                    if let status = store.callBlockingStatus {
                        Text("iPhone block list: \(status.blocked) blocked, \(status.labels) labelled, loaded \(status.loadedAt.formatted(date: .omitted, time: .standard))\(status.fileFound ? "" : " (list file not found)")")
                    } else {
                        Text("iPhone block list: not loaded yet")
                    }
                    Text(PushRegistrar.shared.status)
                    Button("Sync now") {
                        Task { await store.syncCallBlocking(force: true) }
                    }
                    .buttonStyle(.bordered)
                }
                .font(.caption)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .background(.bar)
            }
            .navigationTitle("Blocked")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { InterHootLogo(height: 24) }
            }
            .refreshable { await store.refresh() }
        }
    }
}
