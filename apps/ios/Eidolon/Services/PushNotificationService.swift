/// Push notification service — stub implementation.
///
/// APNs (Apple Push Notification service) requires an Apple Developer Account
/// for provisioning profiles, certificates, and entitlements.
///
/// This service prepares the notification flow so it can be activated later:
/// 1. Enroll in the Apple Developer Program
/// 2. Enable Push Notifications capability in Xcode
/// 3. Generate APNs certificates or keys in the Developer Portal
/// 4. Configure the Eidolon Core server with the APNs key
/// 5. Remove the stub guards in this file
///
/// Until then, local notifications can still be used for in-app alerts.

import Foundation
import UserNotifications
import Combine

private let logCategory = "PushNotification"

@MainActor
final class PushNotificationService: ObservableObject {

    // MARK: Published state

    @Published private(set) var isPermissionGranted = false
    @Published private(set) var deviceToken: String?
    @Published private(set) var permissionStatus: UNAuthorizationStatus = .notDetermined

    // MARK: - Public API

    /// Request notification permission from the user.
    func requestPermission() async {
        let center = UNUserNotificationCenter.current()

        do {
            let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            isPermissionGranted = granted

            let settings = await center.notificationSettings()
            permissionStatus = settings.authorizationStatus

            if granted {
                EidolonLogger.info(category: logCategory, message: "Notification permission granted")
            } else {
                EidolonLogger.warning(category: logCategory, message: "Notification permission denied by user")
            }
        } catch {
            EidolonLogger.error(category: logCategory, message: "Failed to request notification permission: \(error.localizedDescription)")
        }
    }

    /// Register for remote (push) notifications.
    ///
    /// **Not activated** — requires Apple Developer Account for APNs configuration.
    /// When ready, uncomment the `UIApplication.shared.registerForRemoteNotifications()` call
    /// and implement the `AppDelegate` methods for token handling.
    func registerForRemoteNotifications() {
        EidolonLogger.info(category: logCategory, message: "APNs registration is NOT ACTIVE — requires Apple Developer Account")

        // Uncomment when Apple Developer Account is available:
        // UIApplication.shared.registerForRemoteNotifications()
    }

    /// Called when APNs returns a device token (via AppDelegate bridge).
    func didRegisterForRemoteNotifications(deviceToken data: Data) {
        let token = data.map { String(format: "%02.2hhx", $0) }.joined()
        self.deviceToken = token
        EidolonLogger.info(category: logCategory, message: "Registered for remote notifications (token length: \(token.count))")

        // TODO: Send token to Eidolon Core server via WebSocket
        // webSocketService.call("push.register", params: ["token": token, "platform": "ios"])
    }

    /// Called when APNs registration fails.
    func didFailToRegisterForRemoteNotifications(error: Error) {
        EidolonLogger.error(category: logCategory, message: "Failed to register for remote notifications: \(error.localizedDescription)")
    }

    // MARK: - Local Notifications (available without Developer Account)

    /// Schedule a local notification (useful for in-app alerts from the WebSocket).
    func scheduleLocalNotification(title: String, body: String, identifier: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.1, repeats: false)
        let id = identifier ?? UUID().uuidString
        let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)

        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                EidolonLogger.error(category: logCategory, message: "Failed to schedule local notification '\(id)': \(error.localizedDescription)")
            }
        }
    }

    /// Check current notification settings.
    func refreshPermissionStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        permissionStatus = settings.authorizationStatus
        isPermissionGranted = settings.authorizationStatus == .authorized
    }
}
