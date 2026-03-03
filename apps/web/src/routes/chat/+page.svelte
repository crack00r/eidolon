<script lang="ts">
import { clientLog } from "$lib/logger";
import { clearMessages, isStreaming, messages, rateMessage, sendMessage } from "$lib/stores/chat";
import { isConnected } from "$lib/stores/connection";

let inputValue = $state("");
let messagesContainer: HTMLDivElement | undefined = $state();

function scrollToBottom(): void {
  if (messagesContainer) {
    requestAnimationFrame(() => {
      messagesContainer!.scrollTop = messagesContainer!.scrollHeight;
    });
  }
}

async function handleRate(msgId: string, rating: number): Promise<void> {
  try {
    await rateMessage(msgId, rating);
  } catch (err) {
    clientLog("error", "chat-page", "handleRate failed", err);
  }
}

async function handleSend(): Promise<void> {
  const content = inputValue.trim();
  if (!content || $isStreaming || !$isConnected) return;

  inputValue = "";
  try {
    await sendMessage(content);
  } catch (err) {
    clientLog("error", "chat-page", "handleSend failed", err);
  }
  scrollToBottom();
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    handleSend();
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Auto-scroll when messages change
$effect(() => {
  void $messages;
  scrollToBottom();
});
</script>

<div class="chat-page">
  <header class="chat-header">
    <h2>Chat</h2>
    <button class="clear-btn" onclick={() => clearMessages()} disabled={$messages.length === 0}>
      Clear
    </button>
  </header>

  <div class="messages" bind:this={messagesContainer}>
    {#if $messages.length === 0}
      <div class="empty-state">
        <p class="empty-title">No messages yet</p>
        <p class="empty-hint">Send a message to start a conversation with Eidolon.</p>
      </div>
    {:else}
      {#each $messages as msg (msg.id)}
        <div
          class="message"
          class:user={msg.role === "user"}
          class:assistant={msg.role === "assistant"}
          class:system={msg.role === "system"}
        >
          <div class="message-header">
            <span class="message-role">{msg.role}</span>
            <span class="message-time">{formatTime(msg.timestamp)}</span>
          </div>
          <div class="message-content">
            {#if msg.streaming}
              <span>{msg.content}</span><span class="cursor">|</span>
            {:else}
              {msg.content}
            {/if}
          </div>
          {#if msg.role === "assistant" && !msg.streaming}
            <div class="message-feedback">
              {#if msg.rating}
                <span class="feedback-done">{msg.rating >= 4 ? "Rated positively" : "Rated negatively"}</span>
              {:else}
                <button class="feedback-btn" class:active={msg.rating === 5} onclick={() => handleRate(msg.id, 5)} title="Good response">
                  +
                </button>
                <button class="feedback-btn" class:active={msg.rating === 1} onclick={() => handleRate(msg.id, 1)} title="Poor response">
                  -
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  <div class="input-area">
    <textarea
      class="message-input"
      placeholder={$isConnected ? "Type a message..." : "Connect to gateway first"}
      bind:value={inputValue}
      onkeydown={handleKeydown}
      disabled={!$isConnected || $isStreaming}
      rows={1}
    ></textarea>
    <button
      class="send-btn"
      onclick={handleSend}
      disabled={!inputValue.trim() || !$isConnected || $isStreaming}
    >
      {$isStreaming ? "..." : "Send"}
    </button>
  </div>
</div>

<style>
  .chat-page {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
  }

  .chat-header h2 {
    font-size: 16px;
    font-weight: 600;
  }

  .clear-btn {
    padding: 4px 12px;
    border-radius: var(--radius);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: 12px;
  }

  .clear-btn:hover:not(:disabled) {
    color: var(--text-primary);
  }

  .clear-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-secondary);
  }

  .empty-title {
    font-size: 16px;
    margin-bottom: 4px;
  }

  .empty-hint {
    font-size: 13px;
  }

  .message {
    padding: 10px 14px;
    border-radius: var(--radius);
    max-width: 80%;
  }

  .message.user {
    background: var(--bg-tertiary);
    align-self: flex-end;
  }

  .message.assistant {
    background: var(--bg-secondary);
    align-self: flex-start;
    border: 1px solid var(--border);
  }

  .message.system {
    background: none;
    align-self: center;
    color: var(--text-secondary);
    font-size: 13px;
    font-style: italic;
  }

  .message-header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 4px;
  }

  .message-role {
    font-size: 11px;
    color: var(--text-secondary);
    text-transform: uppercase;
    font-weight: 600;
  }

  .message-time {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .message-content {
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.5;
  }

  .message-feedback {
    display: flex;
    gap: 4px;
    margin-top: 6px;
    align-items: center;
  }

  .feedback-btn {
    padding: 2px 10px;
    border-radius: var(--radius);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: 14px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    transition: background-color 0.15s, color 0.15s;
  }

  .feedback-btn:hover {
    background: var(--accent);
    color: white;
  }

  .feedback-done {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .cursor {
    animation: blink 1s step-end infinite;
    color: var(--accent);
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }

  .input-area {
    display: flex;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
    background: var(--bg-secondary);
  }

  .message-input {
    flex: 1;
    resize: none;
    min-height: 38px;
    max-height: 120px;
  }

  .send-btn {
    padding: 8px 20px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius);
    font-weight: 600;
    transition: background-color 0.15s;
  }

  .send-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .send-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
