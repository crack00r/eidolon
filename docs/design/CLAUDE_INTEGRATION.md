# Claude Code Integration

## Why Claude Code CLI as Execution Engine

The single most impactful architectural decision in Eidolon.

### The Problem with Custom Agent Runtimes

OpenClaw built its own agent runtime (`@mariozechner/pi-coding-agent`). This includes:
- Tool discovery and registration
- Shell command execution
- File system operations (read, write, edit, glob, grep)
- Web browsing (CDP control)
- Session management within the agent
- Streaming response handling
- Error recovery and retries
- Context window management
- Model-specific prompt formatting

This is approximately 80% of OpenClaw's codebase. It's also the source of most bugs.

### The Solution: Use Claude Code

Claude Code CLI is Anthropic's official coding agent. It already provides:
- Shell execution (Bash, PowerShell)
- Filesystem operations (Read, Write, Edit, Glob, Grep)
- Web search and fetching
- Code analysis and generation
- Tool calling with built-in safety checks
- Streaming JSON output
- OAuth authentication (Anthropic Max subscription)
- Context window management and compaction
- Multi-model support

By using Claude Code CLI as a managed subprocess, we get all of this for free. Our code only handles what makes Eidolon unique:
- Cognitive Loop (when and why to think)
- Memory Engine (what to remember)
- Self-Learning (what to discover and implement)
- Channel Management (where to communicate)
- GPU/Voice (how to speak)
- Multi-device orchestration

### Cost Comparison

| Aspect | Custom Runtime (OpenClaw) | Claude Code CLI (Eidolon) |
|---|---|---|
| Agent runtime code | ~100k lines | 0 lines (provided by CLI) |
| Tool implementation | ~50k lines | 0 lines (built-in) |
| Maintenance burden | Constant (model API changes, new tools) | Anthropic maintains it |
| Our unique code | ~300k lines (bloated) | ~8k lines (focused) |
| Bug surface | Enormous | Small (our code) + Anthropic's testing |

## Integration Architecture

```
┌──────────────────────────────────────────────┐
│              EIDOLON CORE                     │
│                                               │
│  ┌─────────────────────────────────────────┐ │
│  │         ClaudeCodeManager               │ │
│  │                                          │ │
│  │  ┌──────────┐  ┌─────────────────────┐ │ │
│  │  │ Account  │  │  Session Pool       │ │ │
│  │  │ Rotation │  │                     │ │ │
│  │  │          │  │  main-session ──┐   │ │ │
│  │  │ OAuth #1 │  │  learning-sess  │   │ │ │
│  │  │ OAuth #2 │  │  task-sess-001  │   │ │ │
│  │  │ API #1   │  │  ...            │   │ │ │
│  │  │ API #2   │  │                 │   │ │ │
│  │  └──────────┘  └─────────┬───────┘   │ │ │
│  │                          │            │ │ │
│  │                    ┌─────▼──────┐     │ │ │
│  │                    │ Workspace  │     │ │ │
│  │                    │ Preparer   │     │ │ │
│  │                    │            │     │ │ │
│  │                    │ Injects:   │     │ │ │
│  │                    │ CLAUDE.md  │     │ │ │
│  │                    │ MEMORY.md  │     │ │ │
│  │                    │ SOUL.md    │     │ │ │
│  │                    │ skills/    │     │ │ │
│  │                    └─────┬──────┘     │ │ │
│  │                          │            │ │ │
│  │                    ┌─────▼──────┐     │ │ │
│  │                    │Claude Code │     │ │ │
│  │                    │   CLI      │     │ │ │
│  │                    │ (subprocess│     │ │ │
│  │                    │  --json)   │     │ │ │
│  │                    └─────┬──────┘     │ │ │
│  │                          │            │ │ │
│  │                    ┌─────▼──────┐     │ │ │
│  │                    │  Response  │     │ │ │
│  │                    │  Parser    │     │ │ │
│  │                    │  (stream)  │     │ │ │
│  │                    └────────────┘     │ │ │
│  └─────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

## Multi-Account Management

### Account Types

```typescript
interface ClaudeAccount {
  id: string;
  name: string;
  type: 'oauth' | 'api-key';
  priority: number;              // Lower = preferred

  // OAuth accounts (Anthropic Max subscription)
  oauthToken?: string;           // Managed by claude CLI login
  oauthExpiry?: Date;

  // API key accounts
  apiKey?: string;               // Reference to encrypted secret

  // Runtime state
  model: string;                 // Default model for this account
  rateLimitRemaining?: number;
  cooldownUntil?: Date;
  totalTokensUsed: number;
  lastUsed?: Date;
}
```

### Rotation Strategy

```typescript
class AccountRotation {
  /**
   * Select the best account for a request.
   * 
   * Priority order:
   * 1. OAuth accounts first (free with subscription)
   * 2. Among same type: lowest priority number
   * 3. Among same priority: most remaining rate limit
   * 4. Skip accounts in cooldown
   */
  getNext(accounts: ClaudeAccount[]): ClaudeAccount {
    const available = accounts
      .filter(a => !a.cooldownUntil || a.cooldownUntil < new Date())
      .sort((a, b) => {
        // OAuth first
        if (a.type === 'oauth' && b.type !== 'oauth') return -1;
        if (a.type !== 'oauth' && b.type === 'oauth') return 1;
        // Then by priority
        if (a.priority !== b.priority) return a.priority - b.priority;
        // Then by remaining rate limit
        return (b.rateLimitRemaining ?? Infinity) - (a.rateLimitRemaining ?? Infinity);
      });

    if (available.length === 0) {
      throw new AllAccountsExhaustedError();
    }

    return available[0];
  }

  markCooldown(account: ClaudeAccount, retryAfterMs: number): void {
    account.cooldownUntil = new Date(Date.now() + retryAfterMs);
  }

  markUsage(account: ClaudeAccount, tokensUsed: number): void {
    account.totalTokensUsed += tokensUsed;
    account.lastUsed = new Date();
  }
}
```

### Failover Behavior

```
Request arrives
    │
    ▼
Select Account (OAuth #1, priority 1)
    │
    ├── Success → Return response
    │
    ├── Rate limit 429 → Mark cooldown → Try OAuth #2
    │   │
    │   ├── Success → Return response
    │   │
    │   ├── Rate limit 429 → Mark cooldown → Try API Key #1
    │   │   │
    │   │   ├── Success → Return response
    │   │   │
    │   │   └── Rate limit 429 → Try API Key #2
    │   │       │
    │   │       └── All exhausted → Wait for shortest cooldown
    │   │
    │   └── Auth error → Refresh OAuth token → Retry
    │
    └── Auth error → Refresh OAuth token → Retry
```

## Workspace Preparation

Before each Claude Code session, Eidolon prepares a workspace directory with injected context files.

### Workspace Layout

```
~/.eidolon/workspaces/<session-id>/
├── CLAUDE.md         # System prompt and rules for Claude Code
├── MEMORY.md         # Relevant memories (dynamically injected)
├── SOUL.md           # Personality and behavior guidelines
├── CONTEXT.md        # Current context (active tasks, recent events)
└── skills/           # Learned procedures
    ├── check-gpu.md
    └── deploy.md
```

### CLAUDE.md Template

```markdown
# Eidolon System Instructions

You are Eidolon, an autonomous personal AI assistant.

## Identity
- You are running as a daemon on an Ubuntu server
- Your user is {user.name} in timezone {user.timezone}
- Current time: {current_time}

## Capabilities
- Full filesystem access to this workspace
- Shell command execution (bash)
- Web search and page fetching
- Code editing and generation

## Rules
- Read MEMORY.md for context about the user and previous conversations
- Read SOUL.md for personality guidelines
- When you learn something new about the user, state it explicitly so it can be extracted
- When making decisions, explain your reasoning
- For external actions (emails, messages, API calls), always confirm with the user first
- Never store secrets in files; use the secrets management system

## Current Session
- Channel: {channel}
- Session type: {session_type}
- Previous summary: {session_summary}
```

## Session Management

### Session Types

| Type | Purpose | Workspace | Persistence |
|---|---|---|---|
| `main` | Primary conversation | `workspaces/main/` | Persistent |
| `learning` | Self-learning tasks | `workspaces/learning/` | Per-task |
| `task:<id>` | Scheduled tasks | `workspaces/tasks/<id>/` | Per-task |
| `dream` | Memory consolidation | `workspaces/dream/` | Ephemeral |

### Claude Code CLI Invocation

```typescript
class ClaudeCodeSession {
  private process: ChildProcess;

  async start(message: string, options: SessionOptions): Promise<void> {
    const account = await this.accountRotation.getNext();
    
    // Prepare workspace (writes CLAUDE.md, MEMORY.md, SOUL.md)
    await this.prepareWorkspace(options);
    
    // Build CLI arguments
    const args = [
      '-p',                                // Print mode (non-interactive)
      '--output-format', 'stream-json',    // Streaming JSON output
      '--model', options.model || account.model,
      '--max-turns', String(options.maxTurns || 25),
    ];

    // Session continuity: resume or start new
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    } else {
      args.push('--session-id', options.sessionId);
    }

    // Dynamic context injection (time, state, energy)
    args.push('--append-system-prompt', this.buildDynamicContext());

    // Cost control for background tasks
    if (options.maxBudgetUsd) {
      args.push('--max-budget-usd', String(options.maxBudgetUsd));
    }

    // Model fallback when primary is overloaded
    if (options.fallbackModel) {
      args.push('--fallback-model', options.fallbackModel);
    }

    // Learning: isolated git worktree
    if (options.type === 'learning') {
      args.push('--worktree', `learning-${options.taskId}`);
    }

    // Permission handling
    if (options.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    // The message is the final positional argument
    args.push(message);

    // Spawn Claude Code CLI
    this.process = spawn('claude', args, {
      cwd: this.workspacePath,
      env: {
        ...process.env,
        // OAuth: Claude Code handles its own auth
        // API Key: Set if using API key account
        ...(account.type === 'api-key' ? {
          ANTHROPIC_API_KEY: await this.secrets.decrypt(account.apiKey!)
        } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  async *streamResponses(): AsyncGenerator<StreamEvent> {
    // Parse streaming JSON from stdout
    for await (const line of this.readLines(this.process.stdout)) {
      const event = JSON.parse(line);
      yield this.parseEvent(event);
    }
  }
}
```

### Stream Event Types

Claude Code CLI outputs streaming JSON events:

```typescript
type StreamEvent =
  | { type: 'assistant'; content: string }          // Text delta
  | { type: 'tool_use'; tool: string; input: any }  // Tool invocation
  | { type: 'tool_result'; output: string }          // Tool result
  | { type: 'error'; message: string }               // Error
  | { type: 'done'; usage: TokenUsage }              // Complete
```

## OAuth Setup

### Initial Setup (via `eidolon onboard`)

```
$ eidolon onboard

Welcome to Eidolon!

Step 1: Claude Authentication
You need at least one Claude account. OAuth (Anthropic Max subscription) is recommended.

Option A: OAuth (recommended)
  Run 'claude login' to authenticate via browser.
  This uses your Anthropic Max/Pro subscription.

Option B: API Key
  Enter your Anthropic API key.
  Keys are encrypted at rest.

[A/B]: A
Running 'claude login'...
✓ Authenticated as manuel@example.com

Add another account for failover? [y/N]: y
Option [A/B]: B
Enter API key: sk-ant-...
✓ API key encrypted and stored

Step 2: Telegram Bot (optional)
...
```

### OAuth Token Refresh

Claude Code CLI manages OAuth token refresh internally. If a token expires mid-session, Claude Code handles the refresh. If refresh fails, Eidolon catches the auth error and falls back to the next account.

## Session Resumption

Claude Code CLI supports session persistence natively. Eidolon leverages this for conversation continuity.

### How It Works

Each Eidolon session maps to a Claude Code session ID (UUID). When a conversation continues, Eidolon resumes the existing Claude Code session instead of starting a new one.

```
First message:
  claude -p --output-format stream-json \
    --session-id "550e8400-e29b-41d4-a716-446655440000" \
    --model claude-sonnet-4-6 \
    --max-turns 25 \
    "Hello, what's on my schedule?"

Follow-up:
  claude -p --output-format stream-json \
    --resume "550e8400-e29b-41d4-a716-446655440000" \
    "And what about tomorrow?"
```

### Session Lifecycle

```
New conversation
  → Generate UUID
  → Store in sessions table
  → Spawn claude -p --session-id <uuid>
  → Parse streaming response
  → Session persisted by Claude Code automatically

Follow-up message
  → Look up session UUID from sessions table
  → Spawn claude -p --resume <uuid>
  → Full conversation history is available to Claude
  → No need to re-inject context

Session timeout (configurable, default 1h)
  → Mark session as expired
  → Next message starts a new session
  → Old session can still be resumed explicitly
```

### Key CLI Flags Used

| Flag | Purpose | Mode |
|---|---|---|
| `-p` / `--print` | Non-interactive mode (pipe in, stream out) | All sessions |
| `--output-format stream-json` | Streaming JSON events for parsing | All sessions |
| `--session-id <uuid>` | Assign a specific session ID | New sessions |
| `--resume <id>` | Resume an existing session | Follow-ups |
| `--model <name>` | Select model (per-account) | All sessions |
| `--max-turns <n>` | Limit agentic turns | All sessions |
| `--max-budget-usd <n>` | Cost ceiling per session | Learning/tasks |
| `--fallback-model <name>` | Auto-fallback when overloaded | All sessions |
| `--append-system-prompt` | Add Eidolon context to system prompt | All sessions |
| `--worktree <name>` | Isolated git worktree | Learning branches |
| `--agents` | Define subagents dynamically | Multi-task sessions |
| `--dangerously-skip-permissions` | Skip permission prompts | Trusted environments |
| `--allowedTools` | Restrict available tools | Sandboxed sessions |

### Memory Injection Strategy

Claude Code automatically reads `CLAUDE.md` from the working directory. Eidolon uses two complementary injection mechanisms:

1. **Workspace files:** `CLAUDE.md`, `MEMORY.md`, `SOUL.md` in the workspace directory are read by Claude Code automatically.
2. **System prompt append:** `--append-system-prompt` injects dynamic context (current time, active tasks, energy state) that changes per invocation.

```typescript
const args = [
  '-p',
  '--output-format', 'stream-json',
  '--model', account.model,
  '--max-turns', String(options.maxTurns || 25),
  '--session-id', sessionId,
  '--append-system-prompt', this.buildDynamicContext(),
];

// For learning sessions: use worktree for isolation
if (options.type === 'learning') {
  args.push('--worktree', `learning-${options.taskId}`);
  args.push('--max-budget-usd', '0.50');
}

// For sandboxed sessions: restrict tools
if (options.sandboxed) {
  args.push('--allowedTools', 'Read', 'Grep', 'Glob', 'Bash(ls *)', 'Bash(cat *)');
}
```

## Limitations and Mitigations

### Limitation: Claude Code CLI startup time

**Issue:** Spawning a new Claude Code process for each interaction adds ~2-3 seconds of latency.

**Mitigation:** Keep a warm process pool for the main session. Only cold-start for learning and task sessions.

### Limitation: Claude Code CLI is Claude-only

**Issue:** Cannot use other LLM providers (OpenAI, Gemini, local models) through Claude Code.

**Mitigation:** For the core use case (personal assistant), Claude is the target. For specific tasks where other models are needed (relevance filtering, embeddings), use direct API calls outside Claude Code.

### Limitation: Claude Code CLI updates may break integration

**Issue:** CLI output format or behavior may change between versions.

**Mitigation:** Pin Claude Code CLI version. Test integration before upgrading. Use the `--output-format stream-json` flag which is a stable API contract.
