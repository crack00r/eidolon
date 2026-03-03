/// Memory state management — searches the Eidolon memory engine
/// via WebSocket with debounced queries.

import Foundation
import Combine

@MainActor
final class MemoryViewModel: ObservableObject {

    // MARK: Published state

    @Published var searchQuery: String = ""
    @Published private(set) var results: [MemoryItem] = []
    @Published private(set) var isSearching: Bool = false
    @Published private(set) var isDeleting: Bool = false
    @Published private(set) var isEditing: Bool = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var totalCount: Int = 0
    @Published var selectedItem: MemoryItem?

    // MARK: Dependencies

    private weak var webSocketService: WebSocketService?
    private var searchTask: Task<Void, Never>?
    private var debounceTask: Task<Void, Never>?

    // MARK: - Initialization

    func bind(to service: WebSocketService) {
        webSocketService = service
    }

    // MARK: - Public API

    /// Trigger a debounced search (called when searchQuery changes).
    func searchDebounced() {
        debounceTask?.cancel()
        debounceTask = Task {
            try? await Task.sleep(nanoseconds: 500_000_000) // 500ms debounce
            guard !Task.isCancelled else { return }
            await search()
        }
    }

    /// Execute an immediate search with the current query.
    func search() async {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !query.isEmpty else {
            results = []
            totalCount = 0
            errorMessage = nil
            return
        }

        guard let service = webSocketService,
              service.connectionState == .connected else {
            errorMessage = "Not connected to gateway"
            return
        }

        // Cancel any in-flight search
        searchTask?.cancel()

        isSearching = true
        errorMessage = nil

        searchTask = Task {
            do {
                let response: MemorySearchResponse = try await service.call(
                    method: GatewayMethod.memorySearch.rawValue,
                    params: ["query": query, "limit": 50]
                )

                guard !Task.isCancelled else { return }

                results = response.items
                totalCount = response.totalCount
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = ChatViewModel.sanitizeError(error)
                results = []
                totalCount = 0
            }

            isSearching = false
        }
    }

    /// Clear search state.
    func clearSearch() {
        searchQuery = ""
        results = []
        totalCount = 0
        errorMessage = nil
        debounceTask?.cancel()
        searchTask?.cancel()
    }

    /// Refresh results with the current query.
    func refresh() async {
        await search()
    }

    // MARK: - Delete

    /// Delete a memory item by ID.
    func deleteMemory(id: String) async -> Bool {
        guard let service = webSocketService,
              service.connectionState == .connected else {
            errorMessage = "Not connected to gateway"
            return false
        }

        isDeleting = true
        errorMessage = nil

        do {
            let _: AnyCodable? = try await service.call(
                method: GatewayMethod.memoryDelete.rawValue,
                params: ["id": id]
            )
            results.removeAll { $0.id == id }
            if selectedItem?.id == id {
                selectedItem = nil
            }
            isDeleting = false
            return true
        } catch {
            errorMessage = ChatViewModel.sanitizeError(error)
            isDeleting = false
            return false
        }
    }

    // MARK: - Edit

    /// Update a memory item's content and/or importance.
    func editMemory(id: String, content: String?, importance: Double?) async -> Bool {
        guard let service = webSocketService,
              service.connectionState == .connected else {
            errorMessage = "Not connected to gateway"
            return false
        }

        isEditing = true
        errorMessage = nil

        var params: [String: Any] = ["id": id]
        if let content { params["content"] = content }
        if let importance { params["importance"] = importance }

        do {
            let response: MemoryUpdateResponse = try await service.call(
                method: GatewayMethod.memoryUpdate.rawValue,
                params: params
            )
            // Update in results list
            if let index = results.firstIndex(where: { $0.id == id }) {
                results[index] = response.item
            }
            if selectedItem?.id == id {
                selectedItem = response.item
            }
            isEditing = false
            return true
        } catch {
            errorMessage = ChatViewModel.sanitizeError(error)
            isEditing = false
            return false
        }
    }
}

// MARK: - Response Types

private struct MemorySearchResponse: Decodable {
    let items: [MemoryItem]
    let totalCount: Int
}

private struct MemoryUpdateResponse: Decodable {
    let item: MemoryItem
}
