/// Network discovery service for finding Eidolon servers.
///
/// Combines two discovery strategies:
/// 1. **Bonjour/mDNS**: Discovers `_eidolon._tcp` services via Apple's Network framework.
/// 2. **UDP Broadcast Listener**: Listens for JSON beacons on UDP port 41920.
///
/// The `NetworkManager` handles Bonjour discovery. This service adds the UDP
/// beacon listener and provides a unified `DiscoveredServer` model.

import Foundation
import Network
import Combine

private let logCategory = "Discovery"

// MARK: - DiscoveredServer

/// A discovered Eidolon server with connection details.
struct DiscoveredServer: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let host: String
    let port: Int
    let version: String
    let tailscaleIp: String?
    let tls: Bool
    let discoveryMethod: DiscoveryMethod
    let discoveredAt: Date
    var lastSeenAt: Date

    static func == (lhs: DiscoveredServer, rhs: DiscoveredServer) -> Bool {
        lhs.host == rhs.host && lhs.port == rhs.port
    }
}

enum DiscoveryMethod: String {
    case bonjour = "Bonjour"
    case udpBeacon = "UDP Beacon"
    case tailscale = "Tailscale"
    case cloudflare = "Cloudflare"
    case manual = "Manual"
}

// MARK: - Beacon Payload

/// JSON structure broadcast by the Eidolon server on UDP port 41920.
private struct BeaconPayload: Decodable {
    let service: String
    let version: String
    let hostname: String
    let host: String
    let port: Int
    let tailscaleIp: String?
    let tls: Bool
    let role: String
    let startedAt: Int
}

/// Signed beacon wrapper with HMAC authentication.
private struct SignedBeaconPayload: Decodable {
    let beacon: BeaconPayload
    let nonce: String
    let hmac: String
}

// MARK: - DiscoveryService

@MainActor
final class DiscoveryService: ObservableObject {

    // MARK: Published state

    @Published private(set) var servers: [DiscoveredServer] = []
    @Published private(set) var isScanning = false

    // MARK: Configuration

    /// UDP broadcast port matching the server's DiscoveryBroadcaster.
    static let discoveryPort: NWEndpoint.Port = 41920

    /// How long (seconds) before a server is considered lost.
    private let serverExpirySeconds: TimeInterval = 20.0

    // MARK: Internals

    private var udpListener: NWListener?
    private var expiryTimer: Timer?
    private let decoder = JSONDecoder()

    // MARK: - Public API

    /// Start listening for UDP broadcast beacons.
    func startListening() {
        guard udpListener == nil else { return }
        isScanning = true

        EidolonLogger.info(category: logCategory, message: "Starting UDP beacon listener on port \(Self.discoveryPort)")

        do {
            let params = NWParameters.udp
            params.allowLocalEndpointReuse = true

            let listener = try NWListener(using: params, on: Self.discoveryPort)

            listener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    switch state {
                    case .ready:
                        EidolonLogger.debug(category: logCategory, message: "UDP listener ready")
                    case .failed(let error):
                        EidolonLogger.error(category: logCategory, message: "UDP listener failed: \(error)")
                        self?.stopListening()
                    case .cancelled:
                        EidolonLogger.debug(category: logCategory, message: "UDP listener cancelled")
                    default:
                        break
                    }
                }
            }

            listener.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in
                    self?.handleConnection(connection)
                }
            }

            listener.start(queue: .main)
            udpListener = listener

            // Start expiry timer
            expiryTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    self?.pruneExpiredServers()
                }
            }
        } catch {
            EidolonLogger.error(category: logCategory, message: "Failed to start UDP listener: \(error)")
            isScanning = false
        }
    }

    /// Stop listening for beacons.
    func stopListening() {
        udpListener?.cancel()
        udpListener = nil
        expiryTimer?.invalidate()
        expiryTimer = nil
        isScanning = false
        EidolonLogger.info(category: logCategory, message: "UDP beacon listener stopped")
    }

    /// Add a manually discovered server (e.g., from Bonjour or manual entry).
    func addManualServer(name: String, host: String, port: Int, method: DiscoveryMethod) {
        let server = DiscoveredServer(
            name: name,
            host: host,
            port: port,
            version: "unknown",
            tailscaleIp: nil,
            tls: false,
            discoveryMethod: method,
            discoveredAt: Date(),
            lastSeenAt: Date()
        )
        upsertServer(server)
    }

    // MARK: - UDP Connection Handling

    private func handleConnection(_ connection: NWConnection) {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                Task { @MainActor in
                    self?.receiveData(on: connection)
                }
            case .failed, .cancelled:
                connection.cancel()
            default:
                break
            }
        }
        connection.start(queue: .main)
    }

    private func receiveData(on connection: NWConnection) {
        connection.receiveMessage { [weak self] data, _, _, error in
            if let error = error {
                EidolonLogger.debug(category: logCategory, message: "UDP receive error: \(error)")
                connection.cancel()
                return
            }

            Task { @MainActor in
                if let data = data {
                    self?.processBeaconData(data)
                }

                // Continue receiving
                self?.receiveData(on: connection)
            }
        }
    }

    private func processBeaconData(_ data: Data) {
        guard data.count <= 2048 else {
            EidolonLogger.debug(category: logCategory, message: "Oversized beacon dropped: \(data.count) bytes")
            return
        }

        // Try signed beacon first, then plain beacon
        let beacon: BeaconPayload

        if let signed = try? decoder.decode(SignedBeaconPayload.self, from: data) {
            guard signed.beacon.service == "eidolon" else { return }
            beacon = signed.beacon
        } else if let plain = try? decoder.decode(BeaconPayload.self, from: data) {
            guard plain.service == "eidolon" else { return }
            beacon = plain
        } else {
            return
        }

        let server = DiscoveredServer(
            name: beacon.hostname,
            host: beacon.host,
            port: beacon.port,
            version: beacon.version,
            tailscaleIp: beacon.tailscaleIp,
            tls: beacon.tls,
            discoveryMethod: .udpBeacon,
            discoveredAt: Date(),
            lastSeenAt: Date()
        )

        Task { @MainActor in
            self.upsertServer(server)
        }
    }

    // MARK: - Server Management

    private func upsertServer(_ server: DiscoveredServer) {
        if let index = servers.firstIndex(where: { $0.host == server.host && $0.port == server.port }) {
            servers[index].lastSeenAt = Date()
        } else {
            servers.append(server)
            EidolonLogger.info(
                category: logCategory,
                message: "Discovered server: \(server.name) at \(server.host):\(server.port) via \(server.discoveryMethod.rawValue)"
            )
        }
    }

    private func pruneExpiredServers() {
        let cutoff = Date().addingTimeInterval(-serverExpirySeconds)
        let before = servers.count
        servers.removeAll { $0.lastSeenAt < cutoff }
        let removed = before - servers.count
        if removed > 0 {
            EidolonLogger.debug(category: logCategory, message: "Pruned \(removed) expired server(s)")
        }
    }
}
