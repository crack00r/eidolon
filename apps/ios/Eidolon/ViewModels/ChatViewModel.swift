/// Chat state management — sends messages via WebSocket and
/// handles streaming responses from the Eidolon Core.

import Foundation
import Combine

@MainActor
final class ChatViewModel: ObservableObject {

    // MARK: Published state

    @Published var messages: [ChatMessage] = []
    @Published var inputText: String = ""
    @Published var isStreaming: Bool = false

    // MARK: Dependencies

    private weak var webSocketService: WebSocketService?
    private var pushHandlerId: UUID?
    private var currentStreamingMessageId: String?

    // MARK: - Initialization

    func bind(to service: WebSocketService) {
        webSocketService = service

        // Subscribe to push events for streaming responses
        pushHandlerId = service.onPush { [weak self] method, params in
            Task { @MainActor in
                self?.handlePushEvent(method: method, params: params)
            }
        }
    }

    deinit {
        if let id = pushHandlerId {
            webSocketService?.removePushHandler(id)
        }
    }

    // MARK: - Public API

    /// Send the current input text as a user message.
    func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard let service = webSocketService,
              service.connectionState == .connected else { return }

        let userMessage = ChatMessage(role: .user, content: text)
        messages.append(userMessage)
        inputText = ""

        // Create placeholder for assistant response
        let assistantMessage = ChatMessage(role: .assistant, content: "", isStreaming: true)
        messages.append(assistantMessage)
        currentStreamingMessageId = assistantMessage.id
        isStreaming = true

        Task {
            do {
                let response: ChatSendResponse = try await service.call(
                    method: GatewayMethod.chatSend.rawValue,
                    params: ["message": text]
                )

                // Replace streaming placeholder with final content
                updateMessage(id: assistantMessage.id) { msg in
                    msg.content = response.content
                    msg.isStreaming = false
                }
            } catch {
                updateMessage(id: assistantMessage.id) { msg in
                    msg.content = "Error: \(ChatViewModel.sanitizeError(error))"
                    msg.isStreaming = false
                }
            }

            isStreaming = false
            currentStreamingMessageId = nil
        }
    }

    /// Clear all messages.
    func clearMessages() {
        messages.removeAll()
    }

    // MARK: - Push Event Handling

    private func handlePushEvent(method: String, params: [String: AnyCodable]) {
        switch method {
        case "chat.stream.chunk":
            guard let chunk = params["content"]?.stringValue,
                  let messageId = currentStreamingMessageId else { return }
            updateMessage(id: messageId) { msg in
                msg.content += chunk
            }

        case "chat.stream.end":
            guard let messageId = currentStreamingMessageId else { return }
            updateMessage(id: messageId) { msg in
                msg.isStreaming = false
            }
            isStreaming = false
            currentStreamingMessageId = nil

        default:
            break
        }
    }

    // MARK: - Error Sanitization

    /// Strip internal details (file paths, stack traces) from error messages shown to users.
    static func sanitizeError(_ error: Error) -> String {
        let description = error.localizedDescription
        // Remove Unix-style file paths
        let cleaned = description
            .replacingOccurrences(of: #"/[^\s:]+\.[a-zA-Z]+"#, with: "[path]", options: .regularExpression)
        return cleaned.isEmpty ? "An unexpected error occurred" : cleaned
    }

    // MARK: - Helpers

    private func updateMessage(id: String, transform: (inout ChatMessage) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        transform(&messages[index])
    }
}

// MARK: - Response Types

private struct ChatSendResponse: Decodable {
    let content: String
}
