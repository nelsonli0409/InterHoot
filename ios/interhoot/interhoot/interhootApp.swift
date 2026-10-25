//
//  interhootApp.swift
//  interhoot
//
//  Created by Alexander Slavny on 10/24/26.
//

import SwiftUI

@main
struct interhootApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
