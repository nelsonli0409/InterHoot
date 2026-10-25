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

class CallDirectoryHandler: CXCallDirectoryProvider {

    override func beginRequest(with context: CXCallDirectoryExtensionContext) {
        context.delegate = self

        // The list is small, so every request (incremental or not) replaces the whole set.
        if context.isIncremental {
            context.removeAllBlockingEntries()
            context.removeAllIdentificationEntries()
        }

        let list = loadList()
        for number in list.blocked {
            context.addBlockingEntry(withNextSequentialPhoneNumber: number)
        }
        for entry in list.labels {
            context.addIdentificationEntry(withNextSequentialPhoneNumber: entry.number, label: entry.label)
        }

        context.completeRequest()
    }

    private func loadList() -> CallDirectoryList {
        guard let url = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: CallDirectoryList.appGroup)?
                .appendingPathComponent(CallDirectoryList.fileName),
              let data = try? Data(contentsOf: url),
              let list = try? JSONDecoder().decode(CallDirectoryList.self, from: data)
        else { return CallDirectoryList(blocked: [], labels: []) }
        return list
    }
}

extension CallDirectoryHandler: CXCallDirectoryExtensionContextDelegate {

    func requestFailed(for extensionContext: CXCallDirectoryExtensionContext, withError error: Error) {
        // Most likely cause: numbers out of order or duplicated. The app sorts and de-duplicates before writing.
        NSLog("InterHoot call directory request failed: \(error.localizedDescription)")
    }

}
