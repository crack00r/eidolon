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
    @Published private(set) var errorMessage: String?
    @Published private(set) var totalCount: Int = 0

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
                errorMessage = error.localizedDescription
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
}

// MARK: - Response Types

private struct MemorySearchResponse: Decodable {
    let items: [MemoryItem]
    let totalCount: Int
}
