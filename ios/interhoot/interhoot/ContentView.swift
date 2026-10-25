import SwiftUI

struct ContentView: View {
    @State private var store = FeedStore()
    @AppStorage("onboarded") private var onboarded = false
    @State private var showingSplash = true

    var body: some View {
        ZStack {
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

            if showingSplash {
                SplashView()
                    .transition(.opacity)
            }
        }
        .environment(store)
        .preferredColorScheme(.dark)
        .background(Color.black.ignoresSafeArea())
        .task {
            store.start()
            try? await Task.sleep(for: .seconds(1.8))
            withAnimation(.easeInOut(duration: 0.6)) { showingSplash = false }
        }
    }
}

// The owl logo, in its own gold. Used on the splash screen and in the navigation bars.
struct InterHootLogo: View {
    let height: CGFloat

    var body: some View {
        Image("Logo")
            .resizable()
            .renderingMode(.original)
            .scaledToFit()
            .frame(height: height)
            .accessibilityLabel("InterHoot")
    }
}

// Black screen, the logo fades in at the center, then the app's first screen replaces it.
struct SplashView: View {
    @State private var logoVisible = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            InterHootLogo(height: 160)
                .opacity(logoVisible ? 1 : 0)
        }
        .onAppear {
            withAnimation(.easeIn(duration: 0.8)) { logoVisible = true }
        }
    }
}

#Preview {
    ContentView()
}
