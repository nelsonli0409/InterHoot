import SwiftUI

// Build guide C4 onboarding: demo identity, language, the phone the server forwards good calls to,
// and the Call Directory prompt. Saving calls set_user_prefs, then registers the push token for that user id.
struct DemoIdentity: Identifiable, Hashable {
    let id: String           // protected_user.id and CRS persona id (decided with Alex: P20)
    let displayName: String

    static let all = [DemoIdentity(id: "P20", displayName: "Dolores Whitcomb")]
}

struct AppLanguage: Identifiable, Hashable {
    let code: String         // ISO 639-1; the guide's Cartesia language plan (section 3.2)
    let name: String
    var id: String { code }

    static let all = [
        AppLanguage(code: "en", name: "English"), AppLanguage(code: "es", name: "Spanish"),
        AppLanguage(code: "zh", name: "Chinese"), AppLanguage(code: "hi", name: "Hindi"),
        AppLanguage(code: "vi", name: "Vietnamese"), AppLanguage(code: "tl", name: "Tagalog"),
        AppLanguage(code: "ko", name: "Korean"), AppLanguage(code: "ar", name: "Arabic"),
        AppLanguage(code: "ru", name: "Russian"), AppLanguage(code: "pt", name: "Portuguese"),
        AppLanguage(code: "bn", name: "Bengali"), AppLanguage(code: "pa", name: "Punjabi"),
        AppLanguage(code: "ur", name: "Urdu"), AppLanguage(code: "fr", name: "French"),
        AppLanguage(code: "ja", name: "Japanese"),
    ]
}

struct OnboardingView: View {
    @Environment(FeedStore.self) private var store
    @AppStorage("onboarded") private var onboarded = false
    @State private var identity = DemoIdentity.all[0]
    @State private var language = AppLanguage.all[0]
    @State private var phone = ""
    @State private var saving = false
    @State private var error: String?

    private let client = SpacetimeClient()

    // Same rule as the set_user_prefs reducer.
    private var phoneIsValid: Bool { phone.range(of: "^\\+[1-9][0-9]{6,14}$", options: .regularExpression) != nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    InterHootLogo(height: 110)
                        .frame(maxWidth: .infinity)
                }
                .listRowBackground(Color.clear)

                Section("Demo identity") {
                    Picker("Identity", selection: $identity) {
                        ForEach(DemoIdentity.all) { Text("\($0.displayName) (\($0.id))").tag($0) }
                    }
                }
                Section("Language") {
                    Picker("Language", selection: $language) {
                        ForEach(AppLanguage.all) { Text($0.name).tag($0) }
                    }
                }
                Section {
                    TextField("+14155550123", text: $phone)
                        .keyboardType(.phonePad)
                        .textContentType(.telephoneNumber)
                } header: {
                    Text("Your real phone")
                } footer: {
                    Text("Calls that pass screening ring this number. Use + and the country code.")
                }
                Section {
                    Button("Turn on call blocking") {
                        Task { await store.openCallBlockingSettings() }
                    }
                } footer: {
                    Text("Opens Settings. Switch InterHoot on under Call Blocking & Identification. You can also do this later from the Blocked tab.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Section {
                    Button(saving ? "Saving..." : "Continue") { Task { await save() } }
                        .disabled(!phoneIsValid || saving)
                }
            }
            .navigationTitle("Welcome")
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            try await client.call("set_user_prefs", [identity.id, identity.displayName, language.code, identity.id, phone])
            PushRegistrar.shared.userId = identity.id
            onboarded = true
        } catch {
            self.error = error.localizedDescription
        }
    }
}
