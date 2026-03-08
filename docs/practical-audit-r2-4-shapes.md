# Practical Audit Round 2.4: Chat Flow Data Shape Trace

**Date**: 2026-03-08
**Method**: Manual code reading -- every file in the chat path traced end-to-end
**Verdict**: 0 Critical, 0 High, 1 Medium, 2 Low

---

## Boundary-by-Boundary Data Shape Analysis

### Boundary 1: Frontend -> Gateway (RPC call)

**File**: `apps/desktop/src/lib/stores/chat.ts` line 71

```typescript
// SENT:
client.call<{ messageId: string; status: string }>("chat.send", {
  text: content,   // string (1..50_000 chars, enforced client-side)
})
```

Shape over the wire (JSON-RPC 2.0):
```typescript
{
  jsonrpc: "2.0",
  id: string,        // auto-incremented by GatewayClient
  method: "chat.send",
  params: { text: string }
}
```

**EXPECTED by backend** (`rpc-handlers-chat.ts` line 16):
```typescript
ChatSendParamsSchema = z.object({
  text: z.string().min(1).max(100_000),
  channelId: z.string().min(1).max(64).optional(),
})
```

**Match**: YES. Frontend sends `{ text }` which satisfies the Zod schema. `channelId` is optional and defaults to `"gateway"` in the handler (line 58).

**Note (L-1)**: Frontend enforces max 50,000 chars but backend accepts up to 100,000. Not a mismatch per se (backend is more permissive), but the limits diverge. A user could bypass the frontend check and send up to 100K.

---

### Boundary 2: Gateway -> EventBus (event published)

**File**: `packages/core/src/gateway/rpc-handlers-chat.ts` lines 54-63

```typescript
// PUBLISHED:
deps.eventBus.publish(
  "user:message",           // EventType
  {
    messageId: string,      // randomUUID()
    channelId: string,      // parsed.channelId ?? "gateway"
    userId: string,         // clientId (from RPC handler's second param)
    text: string,           // parsed.text
  },
  { source: "gateway", priority: "critical" }
)
```

**EventBus.publish signature** (`event-bus.ts` line 48):
```typescript
publish<T>(
  type: EventType,
  payload: T,
  options?: { priority?: EventPriority; source?: string }
): Result<BusEvent<T>, EidolonError>
```

**Match**: YES. Payload is serialized to JSON and stored in SQLite. Reconstructed as `BusEvent.payload: unknown` on dispatch.

**RPC return to frontend**:
```typescript
{ messageId: string, status: "queued" }
```

Frontend expects `{ messageId: string; status: string }` -- matches.

---

### Boundary 3: EventBus -> Handler (event dispatched)

**File**: `packages/core/src/daemon/event-handlers-user.ts` lines 19-29

```typescript
// RECEIVED:
event: { readonly id: string; readonly payload: unknown }

// EXTRACTED (runtime validation, no Zod):
const rawPayload = event.payload as Record<string, unknown>;
const channelId = typeof rawPayload.channelId === "string" ? rawPayload.channelId : undefined;
const userId = typeof rawPayload.userId === "string" ? rawPayload.userId : undefined;
const text = typeof rawPayload.text === "string" ? rawPayload.text : undefined;
```

**Match**: YES. All three fields (`channelId`, `userId`, `text`) are published in Boundary 2 and correctly extracted here. `messageId` from the payload is NOT extracted (unused by handler -- it generates its own `sessionId`).

Handler validates: `channelId` and `userId` must both be non-empty strings (line 31), `text` must be non-empty (line 38).

---

### Boundary 4: Handler -> Claude (run invocation)

**File**: `packages/core/src/daemon/event-handlers-user.ts` lines 149-154

```typescript
// INVOKED:
claudeManager.run(text, {     // text: string (user's message)
  sessionId: string,          // `msg-${randomUUID()}`
  workspaceDir: string,       // from workspacePreparer.prepare()
  model: string,              // config.brain.model.default
  timeoutMs: number,          // config.brain.session.timeoutMs
})
```

**ClaudeSessionOptions** (`packages/protocol/src/types/claude.ts` lines 19-31):
```typescript
interface ClaudeSessionOptions {
  readonly sessionId?: string;
  readonly workspaceDir: string;
  readonly model?: string;
  readonly allowedTools?: readonly string[];
  readonly mcpConfig?: string;
  readonly maxTurns?: number;
  readonly systemPrompt?: string;
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
  readonly outputSchema?: z.ZodType;
}
```

**Match**: YES. Handler provides `sessionId`, `workspaceDir`, `model`, `timeoutMs`. All are valid optional/required fields.

---

### Boundary 5: Claude -> Handler (stream events)

**File**: `packages/core/src/claude/parser.ts` + `packages/protocol/src/types/claude.ts`

**StreamEvent type**:
```typescript
interface StreamEvent {
  readonly type: "text" | "tool_use" | "tool_result" | "error" | "done" | "system";
  readonly content?: string;
  readonly toolName?: string;
  readonly toolInput?: Record<string, unknown>;
  readonly toolResult?: unknown;
  readonly error?: string;
  readonly timestamp: number;
}
```

**Parser output** (`parser.ts`):
- `type="assistant"` + `message.type="text"` -> `{ type: "text", content: string, timestamp }`
- `type="assistant"` + `message.type="tool_use"` -> `{ type: "tool_use", toolName, toolInput, timestamp }`
- `type="result"` + `tool_use_id` -> `{ type: "tool_result", toolResult: unknown, timestamp }`
- `type="result"` without `tool_use_id` -> `{ type: "text", content: string, timestamp }`
- `type="system"` -> `{ type: "system", content: string, timestamp }`
- `type="error"` -> `{ type: "error", error: string, timestamp }`

**Handler consumption** (`event-handlers-user.ts` lines 155-182):
- `"text"` -> appends `streamEvent.content` to `responseChunks[]`
- `"tool_result"` -> appends `streamEvent.toolResult` if it's a string
- `"error"` -> logs error
- `"done"` -> no-op
- default -> ignored

**Match**: YES. Handler correctly handles all event types the parser produces. The `"done"` type is in the union but never emitted by `parseStreamLine` -- no issue since the handler handles it as a no-op.

---

### Boundary 6: Handler -> MessageRouter (outbound message)

**File**: `packages/core/src/daemon/event-handlers-user.ts` lines 203-210

```typescript
// SENT:
messageRouter.routeOutbound({
  id: string,           // `resp-${randomUUID()}`
  channelId: string,    // from event payload (e.g. "gateway")
  text: string,         // responseText (joined chunks)
  format: "markdown",   // literal
  replyToId: string,    // event.id (the EventBus event ID)
  userId: string,       // from event payload (the gateway clientId)
})
```

**OutboundMessage interface** (`packages/protocol/src/types/messages.ts` lines 24-33):
```typescript
interface OutboundMessage {
  readonly id: string;
  readonly channelId: string;
  readonly text: string;
  readonly format?: "text" | "markdown" | "html";
  readonly replyToId?: string;
  readonly attachments?: readonly MessageAttachment[];
  readonly userId?: string;
}
```

**Match**: YES. All provided fields are valid. `userId` is included (critical for directed delivery to the correct gateway client).

---

### Boundary 7: MessageRouter -> GatewayChannel (channel.send)

**File**: `packages/core/src/channels/router.ts` lines 169-181

```typescript
async routeOutbound(message: OutboundMessage): Promise<Result<void, EidolonError>> {
  const channel = this.channels.get(message.channelId);  // looks up "gateway"
  // ...
  return channel.send(message);  // passes full OutboundMessage
}
```

**Channel.send signature**: `send(message: OutboundMessage): Promise<Result<void, EidolonError>>`

**Match**: YES. The full `OutboundMessage` (including `userId`) is passed through to `channel.send()`.

---

### Boundary 8: GatewayChannel -> WebSocket (push event)

**File**: `packages/core/src/gateway/gateway-channel.ts` lines 43-69

```typescript
async send(message: OutboundMessage): Promise<Result<void, EidolonError>> {
  const pushEvent = {
    jsonrpc: "2.0",
    method: "push.chatMessage",
    params: {
      id: message.id,             // string (resp-UUID)
      text: message.text,         // string (the AI response)
      format: message.format ?? "text",  // "markdown" or "text"
      replyToId: message.replyToId,      // string (event bus event ID)
      timestamp: Date.now(),             // number
    },
  };

  const targetClientId = message.userId;
  if (targetClientId) {
    this.server.sendTo(targetClientId, pushEvent);   // directed delivery
  } else {
    this.server.broadcast(pushEvent);                 // fallback: broadcast
  }
}
```

**Wire shape** (JSON):
```typescript
{
  jsonrpc: "2.0",
  method: "push.chatMessage",
  params: {
    id: string,
    text: string,
    format: "markdown" | "text",
    replyToId: string,
    timestamp: number
  }
}
```

**Match**: YES. Uses `sendTo(targetClientId)` for directed delivery when `userId` is available (which it always is for gateway-originated messages). Falls back to broadcast only if `userId` is undefined.

---

### Boundary 9: WebSocket -> Frontend (push handler dispatch)

**File**: `apps/desktop/src/lib/api.ts` lines 395-451

```typescript
private handleMessage(data: string): void {
  // Size guard: drops messages > 1MB
  let message = JSON.parse(data) as JsonRpcResponse;

  // Push notification detection: no id, has method
  if (message.id === undefined && message.method) {
    const params = message.params ?? {};

    // Dispatch to typed handlers
    const typedHandlers = this.typedPushHandlers.get(message.method);
    for (const handler of typedHandlers) {
      handler(params);  // params: Record<string, unknown>
    }
  }
}
```

**What the handler receives**: `params` as `Record<string, unknown>`, containing:
```typescript
{
  id: string,
  text: string,
  format: string,
  replyToId: string,
  timestamp: number
}
```

**Match**: YES. The handler type is `PushEventHandler = (params: Record<string, unknown>) => void` which accepts arbitrary keys. The push.chatMessage handler in chat.ts accesses `params.text`, `params.id`, `params.timestamp` -- all present.

---

### Boundary 10: Push handler -> Chat store (message display)

**File**: `apps/desktop/src/lib/stores/chat.ts` lines 134-161

```typescript
client.on("push.chatMessage", (params) => {
  const text = typeof params.text === "string" ? params.text : "";
  if (!text) return;                    // empty text = skip

  const id = typeof params.id === "string" ? params.id : generateId();

  messagesStore.update((msgs) => {
    const idx = msgs.findLastIndex((m) => m.role === "assistant" && m.streaming);
    if (idx !== -1) {
      // Replace the streaming placeholder
      updated[idx] = { ...updated[idx]!, content: text, streaming: false, id };
      return updated;
    }
    // No placeholder found -- append new message
    return [...msgs, {
      id,
      role: "assistant",
      content: text,
      timestamp: typeof params.timestamp === "number" ? params.timestamp : Date.now(),
      streaming: false,
    }];
  });
  streamingStore.set(false);
});
```

**Match**: YES. The handler safely extracts `text`, `id`, and `timestamp` from `params` with proper type guards. It finds the most recent `streaming: true` assistant message and replaces it, or appends a new one.

---

## Issues Found

### M-1: `format` field from push event is IGNORED by frontend

**Severity**: Medium
**Location**: `apps/desktop/src/lib/stores/chat.ts` line 134-161

The backend sends `format: "markdown"` in the push event params (Boundary 8), but the frontend push handler **never reads `params.format`**. The `ChatMessage` interface does not even have a `format` field. This means:

1. The frontend has no way to distinguish markdown from plain text responses.
2. If the response contains markdown syntax, the frontend displays it as raw text (no rendering).
3. The `format` field travels through 7 boundaries only to be discarded at the final step.

**Impact**: Markdown formatting in AI responses is not rendered. Users see raw markdown syntax like `**bold**` or `# heading` instead of formatted text.

**Fix**: Either (a) add a `format` field to `ChatMessage` and use it in the UI for conditional markdown rendering, or (b) always render assistant messages as markdown (since the backend always sends `format: "markdown"` for AI responses).

### L-1: Frontend max message length (50K) diverges from backend (100K)

**Severity**: Low
**Location**: `apps/desktop/src/lib/stores/chat.ts` line 26 vs `rpc-handlers-chat.ts` line 17

Frontend enforces `MAX_MESSAGE_LENGTH = 50_000`, backend Zod schema allows `z.string().max(100_000)`. Not a functional mismatch (backend is more permissive), but the limits should be aligned. A non-desktop client could send messages up to 100K that the desktop frontend couldn't send.

### L-2: `replyToId` in push event is the EventBus event ID, not a message ID

**Severity**: Low
**Location**: `event-handlers-user.ts` line 208 passes `replyToId: event.id` where `event.id` is the EventBus UUID, not the original `messageId` from `chat.send`. The frontend never uses `replyToId` from the push event (it uses `findLastIndex` streaming placeholder matching instead), so this is harmless. But semantically, `replyToId` links to an internal event ID rather than the `messageId` returned to the client from `chat.send`.

---

## Full Data Flow Summary

```
Frontend sendMessage("hello")
  |
  |  { jsonrpc:"2.0", id:"1", method:"chat.send", params:{ text:"hello" } }
  v
Gateway RPC handler (Zod validates { text, channelId? })
  |
  |  eventBus.publish("user:message", { messageId, channelId:"gateway", userId:clientId, text })
  v
EventBus (persists to SQLite, dispatches to subscribers)
  |
  |  BusEvent { id, type:"user:message", payload:{ channelId, userId, text }, ... }
  v
handleUserMessage (extracts channelId, userId, text from payload)
  |
  |  claudeManager.run(text, { sessionId, workspaceDir, model, timeoutMs })
  v
Claude CLI (stream-json output, one JSON object per line)
  |
  |  StreamEvent { type:"text"|"tool_result"|"error"|"done"|"system", content?, ... }
  v
Handler collects text chunks, joins into responseText
  |
  |  messageRouter.routeOutbound({ id, channelId:"gateway", text, format:"markdown", replyToId, userId })
  v
MessageRouter.routeOutbound -> channel.send(OutboundMessage)
  |
  |  Full OutboundMessage passed through (including userId)
  v
GatewayChannel.send -> builds push event, sends via sendTo(userId) or broadcast()
  |
  |  { jsonrpc:"2.0", method:"push.chatMessage", params:{ id, text, format, replyToId, timestamp } }
  v
WebSocket -> Frontend handleMessage -> typed push dispatch
  |
  |  params: Record<string, unknown> with { id, text, format, replyToId, timestamp }
  v
push.chatMessage handler -> finds streaming placeholder, replaces content
  |  (format field IGNORED -- M-1)
  |
  v
ChatMessage { id, role:"assistant", content:text, timestamp, streaming:false }
```

---

## Conclusion

The chat data flow is **structurally sound** across all 10 boundaries. Every field that is produced at one boundary is consumed correctly at the next. The `userId` flows correctly from gateway clientId through EventBus to OutboundMessage to directed WebSocket delivery. The one medium issue (M-1) is that the `format` field is carried through the entire pipeline but discarded at the final rendering step, meaning markdown responses are not rendered as markdown.
