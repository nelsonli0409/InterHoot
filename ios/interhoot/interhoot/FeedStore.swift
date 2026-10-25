import Foundation
import Observation

// Polls SpacetimeDB every few seconds (build guide C3 fallback: refresh instead of a live subscription).
@MainActor
@Observable
final class FeedStore {
    var calls: [CallRecord] = []
    var flagged: [FlaggedNumber] = []
    var lastError: String?
    var lastUpdated: Date?
    var callBlockingEnabled = false
    var callBlockingError: String?
    var callBlockingStatus: CallDirectoryStatus?

    private let client = SpacetimeClient()
    private let directory = CallDirectorySync()
    private var pollTask: Task<Void, Never>?

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func refresh() async {
        do {
            let callRows = try await client.rows("SELECT * FROM call_log")
            let flaggedRows = try await client.rows("SELECT * FROM flagged_number")
            calls = callRows.compactMap(CallRecord.init(row:)).sorted { $0.startedAt > $1.startedAt }
            flagged = flaggedRows.compactMap(FlaggedNumber.init(row:)).sorted { $0.lastSeen > $1.lastSeen }
            lastError = nil
            lastUpdated = Date()
        } catch {
            lastError = error.localizedDescription
            return
        }
        await syncCallBlocking()
        await PushRegistrar.shared.register()
    }

    /// C5: keep the iPhone's block list in step with flagged_number. `force` reloads even if nothing changed.
    func syncCallBlocking(force: Bool = false) async {
        callBlockingEnabled = await directory.isEnabled()
        do {
            try await directory.update(from: flagged, force: force)
            callBlockingError = nil
        } catch {
            callBlockingError = error.localizedDescription
        }
        callBlockingStatus = directory.extensionStatus()
    }

    func openCallBlockingSettings() async {
        do {
            try await directory.openSettings()
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// The "Not a scam" button.
    func markNotScam(_ number: FlaggedNumber) async {
        do {
            try await client.call("mark_false_positive", [number.e164])
            await refresh()
        } catch {
            lastError = error.localizedDescription
        }
    }
}
