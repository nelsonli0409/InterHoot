import SwiftUI

struct ContentView: View {
    @State private var store = FeedStore()
    @AppStorage("onboarded") private var onboarded = false

    var body: some View {
        Group {
            if onboarded {
                TabView {
                    FeedView()
                        .tabItem { Label("Calls", systemImage: "phone") }
                    BlockedView()
                        .tabItem { Label("Blocked", systemImage: "hand.raised") }
                }
            } else {
                OnboardingView()
            }
        }
        .environment(store)
        .task { store.start() }
    }
}

#Preview {
    ContentView()
}
