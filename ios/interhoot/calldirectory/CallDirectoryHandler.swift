//
//  CallDirectoryHandler.swift
//  calldirectory
//
//  Created by Alexander Slavny on 10/24/26.
//

import Foundation
import CallKit

// Build guide C5. The app writes call-directory.json into the shared App Group container
// (see CallDirectorySync.swift in the app target); this extension reads it and hands the
// numbers to iOS. Numbers are E.164 digits with the country code (+14155551234 -> 14155551234),
// already sorted ascending, which CallKit requires.
struct CallDirectoryList: Codable {
    struct Label: Codable {
        let number: Int64
        let label: String
    }
    let blocked: [Int64]
    let labels: [Label]

    static let appGroup = "group.com.aslavny.interhoot"
    static let fileName = "call-directory.json"
}

// Written after each load so the app can show what iOS actually received.
struct CallDirectoryStatus: Codable {
    let loadedAt: Date
    let blocked: Int
    let labels: Int
    let fileFound: Bool

    static let fileName = "call-directory-status.json"
}

class CallDirectoryHandler: CXCallDirectoryProvider {

    override func beginRequest(with context: CXCallDirectoryExtensionContext) {
        context.delegate = self

        // The list is small, so every request (incremental or not) replaces the whole set.
        if context.isIncremental {
            context.removeAllBlockingEntries()
            context.removeAllIdentificationEntries()
        }

        let (list, fileFound) = loadList()
        for number in list.blocked {
            context.addBlockingEntry(withNextSequentialPhoneNumber: number)
        }
        for entry in list.labels {
            context.addIdentificationEntry(withNextSequentialPhoneNumber: entry.number, label: entry.label)
        }

        writeStatus(CallDirectoryStatus(loadedAt: Date(), blocked: list.blocked.count,
                                        labels: list.labels.count, fileFound: fileFound))
        context.completeRequest()
    }

    private var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: CallDirectoryList.appGroup)
    }

    private func loadList() -> (CallDirectoryList, Bool) {
        guard let url = container?.appendingPathComponent(CallDirectoryList.fileName),
              let data = try? Data(contentsOf: url),
              let list = try? JSONDecoder().decode(CallDirectoryList.self, from: data)
        else { return (CallDirectoryList(blocked: [], labels: []), false) }
        return (list, true)
    }

    private func writeStatus(_ status: CallDirectoryStatus) {
        guard let url = container?.appendingPathComponent(CallDirectoryStatus.fileName),
              let data = try? JSONEncoder().encode(status) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

extension CallDirectoryHandler: CXCallDirectoryExtensionContextDelegate {

    func requestFailed(for extensionContext: CXCallDirectoryExtensionContext, withError error: Error) {
        // Most likely cause: numbers out of order or duplicated. The app sorts and de-duplicates before writing.
        NSLog("InterHoot call directory request failed: \(error.localizedDescription)")
    }

}
