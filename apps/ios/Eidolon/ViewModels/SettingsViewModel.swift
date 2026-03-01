/// Settings state management — persists connection settings
/// and coordinates with WebSocketService and NetworkManager.

import Foundation
import Security
import Combine

@MainActor
final class SettingsViewModel: ObservableObject {

    // MARK: Published state (persisted via UserDefaults except token)

    @Published var host: String {
        didSet { UserDefaults.standard.set(host, forKey: Keys.host) }
    }

    @Published var port: Int {
        didSet { UserDefaults.standard.set(port, forKey: Keys.port) }
    }

    @Published var token: String {
        didSet { KeychainHelper.save(key: Keys.token, value: token) }
    }

    @Published var tailscaleHost: String {
        didSet { UserDefaults.standard.set(tailscaleHost, forKey: Keys.tailscaleHost) }
    }

    @Published var useTls: Bool {
        didSet { UserDefaults.standard.set(useTls, forKey: Keys.useTls) }
    }

    @Published var cloudflareUrl: String {
        didSet { UserDefaults.standard.set(cloudflareUrl, forKey: Keys.cloudflareUrl) }
    }

    @Published private(set) var serverVersion: String?
    @Published private(set) var isTestingConnection: Bool = false
    @Published private(set) var testResult: String?

    // MARK: Dependencies

    private weak var webSocketService: WebSocketService?
    private weak var networkManager: NetworkManager?

    // MARK: - Initialization

    init() {
        self.host = UserDefaults.standard.string(forKey: Keys.host) ?? "127.0.0.1"
        self.port = UserDefaults.standard.integer(forKey: Keys.port).nonZero ?? 8419
        self.token = KeychainHelper.load(key: Keys.token) ?? ""
        self.useTls = UserDefaults.standard.object(forKey: Keys.useTls) == nil
            ? true
            : UserDefaults.standard.bool(forKey: Keys.useTls)
        self.tailscaleHost = UserDefaults.standard.string(forKey: Keys.tailscaleHost) ?? ""
        self.cloudflareUrl = UserDefaults.standard.string(forKey: Keys.cloudflareUrl) ?? ""
    }

    func bind(webSocket: WebSocketService, network: NetworkManager) {
        self.webSocketService = webSocket
        self.networkManager = network
    }

    // MARK: - Public API

    /// Apply settings and connect.
    func connect() {
        guard let service = webSocketService else { return }
        service.configure(host: host, port: port, token: token.isEmpty ? nil : token, useTls: useTls)
        service.connect()

        // Update network manager with Tailscale/Cloudflare settings
        networkManager?.tailscaleHost = tailscaleHost
        networkManager?.cloudflareUrl = cloudflareUrl
    }

    /// Disconnect from the server.
    func disconnect() {
        webSocketService?.disconnect()
    }

    /// Test the connection by calling system.health.
    func testConnection() async {
        guard let service = webSocketService else {
            testResult = "No WebSocket service"
            return
        }

        isTestingConnection = true
        testResult = nil

        // Temporarily connect if needed
        let wasDisconnected = service.connectionState == .disconnected
        if wasDisconnected {
            service.configure(host: host, port: port, token: token.isEmpty ? nil : token, useTls: useTls)
            service.connect()
            // Wait for connection
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }

        do {
            let health: HealthResponse = try await service.call(
                method: GatewayMethod.systemHealth.rawValue
            )
            testResult = "Connected — status: \(health.status)"
            serverVersion = health.version
        } catch {
            testResult = "Failed: \(error.localizedDescription)"
        }

        if wasDisconnected {
            service.disconnect()
        }

        isTestingConnection = false
    }

    /// Start network discovery.
    func startDiscovery() {
        networkManager?.tailscaleHost = tailscaleHost
        networkManager?.cloudflareUrl = cloudflareUrl
        networkManager?.startDiscovery()
    }

    /// Apply a discovered host.
    func applyDiscoveredHost(_ discoveredHost: String) {
        host = discoveredHost
    }

    // MARK: - UserDefaults Keys

    private enum Keys {
        static let host = "eidolon.host"
        static let port = "eidolon.port"
        static let token = "eidolon.token"
        static let useTls = "eidolon.useTls"
        static let tailscaleHost = "eidolon.tailscaleHost"
        static let cloudflareUrl = "eidolon.cloudflareUrl"
    }
}

// MARK: - HealthResponse

private struct HealthResponse: Decodable {
    let status: String
    let version: String?
}

// MARK: - KeychainHelper

/// Minimal Keychain wrapper for storing the auth token securely.
enum KeychainHelper {

    static func save(key: String, value: String) {
        guard let data = value.data(using: .utf8) else { return }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: "com.eidolon.ios",
        ]

        // Delete existing item
        SecItemDelete(query as CFDictionary)

        // Add new item with restrictive access flags:
        // - Only accessible when the device is unlocked
        // - Never migrated to other devices via backup/transfer
        var addQuery = query
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    static func load(key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: "com.eidolon.ios",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: "com.eidolon.ios",
        ]
        SecItemDelete(query as CFDictionary)
    }
}

// MARK: - Int extension

private extension Int {
    /// Returns nil if zero (useful for UserDefaults integer defaults).
    var nonZero: Int? {
        self == 0 ? nil : self
    }
}
