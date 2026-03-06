/// Dashboard state management -- polls system status and subscribes
/// to push updates from the Eidolon Core gateway.

import Foundation
import Combine

@MainActor
final class DashboardViewModel: ObservableObject {

    // MARK: Published state

    @Published private(set) var status: SystemStatus?
    @Published private(set) var isLoading: Bool = false
    @Published private(set) var errorMessage: String?

    // MARK: Dependencies

    private weak var webSocketService: WebSocketService?
    private var pushHandlerId: UUID?
    private var pollTimer: Timer?

    // MARK: - Initialization

    func bind(to service: WebSocketService) {
        webSocketService = service

        pushHandlerId = service.onPush { [weak self] method, params in
            Task { @MainActor in
                self?.handlePush(method: method, params: params)
            }
        }
    }

    deinit {
        pollTimer?.invalidate()
        let service = webSocketService
        let handlerId = pushHandlerId
        Task { @MainActor in
            if let id = handlerId {
                service?.removePushHandler(id)
            }
        }
    }

    // MARK: - Public API

    /// Start polling system status.
    func startPolling() {
        stopPolling()
        Task { await fetchStatus() }
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.fetchStatus()
            }
        }
    }

    /// Stop polling.
    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    /// One-off status fetch.
    func fetchStatus() async {
        guard let service = webSocketService,
              service.connectionState == .connected else {
            errorMessage = "Not connected to gateway"
            return
        }

        if status == nil { isLoading = true }
        errorMessage = nil

        do {
            let response: SystemStatus = try await service.call(
                method: GatewayMethod.systemStatus.rawValue,
                params: nil
            )
            status = response
        } catch {
            errorMessage = ChatViewModel.sanitizeError(error)
        }

        isLoading = false
    }

    // MARK: - Push Handling

    private func handlePush(method: String, params: [String: AnyCodable]) {
        guard method == "system.statusUpdate" else { return }

        // Decode status update from params
        do {
            let data = try JSONEncoder().encode(params.mapValues { $0 })
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .millisecondsSince1970
            let updated = try decoder.decode(SystemStatus.self, from: data)
            status = updated
        } catch {
            // Partial update failed, wait for next poll
        }
    }
}

// MARK: - System Status Model

struct SystemStatus: Decodable {
    let cognitiveState: String
    let energyUsed: Double
    let energyBudget: Double
    let activeTasks: Int
    let memoryCount: Int
    let uptimeMs: Int
    let connectedClients: Int
    let serverVersion: String?

    var energyPercent: Double {
        guard energyBudget > 0 else { return 0 }
        return min(energyUsed / energyBudget, 1.0)
    }

    var uptimeFormatted: String {
        let totalSeconds = uptimeMs / 1000
        let days = totalSeconds / 86400
        let hours = (totalSeconds % 86400) / 3600
        let minutes = (totalSeconds % 3600) / 60
        if days > 0 {
            return "\(days)d \(hours)h \(minutes)m"
        } else if hours > 0 {
            return "\(hours)h \(minutes)m"
        } else {
            return "\(minutes)m"
        }
    }

    var stateIcon: String {
        switch cognitiveState {
        case "idle":        return "moon.zzz"
        case "perceiving":  return "eye"
        case "evaluating":  return "brain"
        case "acting":      return "bolt"
        case "reflecting":  return "sparkles"
        case "dreaming":    return "moon.stars"
        default:            return "questionmark.circle"
        }
    }

    var stateColor: Color {
        switch cognitiveState {
        case "idle":        return .secondary
        case "perceiving":  return EidolonColors.accent
        case "evaluating":  return EidolonColors.warning
        case "acting":      return EidolonColors.success
        case "reflecting":  return .purple
        case "dreaming":    return .indigo
        default:            return .secondary
        }
    }
}

import SwiftUI
