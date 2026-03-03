/// Memory browser -- search bar with results list, detail view, edit/delete support.

import SwiftUI

struct MemoryView: View {
    @EnvironmentObject var webSocketService: WebSocketService
    @StateObject private var viewModel = MemoryViewModel()
    @State private var showDeleteAlert = false
    @State private var deleteTargetId: String?
    @State private var showEditSheet = false

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
            .alert("Delete Memory", isPresented: $showDeleteAlert) {
                Button("Cancel", role: .cancel) {
                    deleteTargetId = nil
                }
                Button("Delete", role: .destructive) {
                    guard let id = deleteTargetId else { return }
                    Task { _ = await viewModel.deleteMemory(id: id) }
                    deleteTargetId = nil
                }
            } message: {
                Text("Are you sure you want to permanently delete this memory? This action cannot be undone.")
            }
            .sheet(isPresented: $showEditSheet) {
                if let item = viewModel.selectedItem {
                    MemoryEditSheet(
                        item: item,
                        isEditing: viewModel.isEditing,
                        onSave: { content, importance in
                            Task {
                                let success = await viewModel.editMemory(
                                    id: item.id,
                                    content: content,
                                    importance: importance
                                )
                                if success {
                                    showEditSheet = false
                                }
                            }
                        },
                        onCancel: { showEditSheet = false }
                    )
                }
            }
        }
    }

    // MARK: - Search Bar

    private var searchBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(.secondary)
                .accessibilityHidden(true)

            TextField("Search memories...", text: $viewModel.searchQuery)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .accessibilityIdentifier("memorySearchField")
                .onChange(of: viewModel.searchQuery) {
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
                .accessibilityLabel("Clear search")
            }

            if viewModel.isSearching {
                ProgressView()
                    .scaleEffect(0.8)
                    .accessibilityLabel("Searching")
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
                        NavigationLink {
                            MemoryDetailView(
                                item: item,
                                onEdit: {
                                    viewModel.selectedItem = item
                                    showEditSheet = true
                                },
                                onDelete: {
                                    deleteTargetId = item.id
                                    showDeleteAlert = true
                                },
                                isDeleting: viewModel.isDeleting
                            )
                        } label: {
                            MemoryItemRow(item: item)
                        }
                    }
                    .onDelete { offsets in
                        guard let index = offsets.first else { return }
                        let item = viewModel.results[index]
                        deleteTargetId = item.id
                        showDeleteAlert = true
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
                .accessibilityHidden(true)
            Text("No results found")
                .font(.headline)
                .foregroundColor(.secondary)
            Text("Try a different search term")
                .font(.subheadline)
                .foregroundColor(.secondary.opacity(0.7))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    private var promptView: some View {
        VStack(spacing: 12) {
            Image(systemName: "brain")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
                .accessibilityHidden(true)
            Text("Search Memories")
                .font(.headline)
                .foregroundColor(.secondary)
            Text("Type to search through Eidolon's memory")
                .font(.subheadline)
                .foregroundColor(.secondary.opacity(0.7))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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

// MARK: - Memory Detail View

struct MemoryDetailView: View {
    let item: MemoryItem
    let onEdit: () -> Void
    let onDelete: () -> Void
    let isDeleting: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Type and importance header
                HStack {
                    Label(item.type.capitalized, systemImage: item.typeIcon)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(EidolonColors.accent)
                    Spacer()
                    ImportanceBadge(importance: item.importance)
                }

                Divider()

                // Content
                Text(item.content)
                    .font(.body)
                    .foregroundColor(.primary)

                Divider()

                // Metadata
                VStack(alignment: .leading, spacing: 8) {
                    metaRow(label: "Created", value: item.createdAt.formatted())
                    metaRow(label: "ID", value: item.id)
                }

                if !item.tags.isEmpty {
                    Divider()
                    FlowLayout(spacing: 6) {
                        ForEach(item.tags, id: \.self) { tag in
                            Text(tag)
                                .font(.caption)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color.secondary.opacity(0.2))
                                .cornerRadius(6)
                        }
                    }
                }
            }
            .padding(16)
        }
        .background(EidolonColors.background)
        .navigationTitle("Memory Detail")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .bottomBar) {
                Button(action: onEdit) {
                    Label("Edit", systemImage: "pencil")
                }
                .accessibilityHint("Edit this memory's content and importance")
                .accessibilityIdentifier("editMemoryButton")

                Spacer()

                Button(role: .destructive, action: onDelete) {
                    if isDeleting {
                        ProgressView()
                            .scaleEffect(0.8)
                    } else {
                        Label("Delete", systemImage: "trash")
                    }
                }
                .disabled(isDeleting)
                .accessibilityLabel(isDeleting ? "Deleting" : "Delete")
                .accessibilityHint("Permanently delete this memory")
                .accessibilityIdentifier("deleteMemoryButton")
            }
        }
    }

    private func metaRow(label: String, value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
                .frame(width: 60, alignment: .leading)
            Text(value)
                .font(.caption)
                .foregroundColor(.primary)
        }
    }
}

// MARK: - Memory Edit Sheet

struct MemoryEditSheet: View {
    let item: MemoryItem
    let isEditing: Bool
    let onSave: (String, Double) -> Void
    let onCancel: () -> Void

    @State private var editContent: String
    @State private var editImportance: Double

    init(item: MemoryItem, isEditing: Bool, onSave: @escaping (String, Double) -> Void, onCancel: @escaping () -> Void) {
        self.item = item
        self.isEditing = isEditing
        self.onSave = onSave
        self.onCancel = onCancel
        _editContent = State(initialValue: item.content)
        _editImportance = State(initialValue: item.importance)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Content") {
                    TextEditor(text: $editContent)
                        .frame(minHeight: 120)
                }

                Section("Importance (\(Int(editImportance * 100))%)") {
                    Slider(value: $editImportance, in: 0...1, step: 0.01)
                        .tint(EidolonColors.accent)
                        .accessibilityLabel("Importance")
                        .accessibilityValue("\(Int(editImportance * 100)) percent")
                        .accessibilityIdentifier("importanceSlider")
                }

                Section("Info") {
                    HStack {
                        Text("Type")
                        Spacer()
                        Text(item.type.capitalized)
                            .foregroundColor(.secondary)
                    }
                    HStack {
                        Text("Created")
                        Spacer()
                        Text(item.createdAt.formatted())
                            .foregroundColor(.secondary)
                    }
                }
            }
            .navigationTitle("Edit Memory")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        onSave(editContent, editImportance)
                    } label: {
                        if isEditing {
                            ProgressView()
                                .scaleEffect(0.8)
                        } else {
                            Text("Save")
                        }
                    }
                    .disabled(isEditing || editContent.isEmpty)
                }
            }
        }
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
                .accessibilityHidden(true)

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
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.type) memory: \(item.content). Importance: \(String(format: "%.0f", item.importance * 100)) percent")
        .accessibilityIdentifier("memoryRow_\(item.id)")
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
            .accessibilityLabel("Importance: \(String(format: "%.0f", importance * 100)) percent")
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

// MARK: - Flow Layout

/// Simple horizontal wrapping layout for tags.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = layout(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = layout(proposal: proposal, subviews: subviews)
        for (index, position) in result.positions.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y), proposal: .unspecified)
        }
    }

    private func layout(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth && x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }

        return (CGSize(width: maxWidth, height: y + rowHeight), positions)
    }
}
