/// Eidolon iOS — App entry point.
/// Initializes shared services and injects them into the SwiftUI environment.

import SwiftUI

@main
struct EidolonApp: App {
    @StateObject private var webSocketService = WebSocketService()
    @StateObject private var networkManager = NetworkManager()
    @StateObject private var pushNotificationService = PushNotificationService()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(webSocketService)
                .environmentObject(networkManager)
                .environmentObject(pushNotificationService)
                .preferredColorScheme(.dark)
        }
    }
}
