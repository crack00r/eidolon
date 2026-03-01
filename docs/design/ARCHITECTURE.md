# Architecture

## Overview

Eidolon is a distributed system with a single **Core Daemon** running on a central server, connected to **Clients** on multiple devices and optional **GPU Workers** for compute-intensive tasks like TTS/STT. All components communicate over a Tailscale mesh VPN.

```
┌─────────────────────────────────────────────────────────────────┐
│                        TAILSCALE MESH                            │
│                                                                   │
│  ┌─────────────────────────────────────────────┐                 │
│  │          UBUNTU SERVER (Brain)               │                 │
│  │                                               │                 │
│  │  ┌─────────────────────────────────────────┐ │                 │
│  │  │            EIDOLON CORE                  │ │                 │
│  │  │                                          │ │                 │
│  │  │  ┌───────────────────────────────────┐  │ │                 │
│  │  │  │        COGNITIVE LOOP              │  │ │                 │
│  │  │  │  Perceive > Evaluate > Act > Dream │  │ │                 │
│  │  │  └──────────────┬────────────────────┘  │ │                 │
│  │  │                 │                        │ │                 │
│  │  │  ┌──────────────┴────────────────────┐  │ │                 │
│  │  │  │          EVENT BUS                 │  │ │                 │
│  │  │  └─┬────┬────┬────┬────┬────┬────┬───┘  │ │                 │
│  │  │    │    │    │    │    │    │    │       │ │                 │
│  │  │  ┌─┴──┐│┌───┴┐┌──┴─┐┌─┴──┐│┌───┴─┐    │ │                 │
│  │  │  │Mem │││Chan││Self││GPU │││ WS   │    │ │                 │
│  │  │  │ory │││nels││Lrn ││Mgr │││ Gate │    │ │                 │
│  │  │  └────┘│└────┘└────┘└────┘│└──────┘    │ │                 │
│  │  │        │                   │            │ │                 │
│  │  │  ┌─────┴───────────────────┴─────────┐ │ │                 │
│  │  │  │    CLAUDE CODE (managed process)   │ │ │                 │
│  │  │  │    OAuth + API Keys                │ │ │                 │
│  │  │  │    Multi-Account Rotation           │ │ │                 │
│  │  │  └───────────────────────────────────┘ │ │                 │
│  │  └─────────────────────────────────────────┘ │                 │
│  └─────────────────────────────────────────────┘                 │
│                        │                                          │
│    ┌───────────────────┼──────────────────────┐                  │
│    │                   │                      │                   │
│  ┌─┴──────────┐  ┌────┴─────────┐  ┌─────────┴──────┐          │
│  │WINDOWS GPU │  │  MACBOOK     │  │  iPHONE/iPAD   │          │
│  │            │  │              │  │                │          │
│  │ GPU Worker │  │ Tauri Client │  │  Swift App     │          │
│  │ (Qwen3TTS) │  │ (deep access)│  │  (voice, chat) │          │
│  │            │  │              │  │                │          │
│  │ Tauri      │  │              │  │                │          │
│  │ Client     │  │              │  │                │          │
│  └────────────┘  └──────────────┘  └────────────────┘          │
│                                                                   │
│  ┌──────────────────────────────────────────────┐                │
│  │  TELEGRAM BOT (Primary Channel)              │                │
│  └──────────────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### Core Daemon

The single long-running process that IS Eidolon. Runs on the central server.

| Subsystem | Responsibility |
|---|---|
| **Cognitive Loop** | Continuous perceive-evaluate-act-dream cycle. Replaces cron/heartbeat. |
| **Event Bus** | Internal pub/sub for decoupled communication between subsystems. |
| **Claude Code Manager** | Spawns and manages Claude Code CLI subprocesses. Multi-account rotation. |
| **Memory Engine** | Auto-extraction, vector search, dreaming consolidation. |
| **Self-Learning Engine** | Discovery, relevance filtering, implementation pipeline. |
| **Channel Manager** | Telegram bot, future channels. Inbound/outbound message routing. |
| **GPU Manager** | Discovery and communication with GPU worker nodes. |
| **WebSocket Gateway** | API for desktop/iOS clients and remote nodes. |
| **Security Module** | Encrypted secrets, action policies, audit trail. |
| **Config System** | Configuration loading, validation, hot-reload. |

### GPU Worker

A separate Python service running on a machine with a GPU (e.g., Windows PC with RTX 5080).

| Subsystem | Responsibility |
|---|---|
| **TTS Service** | Qwen3-TTS text-to-speech generation (streaming + batch). |
| **STT Service** | Whisper speech-to-text transcription. |
| **Health Reporter** | GPU status, VRAM usage, temperature monitoring. |

### Desktop Clients (Tauri)

Native apps for macOS, Windows, and Linux that connect to the Core via WebSocket.

| Capability | Description |
|---|---|
| **Chat Interface** | Send/receive messages, view conversation history. |
| **Memory Browser** | Search and browse the memory database. |
| **Learning Dashboard** | View discovered content, approve implementations. |
| **System Access** | Execute commands on the local machine (deep access node). |
| **Voice Mode** | Talk to Eidolon using microphone/speakers via GPU worker. |
| **System Tray** | Background operation with status indicator. |

### iOS App

Native Swift app for iPhone and iPad.

| Capability | Description |
|---|---|
| **Chat** | Text messaging with Eidolon. |
| **Voice** | Talk mode using Qwen3-TTS for responses. |
| **Push Notifications** | Alerts from Eidolon (learning findings, reminders). |
| **Canvas** | Visual output surface for rich content. |

## Multi-Session Orchestration

Eidolon is not a single-threaded chatbot. It manages multiple concurrent activities -- a user conversation, a background learning crawl, a scheduled task, dreaming -- all at the same time. These sessions can communicate with each other, and Eidolon maintains oversight of all of them.

### The Session Supervisor

The Session Supervisor is the central coordinator. It tracks all active sessions, routes events between them, manages shared resources (energy budget, memory access), and ensures nothing conflicts.

```
┌──────────────────────────────────────────────────────────────┐
│                    SESSION SUPERVISOR                          │
│                                                                │
│  ┌──────────────────────────────────────────────────────┐    │
│  │                  SESSION REGISTRY                     │    │
│  │                                                       │    │
│  │  main-session      [ACTIVE]   User conversation      │    │
│  │  learning-001      [ACTIVE]   Reddit crawl            │    │
│  │  task-daily-report [WAITING]  Scheduled for 18:00     │    │
│  │  dream-session     [IDLE]     Next at 02:00           │    │
│  │  voice-pipeline    [ACTIVE]   TTS/STT processing      │    │
│  └──────────────────────────────────────────────────────┘    │
│                          │                                    │
│  ┌───────────────────────┴──────────────────────────────┐    │
│  │                  INTER-SESSION BUS                     │    │
│  │                                                        │    │
│  │  learning-001 → main-session:                          │    │
│  │    "Found relevant article about sqlite-vec 0.2.0"     │    │
│  │                                                        │    │
│  │  main-session → task-daily-report:                     │    │
│  │    "User wants the report format changed"              │    │
│  │                                                        │    │
│  │  voice-pipeline → main-session:                        │    │
│  │    "Transcription: 'Was gibt es Neues?'"               │    │
│  └────────────────────────────────────────────────────────┘   │
│                          │                                    │
│  ┌───────────────────────┴──────────────────────────────┐    │
│  │               RESOURCE MANAGER                        │    │
│  │                                                       │    │
│  │  Energy Budget:  38,500 / 50,000 tokens remaining     │    │
│  │  Claude Accounts: OAuth#1 [active], API#1 [standby]   │    │
│  │  GPU Workers:     windows-5080 [online, 42% util]     │    │
│  │  Memory Lock:     None (concurrent reads OK)          │    │
│  └───────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### Session Types and Concurrency

| Session Type | Max Concurrent | Priority | Claude Code Process | Interruptible |
|---|---|---|---|---|
| `main` (user conversation) | 1 | Highest | Persistent (warm) | No |
| `task` (scheduled tasks) | 2 | High | On-demand | Yes (by user msg) |
| `learning` (discovery/impl) | 1 | Low | On-demand, worktree | Yes |
| `dream` (memory consolidation) | 1 | Lowest | On-demand | Yes |
| `voice` (TTS/STT pipeline) | 1 | High (time-sensitive) | No Claude (GPU only) | No |

**Concurrency rules:**
- User conversation ALWAYS takes priority. If a learning session is running and a user message arrives, the learning session is paused (not killed) and the user message is processed first.
- Maximum 3 concurrent Claude Code processes to prevent resource exhaustion.
- The voice pipeline runs independently (GPU worker, no Claude Code) and does not compete for LLM resources.

### Inter-Session Communication

Sessions communicate through the Event Bus with typed messages:

```typescript
interface SessionMessage {
  from: string;        // Source session ID
  to: string;          // Target session ID (or '*' for broadcast)
  type: string;        // Message type
  payload: unknown;    // Typed per message type
  priority: 'low' | 'normal' | 'high';
}

// Example message types:
type SessionMessageTypes = {
  // Learning → Main: notify about discovery
  'learning.found': { discoveryId: string; title: string; score: number };
  
  // Main → Learning: user approved implementation
  'learning.approved': { proposalId: string };
  
  // Voice → Main: transcribed audio
  'voice.transcription': { text: string; language: string; confidence: number };
  
  // Main → Voice: generate speech
  'voice.synthesize': { text: string; replyTo: string };
  
  // Task → Main: task result
  'task.completed': { taskId: string; result: string };
  
  // Any → Supervisor: request resource
  'resource.request': { type: 'claude' | 'gpu'; urgency: 'normal' | 'immediate' };
  
  // Supervisor → Any: session control
  'session.pause': { reason: string };
  'session.resume': {};
  'session.terminate': { reason: string };
};
```

### Coordination Patterns

**Pattern 1: Voice Conversation**
Multiple sessions collaborate for a single voice interaction:

```
User speaks into MacBook microphone
  → Desktop client captures audio
  → Sends to Core via WebSocket
  → Core routes to voice-pipeline session
  → voice-pipeline sends audio to GPU Worker (Whisper STT)
  → GPU Worker returns transcription
  → voice-pipeline sends 'voice.transcription' to main-session
  → main-session processes with Claude Code
  → main-session sends 'voice.synthesize' to voice-pipeline
  → voice-pipeline sends text to GPU Worker (Qwen3-TTS)
  → GPU Worker streams audio back
  → Core routes audio to Desktop client
  → Desktop plays through speakers
```

**Pattern 2: Learning with User Notification**
Background learning discovers something and involves the user:

```
learning session crawls Reddit during idle
  → Finds interesting article (score: 85)
  → Sends 'learning.found' to main-session
  → Supervisor routes notification to user's active channel (Telegram)
  → "I found something interesting: sqlite-vec 0.2.0..."
  → User replies "implement it"
  → Supervisor sends 'learning.approved' to learning session
  → learning session starts implementation in git worktree
  → On completion, sends 'task.completed' to Supervisor
  → User gets notified: "Done. Branch learning/sqlite-vec-0.2.0 ready."
```

**Pattern 3: Concurrent User Chat + Background Task**
A scheduled task runs while the user is chatting:

```
task-daily-report triggers at 18:00
  → Supervisor checks: main-session is active (user chatting)
  → Assigns task to a separate Claude Code process
  → task runs in parallel, lower priority
  → User conversation is unaffected
  → task completes, sends result via Event Bus
  → Supervisor queues notification (waits for conversation pause)
  → User finishes conversation
  → "Your daily report is ready: ..."
```

### Shared State Management

All sessions share access to:
- **Memory Engine** (SQLite with WAL mode -- concurrent reads are safe, writes are serialized)
- **Configuration** (read-only for sessions, only Supervisor can hot-reload)
- **Audit Log** (append-only, concurrent writes safe via SQLite WAL)
- **Energy Budget** (managed by Supervisor, sessions request allocation)

Sessions do NOT share:
- **Claude Code process state** (each session has its own subprocess)
- **Workspace directories** (isolated per session type)
- **Git branches** (learning sessions use worktrees)

## Communication Protocols

### Core <-> Clients: WebSocket + JSON-RPC

All client communication uses WebSocket with JSON-RPC 2.0 payloads.

```
Client                          Core
  │                               │
  │─── connect {auth, device} ──>│
  │<── connected {caps, state} ──│
  │                               │
  │─── rpc:chat.send {text} ────>│
  │<── event:chat.stream {delta} │  (streaming)
  │<── event:chat.stream {delta} │
  │<── rpc:chat.send {result} ──>│  (final)
  │                               │
  │<── event:memory.update ──────│  (push)
  │<── event:learning.found ─────│  (push)
  │                               │
  │─── rpc:node.exec {cmd} ─────>│  (client as node)
  │<── rpc:node.exec {result} ──>│
```

### Core <-> GPU Worker: HTTP/gRPC over Tailscale

GPU workers expose a REST/gRPC API for compute requests.

```
Core                           GPU Worker
  │                               │
  │── POST /tts/stream {text} ──>│
  │<── SSE: audio chunks ────────│
  │                               │
  │── POST /stt/transcribe ─────>│
  │   {audio_bytes}               │
  │<── {text, language, conf} ───│
  │                               │
  │── GET /health ───────────────>│
  │<── {gpu_util, vram, temp} ───│
```

### Core <-> Telegram: grammY Bot API

Standard Telegram Bot API via the grammY library. Long polling or webhook mode.

## Data Flow: Message Lifecycle

When a user sends a message via Telegram:

```
1. Telegram API delivers message to grammY handler
2. Channel Manager creates InboundMessage event
3. Event Bus notifies Cognitive Loop
4. Cognitive Loop evaluates priority (user message = highest)
5. Memory Engine retrieves relevant context
6. Workspace is prepared with injected memory files
7. Claude Code subprocess is spawned/resumed
8. Claude processes the message with full tool access
9. Response is streamed back
10. Channel Manager sends response to Telegram
11. Memory Extractor analyzes the conversation turn
12. Facts, decisions, and action items are stored in short-term memory
13. Cognitive Loop returns to perceive state
```

## Data Storage

All persistent state lives in a single directory (`~/.eidolon/` by default).

```
~/.eidolon/
├── eidolon.json               # Main configuration
├── secrets.enc                # AES-256 encrypted secrets
├── eidolon.db                 # SQLite: memory, sessions, audit, state
├── workspaces/
│   ├── main/                  # Main conversation workspace
│   │   ├── CLAUDE.md          # Injected system prompt
│   │   ├── MEMORY.md          # Injected relevant memories
│   │   ├── SOUL.md            # Personality & behavior
│   │   └── skills/            # Learned procedures
│   └── learning/              # Self-learning workspace
│       └── ...
├── journal/                   # Learning journal (markdown)
│   └── YYYY-MM-DD.md
└── logs/
    ├── daemon.log
    └── audit.log
```

### SQLite Schema (Conceptual)

```sql
-- Memory: extracted facts and knowledge
CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,          -- 'fact', 'decision', 'preference', 'rule', 'episode'
    content TEXT NOT NULL,
    source TEXT,                 -- 'conversation', 'learning', 'dreaming', 'manual'
    confidence REAL DEFAULT 1.0,
    embedding BLOB,             -- Vector embedding for semantic search
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,             -- NULL = permanent
    meta TEXT                   -- JSON metadata
);

-- Sessions: conversation tracking
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,       -- 'telegram', 'desktop', 'cli'
    peer_id TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    token_count INTEGER DEFAULT 0,
    meta TEXT
);

-- Audit: every action logged
CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    action TEXT NOT NULL,        -- 'shell_exec', 'file_write', 'api_call', ...
    classification TEXT,         -- 'safe', 'needs_approval', 'dangerous'
    approved_by TEXT,            -- NULL, 'auto', 'user'
    details TEXT,                -- JSON
    session_id TEXT
);

-- Learning: discovered content and status
CREATE TABLE discoveries (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,        -- 'reddit', 'hackernews', 'github', 'rss'
    url TEXT,
    title TEXT,
    summary TEXT,
    relevance_score REAL,
    status TEXT DEFAULT 'new',   -- 'new', 'reviewed', 'integrated', 'implemented', 'dismissed'
    created_at TEXT NOT NULL,
    meta TEXT
);

-- State: daemon operational state
CREATE TABLE state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
);
```

## Monorepo Structure

```
eidolon/
├── .github/
│   └── workflows/
│       ├── ci.yml                     # Test + Lint + Type-Check
│       ├── release-cli.yml            # npm publish @eidolon-ai/cli
│       ├── release-desktop.yml        # Tauri builds (macOS/Win/Linux)
│       └── release-docker.yml         # Docker image
│
├── packages/
│   ├── core/                          # ~5000-8000 lines - THE BRAIN
│   │   ├── src/
│   │   │   ├── index.ts               # Entry: Daemon Start
│   │   │   ├── loop.ts                # Cognitive Loop
│   │   │   ├── brain.ts               # Claude Code Manager
│   │   │   ├── events.ts              # Event Bus
│   │   │   ├── memory/
│   │   │   │   ├── engine.ts          # Memory Lifecycle
│   │   │   │   ├── extractor.ts       # Auto-Extract from conversations
│   │   │   │   ├── dreaming.ts        # Dreaming Consolidation
│   │   │   │   ├── search.ts          # Vector + BM25 Hybrid Search
│   │   │   │   └── store.ts           # SQLite Store
│   │   │   ├── learning/
│   │   │   │   ├── engine.ts          # Self-Learning Coordinator
│   │   │   │   ├── discovery.ts       # Source Crawling
│   │   │   │   ├── classifier.ts      # Safe/Approval/Dangerous
│   │   │   │   └── implementer.ts     # Auto-Implementation Pipeline
│   │   │   ├── channels/
│   │   │   │   ├── manager.ts         # Channel Registry
│   │   │   │   ├── telegram.ts        # Telegram (grammY)
│   │   │   │   └── types.ts           # Channel Interface
│   │   │   ├── gateway/
│   │   │   │   ├── server.ts          # WebSocket Server
│   │   │   │   └── protocol.ts        # JSON-RPC
│   │   │   ├── gpu/
│   │   │   │   ├── manager.ts         # GPU Node Discovery
│   │   │   │   └── tts.ts             # TTS/STT Client
│   │   │   ├── security/
│   │   │   │   ├── secrets.ts         # Encrypted Secret Store
│   │   │   │   ├── policies.ts        # Action Classification
│   │   │   │   └── audit.ts           # Audit Trail
│   │   │   └── config.ts              # Configuration Schema + Loader
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── cli/                           # CLI Tool
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── commands/
│   │   │       ├── onboard.ts         # Setup Wizard
│   │   │       ├── daemon.ts          # start/stop/status/logs
│   │   │       ├── chat.ts            # Interactive Chat
│   │   │       ├── memory.ts          # Memory inspect/search/dream
│   │   │       ├── learning.ts        # Learning status/sources/approve
│   │   │       ├── secrets.ts         # Secrets management
│   │   │       └── doctor.ts          # Health check
│   │   └── package.json
│   │
│   └── protocol/                      # Shared Types (used by core + clients)
│       ├── src/
│       │   ├── messages.ts
│       │   ├── events.ts
│       │   └── rpc.ts
│       └── package.json
│
├── apps/
│   ├── desktop/                       # Tauri 2.0 Desktop App
│   │   ├── src-tauri/
│   │   │   └── src/
│   │   │       ├── main.rs
│   │   │       ├── system.rs          # Deep System Access
│   │   │       └── tray.rs            # System Tray
│   │   └── src/                       # Svelte Frontend
│   │       ├── App.svelte
│   │       └── views/
│   │
│   ├── ios/                           # Swift App
│   │   └── Eidolon/
│   │       ├── EidolonApp.swift
│   │       ├── Views/
│   │       └── Services/
│   │
│   └── web/                           # Web Dashboard
│       └── src/
│
├── services/
│   └── gpu-worker/                    # Python GPU Service
│       ├── src/
│       │   ├── main.py                # FastAPI Server
│       │   ├── tts.py                 # Qwen3-TTS
│       │   └── stt.py                 # Whisper
│       ├── pyproject.toml
│       └── Dockerfile.cuda
│
├── workspace/                         # Template workspace files
│   ├── SOUL.md
│   ├── CLAUDE.md
│   └── skills/
│
├── docs/                              # Documentation
├── docker-compose.yml
├── package.json                       # Root (pnpm workspace)
├── pnpm-workspace.yaml
├── tsconfig.json
├── LICENSE
└── README.md
```

## Technology Decisions

### Why TypeScript + Bun (not Go, not Python, not Rust)

| Option | Pros | Cons | Decision |
|---|---|---|---|
| **TypeScript + Bun** | Cross-platform, async-native, SQLite built-in, WebSocket-native, npm distribution, same ecosystem as OpenClaw skills | Slower than Go/Rust | **Chosen.** Best balance of developer productivity, ecosystem, and cross-platform support. |
| Go | Fast single binary, great concurrency | No npm ecosystem, harder async patterns, no native SQLite | Rejected. PicoClaw proves it works but ecosystem is limited. |
| Python | Best ML/AI libraries, simplest code | Slow, GIL issues, distribution is painful, dependency hell | Rejected for core. **Used for GPU worker only.** |
| Rust | Maximum performance, memory safety | Slow development, steep learning curve, over-engineered for this | Rejected. Used via Tauri for desktop apps only. |

### Why Claude Code CLI (not custom agent runtime)

The most impactful architectural decision. See [Claude Integration](CLAUDE_INTEGRATION.md) for full rationale.

**Summary:** Building a custom agent runtime is 80% of OpenClaw's codebase. Claude Code CLI provides shell execution, filesystem access, web search, code generation, and tool calling out of the box. We wrap it as a managed subprocess and focus our code on what makes Eidolon unique.

### Why SQLite (not Postgres, not files)

- Single file, zero configuration, zero dependencies
- Bun has native SQLite bindings (no native modules)
- sqlite-vec extension for vector search
- Full-text search (FTS5) built in
- WAL mode for concurrent reads
- Used by nanoclaw, SafePilot, and others successfully
- Backup = copy one file

### Why Tauri (not Electron, not web-only)

- ~5MB binary vs ~150MB for Electron
- Native system access via Rust plugins
- Cross-platform: macOS, Windows, Linux from one codebase
- Active development, strong community
- Built-in auto-update mechanism
- Security: no Node.js in the renderer

### Why Local Embeddings (not OpenAI, not cloud-only)

Vector search requires text embeddings. Rather than depending on an external API (adding cost, latency, and another API key), Eidolon uses a local embedding model by default.

**Default: `all-MiniLM-L6-v2` via `@huggingface/transformers`**

| Aspect | Local (default) | Voyage AI | OpenAI |
|---|---|---|---|
| Model | all-MiniLM-L6-v2 (22M params) | voyage-3-lite | text-embedding-3-small |
| Dimensions | 384 | 512 | 1536 |
| Speed | ~5ms per embedding (CPU) | ~100ms (network) | ~100ms (network) |
| Cost | Free | ~$0.02/1M tokens | ~$0.02/1M tokens |
| Dependency | `@huggingface/transformers` (ONNX) | API key required | API key required |
| Offline | Yes | No | No |
| Quality | Good (sufficient for memory search) | Excellent | Excellent |

**Rationale:** For personal memory search (~10K memories), local embedding quality is sufficient. The model is ~23MB, loads once at startup, and produces embeddings in single-digit milliseconds. If higher quality is needed, Voyage AI or OpenAI can be configured as alternatives.

**Implementation:** The embedding provider is pluggable via config (`memory.search.embedding.provider`). The `MemorySearch` module calls the configured provider and stores the resulting vectors in sqlite-vec.

### Why Tailscale (not direct connections, not SSH tunnels)

- Already deployed in the target environment
- Zero-config encrypted mesh networking
- WireGuard-based (fast, low overhead)
- MagicDNS for hostname resolution
- ACLs for access control
- Works across NATs without port forwarding
