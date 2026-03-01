/// Network discovery service for finding the Eidolon Core server.
/// Priority: Bonjour (LAN) -> Tailscale IP -> Cloudflare Tunnel -> Manual.

import Foundation
import Network
import Combine

// MARK: - Connection Method

enum ConnectionMethod: String, CaseIterable, Identifiable {
    case bonjour    = "Bonjour (Local)"
    case tailscale  = "Tailscale"
    case cloudflare = "Cloudflare Tunnel"
    case manual     = "Manual"

    var id: String { rawValue }
}

// MARK: - NetworkManager

@MainActor
final class NetworkManager: ObservableObject {

    // MARK: Published state

    @Published private(set) var discoveredHost: String?
    @Published private(set) var connectionMethod: ConnectionMethod = .manual
    @Published private(set) var isDiscovering = false
    @Published private(set) var discoveredEndpoints: [DiscoveredEndpoint] = []

    // MARK: Configuration (set from Settings)

    var tailscaleHost: String = ""
    var cloudflareUrl: String = ""

    // MARK: Internals

    private var browser: NWBrowser?
    private let bonjourType = "_eidolon._tcp"

    // MARK: - Public API

    /// Start discovery across all methods (Bonjour first, then fallback).
    func startDiscovery() {
        isDiscovering = true
        discoveredEndpoints = []
        discoveredHost = nil

        startBonjourBrowse()

        // After a delay, check Tailscale and Cloudflare if Bonjour hasn't found anything
        Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000) // 3 seconds
            if discoveredHost == nil {
                await tryTailscale()
            }
            if discoveredHost == nil {
                await tryCloudflare()
            }
            isDiscovering = false
        }
    }

    /// Stop all discovery.
    func stopDiscovery() {
        browser?.cancel()
        browser = nil
        isDiscovering = false
    }

    /// Manually set a host.
    func setManualHost(_ host: String) {
        discoveredHost = host
        connectionMethod = .manual
    }

    // MARK: - Bonjour Discovery

    private func startBonjourBrowse() {
        browser?.cancel()

        let params = NWParameters()
        params.includePeerToPeer = true

        let descriptor = NWBrowser.Descriptor.bonjour(type: bonjourType, domain: nil)
        let newBrowser = NWBrowser(for: descriptor, using: params)

        newBrowser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                switch state {
                case .failed(let error):
                    #if DEBUG
                    print("[NetworkManager] Bonjour browse failed: \(error)")
                    #endif
                    self?.browser?.cancel()
                    self?.browser = nil
                default:
                    break
                }
            }
        }

        newBrowser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                guard let self else { return }
                for result in results {
                    if case .service(let name, let type, let domain, _) = result.endpoint {
                        let endpoint = DiscoveredEndpoint(
                            name: name,
                            type: type,
                            domain: domain,
                            method: .bonjour
                        )
                        if !self.discoveredEndpoints.contains(where: { $0.name == name }) {
                            self.discoveredEndpoints.append(endpoint)
                        }

                        // Resolve to IP via NWConnection
                        self.resolveBonjourService(result: result)
                    }
                }
            }
        }

        newBrowser.start(queue: .main)
        browser = newBrowser
    }

    private func resolveBonjourService(result: NWBrowser.Result) {
        let connection = NWConnection(to: result.endpoint, using: .tcp)
        connection.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .ready:
                    if let innerEndpoint = connection.currentPath?.remoteEndpoint,
                       case .hostPort(let host, _) = innerEndpoint {
                        let hostString = "\(host)"
                        self.discoveredHost = hostString
                        self.connectionMethod = .bonjour
                    }
                    connection.cancel()
                case .failed, .cancelled:
                    connection.cancel()
                default:
                    break
                }
            }
        }
        connection.start(queue: .main)
    }

    // MARK: - Tailscale

    private func tryTailscale() async {
        guard !tailscaleHost.isEmpty else { return }

        // Attempt a TCP connection to verify reachability
        let reachable = await checkReachability(host: tailscaleHost, port: 8419)
        if reachable {
            discoveredHost = tailscaleHost
            connectionMethod = .tailscale
        }
    }

    // MARK: - Cloudflare Tunnel

    private func tryCloudflare() async {
        guard !cloudflareUrl.isEmpty else { return }

        // Extract host from the tunnel URL
        guard let url = URL(string: cloudflareUrl),
              let host = url.host else { return }

        let port = url.port ?? 443
        let reachable = await checkReachability(host: host, port: port)
        if reachable {
            discoveredHost = cloudflareUrl
            connectionMethod = .cloudflare
        }
    }

    // MARK: - Reachability Check

    private func checkReachability(host: String, port: Int) async -> Bool {
        await withCheckedContinuation { continuation in
            let nwHost = NWEndpoint.Host(host)
            let nwPort = NWEndpoint.Port(integerLiteral: NWEndpoint.Port.IntegerLiteralType(port))
            let connection = NWConnection(host: nwHost, port: nwPort, using: .tcp)

            var completed = false

            let timeout = DispatchWorkItem {
                guard !completed else { return }
                completed = true
                connection.cancel()
                continuation.resume(returning: false)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.0, execute: timeout)

            connection.stateUpdateHandler = { state in
                guard !completed else { return }
                switch state {
                case .ready:
                    completed = true
                    timeout.cancel()
                    connection.cancel()
                    continuation.resume(returning: true)
                case .failed, .cancelled:
                    completed = true
                    timeout.cancel()
                    connection.cancel()
                    continuation.resume(returning: false)
                default:
                    break
                }
            }
            connection.start(queue: .main)
        }
    }
}

// MARK: - DiscoveredEndpoint

struct DiscoveredEndpoint: Identifiable {
    let id = UUID()
    let name: String
    let type: String
    let domain: String
    let method: ConnectionMethod
}
