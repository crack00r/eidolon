/// WebSocket client for communicating with the Eidolon Core gateway.
/// Uses `URLSessionWebSocketTask` (native iOS) with JSON-RPC 2.0 protocol.

import Foundation
import Combine

// MARK: - WebSocketService

@MainActor
final class WebSocketService: ObservableObject {

    // MARK: Published state

    @Published private(set) var connectionState: ConnectionState = .disconnected
    @Published private(set) var lastError: String?

    // MARK: Configuration

    private var host: String = "127.0.0.1"
    private var port: Int = 8419
    private var token: String?

    // MARK: Internals

    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession = .shared
    private var requestCounter: Int = 0
    private var pendingRequests: [String: PendingRequestEntry] = [:]
    private var pushHandlers: [(String, [String: AnyCodable]) -> Void] = []
    private var shouldReconnect = false
    private var reconnectAttempts = 0
    private var reconnectWorkItem: DispatchWorkItem?

    private let maxReconnectDelay: TimeInterval = 8.0
    private let baseReconnectDelay: TimeInterval = 1.0
    private let requestTimeout: TimeInterval = 30.0

    // MARK: - Public API

    /// Configure the connection parameters.
    func configure(host: String, port: Int, token: String?) {
        self.host = host
        self.port = port
        self.token = token
    }

    /// Open the WebSocket connection.
    func connect() {
        guard connectionState == .disconnected || connectionState == .error else { return }
        shouldReconnect = true
        reconnectAttempts = 0
        establishConnection()
    }

    /// Close the WebSocket connection.
    func disconnect() {
        shouldReconnect = false
        reconnectAttempts = 0
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil

        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil

        rejectAllPending(reason: "Client disconnected")
        connectionState = .disconnected
    }

    /// Send a JSON-RPC call and await the typed result.
    func call<T: Decodable>(method: String, params: [String: Any]? = nil) async throws -> T {
        guard connectionState == .connected else {
            throw WebSocketError.notConnected(state: connectionState)
        }

        let result = try await rawCall(method: method, params: params)

        let encoder = JSONEncoder()
        let data = try encoder.encode(result)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return try decoder.decode(T.self, from: data)
    }

    /// Register a handler for server push events.
    /// Returns a closure to unregister.
    func onPush(_ handler: @escaping (String, [String: AnyCodable]) -> Void) -> () -> Void {
        let id = UUID()
        pushHandlers.append(handler)
        let index = pushHandlers.count - 1
        return { [weak self] in
            guard let self else { return }
            // Safety: only remove if index is still valid
            guard index < self.pushHandlers.count else { return }
            self.pushHandlers.remove(at: index)
            _ = id // Retain id for identity
        }
    }

    // MARK: - Connection Lifecycle

    private func establishConnection() {
        connectionState = .connecting
        lastError = nil

        let urlString = "ws://\(host):\(port)"
        guard let url = URL(string: urlString) else {
            connectionState = .error
            lastError = "Invalid URL: \(urlString)"
            scheduleReconnect()
            return
        }

        let task = session.webSocketTask(with: url)
        webSocketTask = task
        task.resume()

        // Start receive loop (first successful receive confirms connection)
        listenForMessages()

        // Perform authentication after short delay for connection establishment
        Task {
            // Give the WebSocket a moment to connect
            try? await Task.sleep(nanoseconds: 200_000_000) // 200ms

            guard webSocketTask != nil else { return }

            reconnectAttempts = 0

            if let token, !token.isEmpty {
                connectionState = .authenticating
                do {
                    let _: AnyCodable? = try await rawCall(
                        method: GatewayMethod.authAuthenticate.rawValue,
                        params: ["token": token]
                    )
                    connectionState = .connected
                } catch {
                    connectionState = .error
                    lastError = "Authentication failed: \(error.localizedDescription)"
                    webSocketTask?.cancel(with: .normalClosure, reason: nil)
                    webSocketTask = nil
                    scheduleReconnect()
                }
            } else {
                connectionState = .connected
            }
        }
    }

    // MARK: - Message Handling

    private func listenForMessages() {
        webSocketTask?.receive { [weak self] result in
            guard let self else { return }

            switch result {
            case .success(let message):
                Task { @MainActor in
                    self.handleMessage(message)
                    self.listenForMessages()
                }

            case .failure(let error):
                Task { @MainActor in
                    self.handleDisconnect(error: error)
                }
            }
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        let jsonString: String
        switch message {
        case .string(let text):
            jsonString = text
        case .data(let data):
            guard let text = String(data: data, encoding: .utf8) else { return }
            jsonString = text
        @unknown default:
            return
        }

        guard let data = jsonString.data(using: .utf8),
              let response = try? JSONDecoder().decode(GatewayResponse.self, from: data) else {
            return
        }

        // Push notification (no id, has method)
        if response.id == nil, let method = response.method {
            let params = response.params ?? [:]
            for handler in pushHandlers {
                handler(method, params)
            }
            return
        }

        // Response to a pending request
        if let id = response.id, let pending = pendingRequests.removeValue(forKey: id) {
            pending.timer.cancel()

            if let error = response.error {
                pending.continuation.resume(
                    throwing: WebSocketError.rpcError(code: error.code, message: error.message)
                )
            } else {
                pending.continuation.resume(returning: response.result)
            }
        }
    }

    private func handleDisconnect(error: Error?) {
        webSocketTask = nil
        rejectAllPending(reason: "Connection closed")

        if shouldReconnect {
            connectionState = .disconnected
            lastError = error?.localizedDescription
            scheduleReconnect()
        } else {
            connectionState = .disconnected
        }
    }

    // MARK: - Raw RPC Call

    private func rawCall(method: String, params: [String: Any]?) async throws -> AnyCodable? {
        let id = nextRequestId()
        let codableParams = params?.mapValues { AnyCodable($0) }
        let request = GatewayRequest(id: id, method: method, params: codableParams)

        let data = try JSONEncoder().encode(request)
        guard let jsonString = String(data: data, encoding: .utf8) else {
            throw WebSocketError.encodingFailed
        }

        return try await withCheckedThrowingContinuation { continuation in
            let timer = DispatchWorkItem { [weak self] in
                Task { @MainActor in
                    self?.pendingRequests.removeValue(forKey: id)
                    continuation.resume(throwing: WebSocketError.timeout(method: method))
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + requestTimeout, execute: timer)

            pendingRequests[id] = PendingRequestEntry(continuation: continuation, timer: timer)

            webSocketTask?.send(.string(jsonString)) { [weak self] error in
                if let error {
                    Task { @MainActor in
                        timer.cancel()
                        self?.pendingRequests.removeValue(forKey: id)
                        continuation.resume(throwing: error)
                    }
                }
            }
        }
    }

    // MARK: - Reconnection

    private func scheduleReconnect() {
        guard shouldReconnect else { return }

        let delay = min(
            baseReconnectDelay * pow(2.0, Double(reconnectAttempts)),
            maxReconnectDelay
        )
        reconnectAttempts += 1

        let workItem = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                guard let self, self.shouldReconnect else { return }
                self.reconnectWorkItem = nil
                self.establishConnection()
            }
        }
        reconnectWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    // MARK: - Helpers

    private func nextRequestId() -> String {
        requestCounter += 1
        return "\(requestCounter)"
    }

    private func rejectAllPending(reason: String) {
        for (_, pending) in pendingRequests {
            pending.timer.cancel()
            pending.continuation.resume(throwing: WebSocketError.disconnected(reason: reason))
        }
        pendingRequests.removeAll()
    }
}

// MARK: - PendingRequestEntry

private struct PendingRequestEntry {
    let continuation: CheckedContinuation<AnyCodable?, Error>
    let timer: DispatchWorkItem
}

// MARK: - WebSocketError

enum WebSocketError: LocalizedError {
    case notConnected(state: ConnectionState)
    case encodingFailed
    case timeout(method: String)
    case rpcError(code: Int, message: String)
    case disconnected(reason: String)

    var errorDescription: String? {
        switch self {
        case .notConnected(let state):
            return "Cannot send request: connection state is \"\(state.rawValue)\""
        case .encodingFailed:
            return "Failed to encode JSON-RPC request"
        case .timeout(let method):
            return "Request timeout: \(method)"
        case .rpcError(let code, let message):
            return "RPC Error (\(code)): \(message)"
        case .disconnected(let reason):
            return "Disconnected: \(reason)"
        }
    }
}
