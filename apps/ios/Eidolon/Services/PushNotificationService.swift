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
                print("[PushNotificationService] Notification permission granted")
            } else {
                print("[PushNotificationService] Notification permission denied")
            }
        } catch {
            print("[PushNotificationService] Failed to request permission: \(error)")
        }
    }

    /// Register for remote (push) notifications.
    ///
    /// **Not activated** — requires Apple Developer Account for APNs configuration.
    /// When ready, uncomment the `UIApplication.shared.registerForRemoteNotifications()` call
    /// and implement the `AppDelegate` methods for token handling.
    func registerForRemoteNotifications() {
        print("""
        [PushNotificationService] APNs registration is NOT ACTIVE.
        To activate:
          1. Enroll in the Apple Developer Program
          2. Enable Push Notifications in Xcode capabilities
          3. Configure APNs key/certificate
          4. Uncomment the registration call in PushNotificationService.swift
        """)

        // Uncomment when Apple Developer Account is available:
        // UIApplication.shared.registerForRemoteNotifications()
    }

    /// Called when APNs returns a device token (via AppDelegate bridge).
    func didRegisterForRemoteNotifications(deviceToken data: Data) {
        let token = data.map { String(format: "%02.2hhx", $0) }.joined()
        self.deviceToken = token
        print("[PushNotificationService] Device token: \(token)")

        // TODO: Send token to Eidolon Core server via WebSocket
        // webSocketService.call("push.register", params: ["token": token, "platform": "ios"])
    }

    /// Called when APNs registration fails.
    func didFailToRegisterForRemoteNotifications(error: Error) {
        print("[PushNotificationService] Failed to register: \(error.localizedDescription)")
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
                print("[PushNotificationService] Local notification error: \(error)")
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
