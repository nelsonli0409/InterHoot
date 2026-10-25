import Foundation
import CallKit

// Build guide C5, app side. Writes red and yellow numbers into the App Group container and asks
// iOS to reload the calldirectory extension. Red numbers are blocked and labelled; yellow ones are
// only labelled. Must match CallDirectoryList in calldirectory/CallDirectoryHandler.swift.
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

    /// Rewrites the list when the flagged numbers changed, then reloads the extension if it is enabled.
    func update(from flagged: [FlaggedNumber]) async throws {
        guard let url = fileURL else { throw SyncError.noAppGroup }
        let list = Self.makeList(from: flagged)
        let data = try JSONEncoder().encode(list)
        if let old = try? Data(contentsOf: url), old == data { return }
        try data.write(to: url, options: .atomic)
        // iOS reads the file itself when the user switches the extension on, so skip the reload until then.
        if await isEnabled() {
            try await CXCallDirectoryManager.sharedInstance.reloadExtension(withIdentifier: Self.extensionID)
        }
    }

    /// CallKit wants each list sorted ascending with no duplicates.
    static func makeList(from flagged: [FlaggedNumber]) -> CallDirectoryList {
        var blocked = Set<Int64>()
        var labels: [Int64: String] = [:]
        for number in flagged {
            guard let digits = Int64(number.e164.filter { $0.isASCII && $0.isNumber }) else { continue }
            switch number.flag {
            case "red":
                blocked.insert(digits)
                labels[digits] = "InterHoot: Scam"
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
