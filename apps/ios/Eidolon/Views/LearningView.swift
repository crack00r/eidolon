/// Learning dashboard -- shows pending discoveries with approve/reject actions.

import SwiftUI

struct LearningView: View {
    @EnvironmentObject var webSocketService: WebSocketService
    @StateObject private var viewModel = LearningViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.items.isEmpty {
                    loadingView
                } else if let error = viewModel.errorMessage, viewModel.items.isEmpty {
                    errorView(message: error)
                } else if viewModel.items.isEmpty {
                    emptyView
                } else {
                    itemsList
                }
            }
            .background(EidolonColors.background)
            .navigationTitle("Learning")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    ConnectionStatusBadge(state: webSocketService.connectionState)
                }
            }
            .onAppear {
                viewModel.bind(to: webSocketService)
                Task { await viewModel.fetchPending() }
            }
            .refreshable {
                await viewModel.fetchPending()
            }
        }
    }

    // MARK: - Items List

    private var itemsList: some View {
        List {
            ForEach(viewModel.items) { item in
                LearningItemRow(
                    item: item,
                    isActing: viewModel.isActing,
                    onApprove: {
                        Task { _ = await viewModel.approve(id: item.id) }
                    },
                    onReject: {
                        Task { _ = await viewModel.reject(id: item.id) }
                    }
                )
                .listRowBackground(EidolonColors.secondary)
            }
        }
        .listStyle(.plain)
    }

    // MARK: - Empty States

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading discoveries...")
                .font(.subheadline)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyView: some View {
        VStack(spacing: 12) {
            Image(systemName: "lightbulb")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
                .accessibilityHidden(true)
            Text("No Pending Discoveries")
                .font(.headline)
                .foregroundColor(.secondary)
            Text("Eidolon will notify you when it finds something interesting")
                .font(.subheadline)
                .foregroundColor(.secondary.opacity(0.7))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 32)
        .accessibilityElement(children: .combine)
    }

    private func errorView(message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 48))
                .foregroundColor(EidolonColors.warning)
                .accessibilityHidden(true)
            Text(message)
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Error: \(message)")
    }
}

// MARK: - Learning Item Row

struct LearningItemRow: View {
    let item: LearningItem
    let isActing: Bool
    let onApprove: () -> Void
    let onReject: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header: source icon + safety badge
            HStack {
                Image(systemName: item.sourceIcon)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .accessibilityHidden(true)
                Text(item.source.capitalized)
                    .font(.caption)
                    .foregroundColor(.secondary)

                Spacer()

                safetyBadge
            }

            // Title
            Text(item.title)
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundColor(.primary)
                .lineLimit(2)

            // Description
            Text(item.description)
                .font(.caption)
                .foregroundColor(.secondary)
                .lineLimit(3)

            // Footer: relevance score + date
            HStack {
                Label(String(format: "%.0f%%", item.relevanceScore * 100), systemImage: "target")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .accessibilityLabel("Relevance: \(String(format: "%.0f", item.relevanceScore * 100)) percent")

                Spacer()

                Text(item.discoveredAt, style: .relative)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            // Action buttons
            HStack(spacing: 12) {
                Button(action: onApprove) {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark")
                        Text("Approve")
                    }
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundColor(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .background(EidolonColors.success)
                    .cornerRadius(8)
                }
                .disabled(isActing)
                .accessibilityLabel("Approve")
                .accessibilityHint("Approve this discovery for implementation")
                .accessibilityIdentifier("approveButton_\(item.id)")

                Button(action: onReject) {
                    HStack(spacing: 4) {
                        Image(systemName: "xmark")
                        Text("Reject")
                    }
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundColor(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .background(Color.secondary.opacity(0.5))
                    .cornerRadius(8)
                }
                .disabled(isActing)
                .accessibilityLabel("Reject")
                .accessibilityHint("Dismiss this discovery")
                .accessibilityIdentifier("rejectButton_\(item.id)")

                Spacer()
            }
        }
        .padding(.vertical, 6)
    }

    private var safetyBadge: some View {
        Text(item.safety.rawValue.capitalized)
            .font(.caption2)
            .fontWeight(.medium)
            .foregroundColor(item.safetyColor)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(item.safetyColor.opacity(0.15))
            .cornerRadius(6)
            .accessibilityLabel("Safety: \(item.safety.rawValue)")
    }
}
