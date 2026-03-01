/// Memory browser — search bar with results list.

import SwiftUI

struct MemoryView: View {
    @EnvironmentObject var webSocketService: WebSocketService
    @StateObject private var viewModel = MemoryViewModel()

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                searchBar
                resultsList
            }
            .background(EidolonColors.background)
            .navigationTitle("Memory")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    ConnectionStatusBadge(state: webSocketService.connectionState)
                }
            }
            .onAppear {
                viewModel.bind(to: webSocketService)
            }
        }
    }

    // MARK: - Search Bar

    private var searchBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(.secondary)

            TextField("Search memories...", text: $viewModel.searchQuery)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .onChange(of: viewModel.searchQuery) {
                    // Enforce max search query length (500 chars)
                    if viewModel.searchQuery.count > 500 {
                        viewModel.searchQuery = String(viewModel.searchQuery.prefix(500))
                    }
                    viewModel.searchDebounced()
                }

            if !viewModel.searchQuery.isEmpty {
                Button {
                    viewModel.clearSearch()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.secondary)
                }
            }

            if viewModel.isSearching {
                ProgressView()
                    .scaleEffect(0.8)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(EidolonColors.secondary)
        .cornerRadius(12)
        .padding(.horizontal, 16)
        .padding(.top, 12)
    }

    // MARK: - Results List

    private var resultsList: some View {
        Group {
            if let error = viewModel.errorMessage {
                errorView(message: error)
            } else if viewModel.results.isEmpty && !viewModel.searchQuery.isEmpty && !viewModel.isSearching {
                emptyStateView
            } else if viewModel.results.isEmpty && viewModel.searchQuery.isEmpty {
                promptView
            } else {
                List {
                    ForEach(viewModel.results) { item in
                        MemoryItemRow(item: item)
                    }
                    .listRowBackground(EidolonColors.secondary)
                }
                .listStyle(.plain)
                .refreshable {
                    await viewModel.refresh()
                }
            }
        }
    }

    // MARK: - Empty States

    private var emptyStateView: some View {
        VStack(spacing: 12) {
            Image(systemName: "tray")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            Text("No results found")
                .font(.headline)
                .foregroundColor(.secondary)
            Text("Try a different search term")
                .font(.subheadline)
                .foregroundColor(.secondary.opacity(0.7))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var promptView: some View {
        VStack(spacing: 12) {
            Image(systemName: "brain")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            Text("Search Memories")
                .font(.headline)
                .foregroundColor(.secondary)
            Text("Type to search through Eidolon's memory")
                .font(.subheadline)
                .foregroundColor(.secondary.opacity(0.7))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorView(message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 48))
                .foregroundColor(EidolonColors.warning)
            Text(message)
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

// MARK: - Memory Item Row

struct MemoryItemRow: View {
    let item: MemoryItem

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: item.typeIcon)
                .font(.system(size: 20))
                .foregroundColor(EidolonColors.accent)
                .frame(width: 32, height: 32)

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(item.type.capitalized)
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundColor(EidolonColors.accent)

                    Spacer()

                    ImportanceBadge(importance: item.importance)
                }

                Text(item.content)
                    .font(.subheadline)
                    .foregroundColor(.primary)
                    .lineLimit(3)

                if !item.tags.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(item.tags.prefix(3), id: \.self) { tag in
                            Text(tag)
                                .font(.caption2)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.secondary.opacity(0.2))
                                .cornerRadius(4)
                        }
                    }
                }

                Text(item.createdAt, style: .relative)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Importance Badge

struct ImportanceBadge: View {
    let importance: Double

    var body: some View {
        Text(String(format: "%.0f%%", importance * 100))
            .font(.caption2)
            .fontWeight(.medium)
            .foregroundColor(badgeColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(badgeColor.opacity(0.15))
            .cornerRadius(4)
    }

    private var badgeColor: Color {
        if importance >= 0.8 {
            return EidolonColors.accent
        } else if importance >= 0.5 {
            return EidolonColors.warning
        } else {
            return .secondary
        }
    }
}
