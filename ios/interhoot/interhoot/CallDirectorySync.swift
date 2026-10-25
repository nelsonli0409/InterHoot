import Foundation
import CallKit

// Build guide C5, app side. Writes red and yellow numbers into the App Group container and asks
// iOS to reload the calldirectory extension. Red numbers are blocked; yellow ones are labelled
// "InterHoot: Suspicious". Must match CallDirectoryList in calldirectory/CallDirectoryHandler.swift.
struct CallDirectoryList: Codable, Equatable {
    struct Label: Codable, Equatable {
        let number: Int64
        let label: String
    }
    let blocked: [Int64]
    let labels: [Label]

    static let appGroup = "group.com.aslavny.interhoot"
    static let fileName = "call-directory.json"
}

// Written by the extension after each load. Must match calldirectory/CallDirectoryHandler.swift.
struct CallDirectoryStatus: Codable {
    let loadedAt: Date
    let blocked: Int
    let labels: Int
    let fileFound: Bool

    static let fileName = "call-directory-status.json"
}

@MainActor
final class CallDirectorySync {
    static let extensionID = "com.aslavny.interhoot.calldirectory"

    private var fileURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: CallDirectoryList.appGroup)?
            .appendingPathComponent(CallDirectoryList.fileName)
    }

    /// Whether the user has switched InterHoot on under Settings > Apps > Phone > Call Blocking & Identification.
    func isEnabled() async -> Bool {
        let status = try? await CXCallDirectoryManager.sharedInstance
            .enabledStatusForExtension(withIdentifier: Self.extensionID)
        return status == .enabled
    }

    /// Opens the Call Blocking & Identification screen in Settings.
    func openSettings() async throws {
        try await CXCallDirectoryManager.sharedInstance.openSettings()
    }

    /// Set when the file changed but iOS has not reloaded the extension yet, so a failed reload is retried.
    private var needsReload = true

    /// Rewrites the list when the flagged numbers changed, then reloads the extension if it is enabled.
    func update(from flagged: [FlaggedNumber], force: Bool = false) async throws {
        guard let url = fileURL else { throw SyncError.noAppGroup }
        let data = try JSONEncoder().encode(Self.makeList(from: flagged))
        if (try? Data(contentsOf: url)) != data {
            try data.write(to: url, options: .atomic)
            needsReload = true
        }
        guard needsReload || force, await isEnabled() else { return }
        try await CXCallDirectoryManager.sharedInstance.reloadExtension(withIdentifier: Self.extensionID)
        needsReload = false
    }

    /// What the extension last handed to iOS (written by the extension itself), for the Blocked tab.
    func extensionStatus() -> CallDirectoryStatus? {
        guard let url = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: CallDirectoryList.appGroup)?
                .appendingPathComponent(CallDirectoryStatus.fileName),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(CallDirectoryStatus.self, from: data)
    }

    /// CallKit wants each list sorted ascending with no duplicates.
    static func makeList(from flagged: [FlaggedNumber]) -> CallDirectoryList {
        var blocked = Set<Int64>()
        var labels: [Int64: String] = [:]
        for number in flagged {
            guard let digits = Int64(number.e164.filter { $0.isASCII && $0.isNumber }) else { continue }
            switch number.flag {
            case "red":
                // Block only. Apple DTS flagged a number with both a blocking and an identification entry
                // as conflicting data (developer.apple.com/forums/thread/811182).
                blocked.insert(digits)
            case "yellow":
                labels[digits] = "InterHoot: Suspicious"
            default:
                break
            }
        }
        return CallDirectoryList(
            blocked: blocked.sorted(),
            labels: labels.keys.sorted().map { CallDirectoryList.Label(number: $0, label: labels[$0]!) }
        )
    }

    enum SyncError: LocalizedError {
        case noAppGroup
        var errorDescription: String? { "App Group group.com.aslavny.interhoot is not available to the app." }
    }
}
