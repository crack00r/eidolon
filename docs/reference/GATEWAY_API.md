# Gateway API Reference

> **Status: Synchronized with `packages/core/src/gateway/` as of v0.1.6.**

The Eidolon Gateway exposes a WebSocket JSON-RPC 2.0 API for client communication, plus REST endpoints for health, metrics, webhooks, and OpenAI-compatible completions.

## Connection

### WebSocket Endpoint

```
ws://<host>:<port>/ws
wss://<host>:<port>/ws    # when TLS is enabled
```

Default: `ws://127.0.0.1:8419/ws`

### Authentication

After connecting, the client must authenticate within 30 seconds or the connection is terminated.

**Format 1: Raw ClientAuth**

```json
{ "type": "token", "token": "your-gateway-token" }
```

**Format 2: JSON-RPC wrapped**

```json
{
  "jsonrpc": "2.0",
  "id": "auth-1",
  "method": "auth.authenticate",
  "params": {
    "token": "your-gateway-token",
    "platform": "desktop",
    "version": "0.1.6"
  }
}
```

On success (JSON-RPC format):

```json
{
  "jsonrpc": "2.0",
  "id": "auth-1",
  "result": { "authenticated": true }
}
```

On failure, the connection is closed with code `4001`.

If `gateway.auth.type` is set to `"none"`, authentication is skipped and all connections are immediately authenticated.

### Security Features

- **Constant-time token comparison** (timing-safe) to prevent timing attacks.
- **IP-based auth rate limiting** with exponential backoff. After repeated failures, the IP is blocked for a configurable duration.
- **Connection limit enforcement** (`gateway.maxClients`, default 10).
- **Origin validation** when `gateway.allowedOrigins` is configured.
- **Max message payload size** (`gateway.maxMessageBytes`, default 1 MB).
- **Idle timeout** of 960 seconds (WebSocket auto-close if no traffic).

---

## REST Endpoints

### GET /health

Public endpoint (no authentication required).

**Response (200):**

```json
{
  "status": "healthy",
  "uptime": 3600000,
  "connectedClients": 2,
  "timestamp": 1709312400000
}
```

### GET /metrics

Prometheus-format metrics. Only available when a `MetricsRegistry` is configured.

**Response (200):**

```
Content-Type: text/plain; version=0.0.4; charset=utf-8

# HELP eidolon_loop_cycles_total Total cognitive loop cycles
# TYPE eidolon_loop_cycles_total counter
eidolon_loop_cycles_total 42
...
```

**Response (404):** `Metrics not configured`

### POST /webhooks/{id}

Generic webhook receiver. Endpoints are configured in `gateway.webhooks.endpoints[]`.

**Headers:**
- `Authorization: Bearer <endpoint-token>` (uses endpoint-specific token if configured, otherwise falls back to the gateway auth token)

**Request body:** Any valid JSON payload.

**Response (200):** Accepted.

**Behavior:** The webhook payload is published to the Event Bus as a `webhook:received` event (or the `eventType` configured for the endpoint) with the configured `priority`.

### GET/POST /webhooks/whatsapp

WhatsApp Business API webhook endpoint. Only active when a WhatsApp channel is configured.

**GET** (verification challenge):
- Query params: `hub.mode`, `hub.verify_token`, `hub.challenge`
- Returns the challenge string on successful verification.

**POST** (incoming messages):
- Headers: `X-Hub-Signature-256` (HMAC-SHA256 signature verified against `whatsapp.appSecret`)
- Body: WhatsApp webhook payload
- Returns `200 OK` immediately; messages are processed asynchronously.

### OpenAI-Compatible REST API (/v1/)

Enables any OpenAI-compatible tool (Jan, Open WebUI, LM Studio, custom scripts) to use Eidolon as a backend.

**Authentication:** `Authorization: Bearer <gateway-token>`

#### GET /v1/models

List available models.

**Response (200):**

```json
{
  "object": "list",
  "data": [
    { "id": "eidolon-default", "object": "model", "created": 1709312400, "owned_by": "eidolon" },
    { "id": "claude-sonnet-4-20250514", "object": "model", "created": 1709312400, "owned_by": "anthropic" },
    { "id": "claude-opus-4-20250514", "object": "model", "created": 1709312400, "owned_by": "anthropic" },
    { "id": "claude-haiku-3-20250414", "object": "model", "created": 1709312400, "owned_by": "anthropic" }
  ]
}
```

Models include the `eidolon-default` meta-model (routes to the configured default), all brain config models, and any registered LLM providers (Ollama, llama.cpp).

**Model name mapping:** OpenAI model names are automatically mapped:
| OpenAI Name | Eidolon Model |
|---|---|
| `gpt-4` | `claude-opus-4-20250514` |
| `gpt-4-turbo` | `claude-opus-4-20250514` |
| `gpt-4o` | `claude-sonnet-4-20250514` |
| `gpt-4o-mini` | `claude-haiku-3-20250414` |
| `gpt-3.5-turbo` | `claude-haiku-3-20250414` |

#### POST /v1/chat/completions

Chat completions (streaming and non-streaming).

**Request body:**

```json
{
  "model": "eidolon-default",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 1024
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | yes | Model name (Eidolon, OpenAI, or `eidolon-default`) |
| `messages` | array | yes | Array of `{ role, content }` objects (max 1000) |
| `stream` | boolean | no | Enable Server-Sent Events streaming (default: false) |
| `temperature` | number | no | Sampling temperature 0.0-2.0 |
| `max_tokens` | number | no | Maximum tokens in the response |

**Non-streaming response (200):**

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1709312400,
  "model": "claude-sonnet-4-20250514",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hello! How can I help you?" },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 10,
    "total_tokens": 35
  }
}
```

**Streaming response (200, `text/event-stream`):**

```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1709312400,"model":"claude-sonnet-4-20250514","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1709312400,"model":"claude-sonnet-4-20250514","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1709312400,"model":"claude-sonnet-4-20250514","choices":[{"index":0,"delta":{},"finish_reason":"stop"},"usage":{"prompt_tokens":25,"completion_tokens":2,"total_tokens":27}}]}

data: [DONE]
```

**Error responses:**

| Status | Code | Description |
|---|---|---|
| 400 | `invalid_json` | Request body is not valid JSON |
| 400 | `invalid_params` | Validation error on request parameters |
| 401 | `invalid_api_key` | Missing or invalid auth token |
| 404 | `not_found` | Unknown `/v1/` endpoint |
| 503 | `no_provider` | No LLM provider is configured |
| 502 | `provider_error` | The LLM provider returned an error |

---

## WebSocket JSON-RPC 2.0 Methods

All methods use the standard JSON-RPC 2.0 envelope:

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "method": "system.status",
  "params": {}
}
```

**Success response:**

```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "result": { ... }
}
```

**Error response:**

```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "error": {
    "code": -32602,
    "message": "Invalid params: ..."
  }
}
```

Standard JSON-RPC error codes:
| Code | Meaning |
|---|---|
| -32700 | Parse error |
| -32600 | Invalid request |
| -32601 | Method not found |
| -32602 | Invalid params |
| -32603 | Internal error |

---

### System Methods

#### system.status

Get the current daemon status.

**Params:** none

**Result:**

```json
{
  "state": "running",
  "energy": { "current": 0, "max": 100 },
  "activeTasks": 0,
  "memoryCount": 0,
  "uptime": 3600000,
  "connectedClients": 2
}
```

#### system.subscribe

Subscribe to real-time status updates. After subscribing, the server pushes `system.statusUpdate`, `push.stateChange`, `push.clientConnected`, `push.clientDisconnected`, `push.approvalResolved`, and `push.executeCommand` events to this client.

**Params:** none

**Result:**

```json
{ "subscribed": true }
```

#### system.health

Get detailed health information.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `includeMetrics` | boolean | no | Include detailed metrics (default: false) |

**Result:**

```json
{
  "status": "healthy",
  "timestamp": 1709312400000,
  "uptimeMs": 3600000,
  "checks": [],
  "circuitBreakers": [],
  "gpuWorkers": [],
  "tokenUsage": { "current": 0, "limit": 0, "series": [] },
  "eventQueueDepth": 0,
  "memoryStats": { "totalMemories": 0, "recentExtractions": 0 },
  "errorRate": 0,
  "includeMetrics": false
}
```

---

### Brain Control Methods

#### brain.pause

Pause the cognitive loop.

**Params:** none

**Result:**

```json
{ "paused": true }
```

Pushes `push.stateChange` to all subscribers.

#### brain.resume

Resume the cognitive loop.

**Params:** none

**Result:**

```json
{ "resumed": true }
```

Pushes `push.stateChange` to all subscribers.

#### brain.triggerAction

Trigger a specific action in the cognitive loop.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | yes | Action to trigger. Allowed: `dream`, `learn`, `check_telegram`, `health_check`, `consolidate` |
| `args` | object | no | Additional arguments for the action |

**Result:**

```json
{ "triggered": true, "action": "dream" }
```

#### brain.getLog

Retrieve recent cognitive loop log entries.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | no | Max entries to return, 1-500 (default: 50) |

**Result:**

```json
{
  "entries": [],
  "limit": 50
}
```

---

### Client Management Methods

#### client.list

List all authenticated connected clients.

**Params:** none

**Result:**

```json
{
  "clients": [
    {
      "id": "abc-123",
      "platform": "desktop",
      "version": "0.1.6",
      "connectedAt": 1709312400000,
      "subscribed": true
    }
  ]
}
```

#### client.execute

Execute a command on a remote client (e.g., run a shell command on the user's desktop).

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `targetClientId` | string | yes | ID of the target client |
| `command` | string | yes | Command to execute (max 1024 chars) |
| `args` | any | no | Command arguments |

**Result:**

```json
{ "sent": true, "commandId": "cmd-uuid", "targetClientId": "abc-123" }
```

The target client receives a `push.executeCommand` push event. Cannot execute commands on self.

#### command.result

Report the result of a previously received `push.executeCommand`.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `commandId` | string | yes | ID of the command being responded to |
| `success` | boolean | no | Whether the command succeeded |
| `result` | any | no | Command output |
| `error` | string | no | Error message if failed |

**Result:**

```json
{ "received": true, "commandId": "cmd-uuid" }
```

---

### Error Reporting Methods

#### error.report / client.reportErrors

Clients report errors back to the server for centralized logging.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `errors` | array | yes | Array of error entries (max 100) |
| `errors[].module` | string | no | Module name (max 256 chars) |
| `errors[].message` | string | no | Error message (max 4096 chars) |
| `errors[].level` | string | no | Log level (max 64 chars) |
| `errors[].timestamp` | string/number | no | When the error occurred |
| `errors[].data` | object | no | Additional structured data |
| `clientInfo` | object | no | Client metadata override |
| `clientInfo.platform` | string | no | Client platform |
| `clientInfo.version` | string | no | Client version |

**Result:**

```json
{ "received": 3 }
```

---

### Research Methods

#### research.start

Start a deep research task.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Research question (max 4096 chars) |
| `sources` | string[] | no | Specific sources to search (max 20) |
| `maxSources` | integer | no | Max sources to consult, 1-100 (default: 10) |
| `deliverTo` | string | no | Channel to deliver results to |

**Result:**

```json
{ "researchId": "uuid", "status": "started" }
```

#### research.status

Check the status of a research task.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `researchId` | string | yes | ID of the research task |

**Result:**

```json
{ "researchId": "uuid", "status": "running" }
```

#### research.list

List recent research tasks.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | no | Max entries, 1-100 (default: 20) |
| `since` | integer | no | Unix timestamp filter |

**Result:**

```json
{ "results": [], "limit": 20 }
```

---

### Profile Methods

#### profile.get

Get the current user profile.

**Params:** none

**Result:**

```json
{ "profile": null }
```

---

### Metrics Methods

#### metrics.rateLimits

Get rate limit status for all Claude accounts.

**Params:** none

**Result:**

```json
{
  "accounts": [
    {
      "accountName": "primary",
      "tokensUsed": 12450,
      "tokensRemaining": 187550,
      "resetAt": 1709316000000
    }
  ]
}
```

Returns `{ "accounts": [], "note": "RateLimitTracker not configured" }` when no tracker is available.

---

### Approval Methods

#### approval.list

List pending and historical approval requests.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | string | no | Filter: `all`, `pending`, `approved`, `denied` (default: `all`) |

**Result:**

```json
{
  "items": [],
  "status": "all"
}
```

#### approval.respond

Approve or deny a pending approval request.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `approvalId` | string | yes | ID of the approval |
| `action` | string | yes | `approve` or `deny` |
| `reason` | string | no | Reason for the decision (max 1024 chars) |

**Result:**

```json
{ "processed": true, "approvalId": "uuid", "action": "approve" }
```

Publishes `user:approval` event and pushes `push.approvalResolved` to all subscribers.

---

### Automation Methods

#### automation.list

List home automation scenes/automations.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `enabledOnly` | boolean | no | Filter to enabled automations only |

**Result:**

```json
{
  "scenes": [],
  "enabledOnly": false
}
```

#### automation.create

Create a new automation from natural language input.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `input` | string | yes | Natural language description (max 2048 chars) |
| `deliverTo` | string | no | Channel for status updates |

**Result:**

```json
{ "created": true, "automationId": "uuid" }
```

#### automation.delete

Delete an automation.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `automationId` | string | yes | ID of the automation to delete |

**Result:**

```json
{ "deleted": true, "automationId": "uuid" }
```

---

### Calendar Methods

Available when a `CalendarManager` is configured (Google Calendar and/or CalDAV).

#### calendar.listEvents

List events in a time range.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `start` | integer | yes | Start timestamp (Unix ms) |
| `end` | integer | yes | End timestamp (Unix ms) |

**Result:**

```json
{
  "events": [
    {
      "id": "evt-1",
      "title": "Team Meeting",
      "startTime": 1709316000000,
      "endTime": 1709319600000,
      "description": "Weekly sync",
      "location": "Office",
      "allDay": false,
      "calendarId": "primary"
    }
  ]
}
```

#### calendar.getUpcoming

Get upcoming events within a time window.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `hours` | number | no | Hours to look ahead (default: 24) |

**Result:**

```json
{ "events": [] }
```

#### calendar.createEvent

Create a new calendar event.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | Event title (max 512 chars) |
| `startTime` | integer | yes | Start timestamp (Unix ms) |
| `endTime` | integer | yes | End timestamp (Unix ms) |
| `description` | string | no | Event description (max 4096 chars) |
| `location` | string | no | Event location (max 512 chars) |
| `allDay` | boolean | no | All-day event (default: false) |
| `calendarId` | string | no | Target calendar (default: `"default"`) |

**Result:** The created event object.

#### calendar.conflicts

Find scheduling conflicts in a time range.

**Params:**

| Field | Type | Required | Description |
|---|---|---|---|
| `start` | integer | no | Start timestamp (default: now) |
| `end` | integer | no | End timestamp (default: 7 days from now) |

**Result:**

```json
{
  "conflicts": [
    {
      "event1": { "id": "evt-1", "title": "Meeting A" },
      "event2": { "id": "evt-2", "title": "Meeting B" },
      "overlapMinutes": 30
    }
  ]
}
```

---

## Push Events

After subscribing via `system.subscribe`, the server pushes real-time events as JSON-RPC notifications (no `id` field).

**Format:**

```json
{
  "jsonrpc": "2.0",
  "method": "<push-type>",
  "params": { ... }
}
```

### Push Event Types

#### push.stateChange

Emitted when the cognitive loop state changes (e.g., pause/resume).

```json
{
  "previousState": "running",
  "currentState": "paused",
  "timestamp": 1709312400000
}
```

#### push.clientConnected

Emitted when a new client authenticates.

```json
{
  "clientId": "abc-123",
  "platform": "desktop",
  "version": "0.1.6",
  "timestamp": 1709312400000
}
```

#### push.clientDisconnected

Emitted when a client disconnects.

```json
{
  "clientId": "abc-123",
  "platform": "desktop",
  "version": "0.1.6",
  "timestamp": 1709312400000
}
```

#### push.approvalResolved

Emitted when an approval request is approved or denied.

```json
{
  "approvalId": "uuid",
  "action": "approve",
  "respondedBy": "abc-123",
  "timestamp": 1709312400000
}
```

#### push.executeCommand

Sent to a specific client when another client requests remote command execution.

```json
{
  "commandId": "cmd-uuid",
  "command": "ls -la",
  "args": null,
  "fromClientId": "abc-123"
}
```

#### system.statusUpdate

Periodic status updates pushed to subscribers.

```json
{
  "state": "running",
  "energy": { "current": 45, "max": 100 },
  "activeTasks": 1,
  "memoryCount": 1234,
  "timestamp": 1709312400000
}
```
