/// Chat interface — messages list with input field and voice mode toggle.

import SwiftUI

struct ChatView: View {
    @EnvironmentObject var webSocketService: WebSocketService
    @StateObject private var viewModel = ChatViewModel()
    @StateObject private var voiceManager = VoiceManager()
    @State private var showVoiceOverlay = false

    var body: some View {
        NavigationStack {
            ZStack {
                VStack(spacing: 0) {
                    messagesList
                    inputBar
                }
                .background(EidolonColors.background)
            }
            .navigationTitle("Chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    HStack(spacing: 12) {
                        voiceToggleButton
                        ConnectionStatusBadge(state: webSocketService.connectionState)
                    }
                }
                ToolbarItem(placement: .navigationBarLeading) {
                    if !viewModel.messages.isEmpty {
                        Button("Clear") {
                            viewModel.clearMessages()
                        }
                        .foregroundColor(EidolonColors.accent)
                        .accessibilityHint("Clears all messages from the conversation")
                    }
                }
            }
            .onAppear {
                viewModel.bind(to: webSocketService)
                voiceManager.bind(to: webSocketService)
            }
            .fullScreenCover(isPresented: $showVoiceOverlay) {
                VoiceOverlay(voiceManager: voiceManager) {
                    showVoiceOverlay = false
                }
            }
        }
    }

    // MARK: - Voice Toggle

    private var voiceToggleButton: some View {
        Button {
            Task {
                if voiceManager.isVoiceModeActive {
                    voiceManager.deactivateVoiceMode()
                    showVoiceOverlay = false
                } else {
                    await voiceManager.activateVoiceMode()
                    if voiceManager.isVoiceModeActive {
                        showVoiceOverlay = true
                    }
                }
            }
        } label: {
            Image(systemName: voiceIconName)
                .font(.system(size: 18))
                .foregroundColor(voiceIconColor)
        }
        .disabled(webSocketService.connectionState != .connected)
        .accessibilityLabel(voiceManager.isVoiceModeActive ? "Deactivate voice mode" : "Activate voice mode")
    }

    private var voiceIconName: String {
        if voiceManager.isVoiceModeActive {
            return "mic.fill"
        } else {
            return "mic"
        }
    }

    private var voiceIconColor: Color {
        if webSocketService.connectionState != .connected {
            return .gray
        }
        return voiceManager.isVoiceModeActive ? EidolonColors.accent : .secondary
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
                .onChange(of: viewModel.inputText) {
                    // Enforce max input length (50 KB) to prevent resource exhaustion
                    if viewModel.inputText.count > 50_000 {
                        viewModel.inputText = String(viewModel.inputText.prefix(50_000))
                    }
                }

            // Inline voice button for quick voice input without full overlay
            if viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                inlineVoiceButton
            }

            Button {
                viewModel.sendMessage()
            } label: {
                Image(systemName: viewModel.isStreaming ? "stop.circle.fill" : "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundColor(sendButtonColor)
            }
            .disabled(!canSend)
            .accessibilityLabel(viewModel.isStreaming ? "Stop response" : "Send message")
            .accessibilityIdentifier("sendButton")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(EidolonColors.background)
    }

    /// Inline microphone button in the input bar. Opens the voice overlay.
    private var inlineVoiceButton: some View {
        Button {
            Task {
                if !voiceManager.isVoiceModeActive {
                    await voiceManager.activateVoiceMode()
                }
                if voiceManager.isVoiceModeActive {
                    showVoiceOverlay = true
                }
            }
        } label: {
            Image(systemName: "mic.circle.fill")
                .font(.system(size: 32))
                .foregroundColor(webSocketService.connectionState == .connected
                    ? EidolonColors.accent.opacity(0.7)
                    : .gray)
        }
        .disabled(webSocketService.connectionState != .connected)
        .accessibilityLabel("Voice input")
        .accessibilityHint("Opens voice conversation overlay")
        .accessibilityIdentifier("inlineVoiceButton")
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
        .accessibilityElement(children: .combine)
        .accessibilityLabel(messageSenderLabel + ": " + (message.isStreaming ? "Streaming response" : message.content))
        .accessibilityIdentifier("messageBubble_\(message.id)")
    }

    private var messageSenderLabel: String {
        switch message.role {
        case .user:      return "You"
        case .assistant: return "Eidolon"
        case .system:    return "System"
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
            .accessibilityHidden(true)
        }
    }

    private func streamingDotOffset(index: Int) -> CGFloat {
        // Simple bouncing effect placeholder -- animated in a real implementation
        return 0
    }
}
