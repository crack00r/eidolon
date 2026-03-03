/// Learning state management -- fetches pending discoveries from
/// the Eidolon Core and supports approve/reject actions.

import Foundation
import Combine

@MainActor
final class LearningViewModel: ObservableObject {

    // MARK: Published state

    @Published private(set) var items: [LearningItem] = []
    @Published private(set) var isLoading: Bool = false
    @Published private(set) var isActing: Bool = false
    @Published private(set) var errorMessage: String?

    // MARK: Dependencies

    private weak var webSocketService: WebSocketService?

    // MARK: - Initialization

    func bind(to service: WebSocketService) {
        webSocketService = service
    }

    // MARK: - Public API

    /// Fetch pending learning discoveries.
    func fetchPending() async {
        guard let service = webSocketService,
              service.connectionState == .connected else {
            errorMessage = "Not connected to gateway"
            return
        }

        isLoading = true
        errorMessage = nil

        do {
            let response: LearningListResponse = try await service.call(
                method: GatewayMethod.learningList.rawValue,
                params: ["status": "pending"]
            )
            items = response.items
        } catch {
            errorMessage = ChatViewModel.sanitizeError(error)
        }

        isLoading = false
    }

    /// Approve a discovery item.
    func approve(id: String) async -> Bool {
        guard let service = webSocketService,
              service.connectionState == .connected else {
            errorMessage = "Not connected to gateway"
            return false
        }

        isActing = true
        errorMessage = nil

        do {
            let _: AnyCodable? = try await service.call(
                method: GatewayMethod.learningApprove.rawValue,
                params: ["id": id]
            )
            items.removeAll { $0.id == id }
            isActing = false
            return true
        } catch {
            errorMessage = ChatViewModel.sanitizeError(error)
            isActing = false
            return false
        }
    }

    /// Reject a discovery item.
    func reject(id: String) async -> Bool {
        guard let service = webSocketService,
              service.connectionState == .connected else {
            errorMessage = "Not connected to gateway"
            return false
        }

        isActing = true
        errorMessage = nil

        do {
            let _: AnyCodable? = try await service.call(
                method: GatewayMethod.learningReject.rawValue,
                params: ["id": id]
            )
            items.removeAll { $0.id == id }
            isActing = false
            return true
        } catch {
            errorMessage = ChatViewModel.sanitizeError(error)
            isActing = false
            return false
        }
    }
}

// MARK: - Models

struct LearningItem: Identifiable, Decodable {
    let id: String
    let title: String
    let description: String
    let source: String
    let relevanceScore: Double
    let safety: SafetyClassification
    let discoveredAt: Date
    let status: String

    var sourceIcon: String {
        switch source.lowercased() {
        case "reddit":      return "r.circle"
        case "hackernews":  return "newspaper"
        case "github":      return "chevron.left.forwardslash.chevron.right"
        case "rss":         return "dot.radiowaves.left.and.right"
        default:            return "globe"
        }
    }

    var safetyColor: Color {
        switch safety {
        case .safe:     return EidolonColors.success
        case .review:   return EidolonColors.warning
        case .unsafe:   return EidolonColors.error
        }
    }
}

enum SafetyClassification: String, Decodable {
    case safe
    case review
    case unsafe
}

private struct LearningListResponse: Decodable {
    let items: [LearningItem]
}

import SwiftUI
