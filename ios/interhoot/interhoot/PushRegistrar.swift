import Foundation
import Observation

// Build guide C6, app side. Sends the APNs device token to SpacetimeDB (register_apns_token) once both
// the token and the protected user's id are known. The user row must exist first (set_user_prefs).
@MainActor
@Observable
final class PushRegistrar {
    static let shared = PushRegistrar()

    /// Shown in the Blocked tab so a missing push can be diagnosed on the phone.
    private(set) var status = "Push: waiting for permission"

    private let client = SpacetimeClient()
    private let defaults = UserDefaults.standard
    private var lastAttempt: Date?

    /// The protected user's id (protected_user.id). Onboarding sets it; nothing sets it yet.
    var userId: String? {
        get { defaults.string(forKey: "userId") }
        set {
            defaults.set(newValue, forKey: "userId")
            Task { await register(force: true) }
        }
    }

    private var deviceToken: String? { defaults.string(forKey: "apnsToken") }

    func permissionResult(granted: Bool) {
        if !granted { status = "Push: notifications are off for InterHoot (Settings > Notifications)" }
    }

    func receivedDeviceToken(_ token: String) {
        defaults.set(token, forKey: "apnsToken")
        Task { await register(force: true) }
    }

    func registrationFailed(_ error: Error) {
        status = "Push: iOS could not register (\(error.localizedDescription))"
    }

    /// Safe to call often: it retries at most every 30 seconds unless `force` is set.
    func register(force: Bool = false) async {
        guard let token = deviceToken else { return }
        guard let userId, !userId.isEmpty else {
            status = "Push: token received, waiting for a user id"
            return
        }
        let marker = "\(userId)|\(token)"
        if defaults.string(forKey: "apnsRegisteredFor") == marker { status = "Push: registered for \(userId)"; return }
        if !force, let last = lastAttempt, Date().timeIntervalSince(last) < 30 { return }
        lastAttempt = Date()
        do {
            try await client.call("register_apns_token", [userId, token])
            defaults.set(marker, forKey: "apnsRegisteredFor")
            status = "Push: registered for \(userId)"
        } catch {
            status = "Push: could not register (\(error.localizedDescription))"
        }
    }
}
