import SwiftUI

struct ContentView: View {
    @State private var store = FeedStore()

    var body: some View {
        TabView {
            FeedView()
                .tabItem { Label("Calls", systemImage: "phone") }
            BlockedView()
                .tabItem { Label("Blocked", systemImage: "hand.raised") }
        }
        .environment(store)
        .task { store.start() }
    }
}

#Preview {
    ContentView()
}
