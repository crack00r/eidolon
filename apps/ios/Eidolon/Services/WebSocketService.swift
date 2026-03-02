/// WebSocket client for communicating with the Eidolon Core gateway.
/// Uses `URLSessionWebSocketTask` (native iOS) with JSON-RPC 2.0 protocol.

import Foundation
import Combine

private let logCategory = "WebSocket"

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
    private var useTls: Bool = true

    // MARK: Internals

    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession = .shared
    private var requestCounter: Int = 0
    private var pendingRequests: [String: PendingRequestEntry] = [:]
    private var pushHandlers: [UUID: (String, [String: AnyCodable]) -> Void] = [:]
    private var shouldReconnect = false
    private var reconnectAttempts = 0
    private var reconnectWorkItem: DispatchWorkItem?

    /// Ring buffer of recent connection errors for phone-home reporting.
    private var errorRingBuffer: [ConnectionErrorEntry] = []
    private let errorRingBufferCapacity = 50

    private let maxReconnectDelay: TimeInterval = 30.0
    private let baseReconnectDelay: TimeInterval = 1.0
    private let requestTimeout: TimeInterval = 30.0
    private let maxReconnectAttempts = 50

    /// Whether the connection was authenticated with a token.
    private(set) var isAuthenticated: Bool = false

    // MARK: - Public API

    /// Regex for validating hostnames, IPv4, and IPv6 addresses.
    private static let hostRegex = try! NSRegularExpression(
        pattern: #"^(?:\[?[0-9a-fA-F:]+\]?|(?:[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)$"#
    )

    /// Configure the connection parameters.
    func configure(host: String, port: Int, token: String?, useTls: Bool = true) {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(trimmed.startIndex..., in: trimmed)
        guard !trimmed.isEmpty,
              Self.hostRegex.firstMatch(in: trimmed, range: range) != nil else {
            lastError = "Invalid hostname"
            connectionState = .error
            return
        }
        self.host = trimmed
        self.port = port
        self.token = token
        self.useTls = useTls
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
        isAuthenticated = false
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
    /// Returns the handler's UUID for later removal.
    @discardableResult
    func onPush(_ handler: @escaping (String, [String: AnyCodable]) -> Void) -> UUID {
        let id = UUID()
        pushHandlers[id] = handler
        return id
    }

    /// Remove a previously registered push handler by its UUID.
    func removePushHandler(_ id: UUID) {
        pushHandlers.removeValue(forKey: id)
    }

    // MARK: - Connection Lifecycle

    private func establishConnection() {
        connectionState = .connecting
        lastError = nil

        let scheme = useTls ? "wss" : "ws"
        let urlString = "\(scheme)://\(host):\(port)/ws"
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

        // Wait for the WebSocket to actually reach the running state before auth
        Task {
            let connected = await waitForTaskRunning(task: task, timeout: 5.0)

            guard connected, webSocketTask === task else {
                // Connection was cancelled or failed to open in time
                if webSocketTask === task {
                    connectionState = .error
                    lastError = "WebSocket failed to open"
                    webSocketTask?.cancel(with: .abnormalClosure, reason: nil)
                    webSocketTask = nil
                    scheduleReconnect()
                }
                return
            }

            reconnectAttempts = 0

            if let token, !token.isEmpty {
                connectionState = .authenticating
                do {
                    let _: AnyCodable? = try await rawCall(
                        method: GatewayMethod.authAuthenticate.rawValue,
                        params: ["token": token]
                    )
                    isAuthenticated = true
                    connectionState = .connected
                } catch {
                    isAuthenticated = false
                    connectionState = .error
                    lastError = "Authentication failed: \(error.localizedDescription)"
                    webSocketTask?.cancel(with: .normalClosure, reason: nil)
                    webSocketTask = nil
                    scheduleReconnect()
                }
            } else {
                isAuthenticated = false
                EidolonLogger.warning(category: logCategory, message: "Connecting without authentication token")
                connectionState = .connected
            }
        }
    }

    /// Poll until the WebSocket task reaches `.running` state or timeout expires.
    private func waitForTaskRunning(task: URLSessionWebSocketTask, timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        let pollInterval: UInt64 = 50_000_000 // 50ms

        while Date() < deadline {
            if task.state == .running {
                return true
            }
            if task.state == .canceling || task.state == .completed {
                return false
            }
            try? await Task.sleep(nanoseconds: pollInterval)
        }
        return task.state == .running
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
            EidolonLogger.warning(category: logCategory, message: "Malformed JSON message dropped: \(jsonString.prefix(200))")
            return
        }

        // Push notification (no id, has method)
        if response.id == nil, let method = response.method {
            let params = response.params ?? [:]
            for (_, handler) in pushHandlers {
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

        if let error {
            let errorMessage = error.localizedDescription
            EidolonLogger.error(category: logCategory, message: "Connection lost: \(errorMessage)")
            recordConnectionError(errorMessage)
        } else {
            EidolonLogger.info(category: logCategory, message: "Connection closed")
        }

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

        if reconnectAttempts >= maxReconnectAttempts {
            connectionState = .error
            lastError = "Maximum reconnect attempts (\(maxReconnectAttempts)) reached"
            return
        }

        let baseDelay = min(
            baseReconnectDelay * pow(2.0, Double(reconnectAttempts)),
            maxReconnectDelay
        )
        // Add random jitter (0-25% of base delay) to prevent thundering herd
        let jitter = Double.random(in: 0...(baseDelay * 0.25))
        let delay = baseDelay + jitter
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
        let count = pendingRequests.count
        for (_, pending) in pendingRequests {
            pending.timer.cancel()
            pending.continuation.resume(throwing: WebSocketError.disconnected(reason: reason))
        }
        pendingRequests.removeAll()
        if count > 0 {
            EidolonLogger.warning(category: logCategory, message: "Rejected \(count) pending request(s): \(reason)")
        }
    }

    // MARK: - Error Ring Buffer

    /// Record a connection error for phone-home reporting.
    private func recordConnectionError(_ message: String) {
        let entry = ConnectionErrorEntry(timestamp: Date(), message: message)
        errorRingBuffer.append(entry)
        if errorRingBuffer.count > errorRingBufferCapacity {
            errorRingBuffer.removeFirst(errorRingBuffer.count - errorRingBufferCapacity)
        }
    }

    /// Retrieve recent connection errors for diagnostic reporting.
    func getRecentConnectionErrors() -> [ConnectionErrorEntry] {
        errorRingBuffer
    }

    /// Clear recorded connection errors.
    func clearConnectionErrors() {
        errorRingBuffer.removeAll()
    }
}

// MARK: - PendingRequestEntry

private struct PendingRequestEntry {
    let continuation: CheckedContinuation<AnyCodable?, Error>
    let timer: DispatchWorkItem
}

// MARK: - ConnectionErrorEntry

/// A recorded connection error with timestamp.
struct ConnectionErrorEntry {
    let timestamp: Date
    let message: String
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
