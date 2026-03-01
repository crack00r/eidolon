/// Chat interface — messages list with input field.

import SwiftUI

struct ChatView: View {
    @EnvironmentObject var webSocketService: WebSocketService
    @StateObject private var viewModel = ChatViewModel()

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                messagesList
                inputBar
            }
            .background(EidolonColors.background)
            .navigationTitle("Chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    ConnectionStatusBadge(state: webSocketService.connectionState)
                }
                ToolbarItem(placement: .navigationBarLeading) {
                    if !viewModel.messages.isEmpty {
                        Button("Clear") {
                            viewModel.clearMessages()
                        }
                        .foregroundColor(EidolonColors.accent)
                    }
                }
            }
            .onAppear {
                viewModel.bind(to: webSocketService)
            }
        }
    }

    // MARK: - Messages List

    private var messagesList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(viewModel.messages) { message in
                        MessageBubble(message: message)
                            .id(message.id)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .onChange(of: viewModel.messages.count) {
                if let lastId = viewModel.messages.last?.id {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(lastId, anchor: .bottom)
                    }
                }
            }
        }
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(spacing: 12) {
            TextField("Message...", text: $viewModel.inputText, axis: .vertical)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(EidolonColors.secondary)
                .cornerRadius(20)
                .lineLimit(1...5)
                .disabled(webSocketService.connectionState != .connected)

            Button {
                viewModel.sendMessage()
            } label: {
                Image(systemName: viewModel.isStreaming ? "stop.circle.fill" : "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundColor(sendButtonColor)
            }
            .disabled(!canSend)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(EidolonColors.background)
    }

    private var canSend: Bool {
        webSocketService.connectionState == .connected
            && !viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !viewModel.isStreaming
    }

    private var sendButtonColor: Color {
        canSend ? EidolonColors.accent : .gray
    }
}

// MARK: - Message Bubble

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 60) }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 4) {
                Text(message.content.isEmpty && message.isStreaming ? " " : message.content)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(bubbleColor)
                    .foregroundColor(.white)
                    .cornerRadius(18)
                    .overlay(streamingOverlay)

                Text(message.timestamp, style: .time)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            if message.role != .user { Spacer(minLength: 60) }
        }
    }

    private var bubbleColor: Color {
        switch message.role {
        case .user:      return EidolonColors.accent
        case .assistant: return EidolonColors.secondary
        case .system:    return Color.orange.opacity(0.3)
        }
    }

    @ViewBuilder
    private var streamingOverlay: some View {
        if message.isStreaming {
            HStack(spacing: 4) {
                ForEach(0..<3) { i in
                    Circle()
                        .fill(Color.white.opacity(0.6))
                        .frame(width: 6, height: 6)
                        .offset(y: streamingDotOffset(index: i))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
    }

    private func streamingDotOffset(index: Int) -> CGFloat {
        // Simple bouncing effect placeholder — animated in a real implementation
        return 0
    }
}
