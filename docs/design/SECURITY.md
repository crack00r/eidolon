# Security Model

> **Status: Implemented — v0.1.x. This document describes the design; see source code for implementation details.**
> Updated 2026-03-01 based on [expert review findings](../REVIEW_FINDINGS.md).

## Threat Landscape

A personal AI assistant with deep system access presents unique security challenges:

1. **Secret exposure:** API keys, OAuth tokens, and personal data must be protected at rest and in transit.
2. **Uncontrolled execution:** An LLM with shell access could execute dangerous commands.
3. **Prompt injection:** Malicious content from web scraping or messages could manipulate behavior.
4. **Self-modification risks:** A self-learning system that can modify its own code introduces recursive risk.
5. **Provider-side risks:** OAuth flows have caused permanent account bans (see OpenClaw #14203 where users lost Google accounts).

## Security Principles

1. **Encrypted by default.** All secrets encrypted at rest with AES-256-GCM.
2. **Classify before acting.** Every action is classified as safe/needs_approval/dangerous before execution.
3. **Audit everything.** Every action is logged with timestamp, classification, and outcome.
4. **Safe provider choices.** Only use OAuth flows that are documented and safe. No experimental auth.
5. **Sandbox when possible.** Untrusted execution runs in containers.
6. **Minimize attack surface.** Small codebase, few dependencies, focused scope.

## Secrets Management

### Problem with OpenClaw

OpenClaw stores API keys in plaintext in `~/.openclaw/openclaw.json`:
```json
{ "channels": { "telegram": { "botToken": "123456:ABCDEF" } } }
```

This means anyone with filesystem access has all credentials. OpenClaw issue #7916 requests encrypted secrets but it was never implemented.

### Eidolon's Approach

All secrets are encrypted at rest using AES-256-GCM with a key derived from a master password or system keychain.

```
~/.eidolon/
├── eidolon.json          # Configuration (NO secrets in here)
├── secrets.enc           # AES-256-GCM encrypted secret store
└── ...
```

### Secret Store Structure

```typescript
interface SecretStore {
  version: 1;
  encryption: {
    algorithm: 'aes-256-gcm';
    kdf: 'scrypt';             // Key derivation function (N=2^17, r=8, p=1)
    salt: string;              // Base64
    iv: string;                // Base64, per-entry
  };
  entries: {
    [key: string]: {
      value: string;           // Encrypted, base64
      iv: string;              // Unique IV per entry
      tag: string;             // GCM auth tag
      created: string;
      updated: string;
    };
  };
}
```

### Configuration References

Config files reference secrets by key, never by value:

```jsonc
{
  "channels": {
    "telegram": {
      "botToken": { "$secret": "TELEGRAM_BOT_TOKEN" }
    }
  },
  "brain": {
    "accounts": [
      {
        "type": "api-key",
        "keyRef": "ANTHROPIC_KEY_1"    // Reference to encrypted secret
      }
    ]
  }
}
```

### CLI Commands

```bash
# Set a secret
eidolon secrets set TELEGRAM_BOT_TOKEN
# (prompts for value, never shown in terminal history)

# List secrets (names only, not values)
eidolon secrets list

# Delete a secret
eidolon secrets delete TELEGRAM_BOT_TOKEN

# Export secrets (for backup, encrypted)
eidolon secrets export --output backup.enc

# Import secrets
eidolon secrets import --input backup.enc
```

### Master Key Management

| Platform | Key Storage |
|---|---|
| macOS | Keychain (via `security` CLI) |
| Linux | libsecret / GNOME Keyring / KDE Wallet |
| Windows | Windows Credential Manager |
| Fallback | scrypt-derived from master password |

## Action Classification

Every action the LLM performs is classified before execution.

### Classification Levels

| Level | Description | Behavior |
|---|---|---|
| `safe` | Read-only or internal operations | Executed automatically |
| `needs_approval` | Operations with side effects | User must approve first |
| `dangerous` | Operations that could cause harm | Blocked, logged, alert sent |

### Default Policies

```jsonc
{
  "security": {
    "policies": {
      // Filesystem
      "file_read": "safe",
      "file_write_workspace": "safe",
      "file_write_outside": "needs_approval",
      "file_delete": "needs_approval",

      // Shell
      "shell_read_only": "safe",           // ls, cat, grep, etc.
      "shell_write": "needs_approval",      // mkdir, cp, mv, etc.
      "shell_system": "dangerous",          // systemctl, reboot, etc.
      "shell_network": "needs_approval",    // curl, wget, ssh, etc.

      // External
      "api_call_read": "safe",
      "api_call_write": "needs_approval",
      "send_message": "needs_approval",
      "send_email": "dangerous",

      // Self-modification
      "modify_own_code": "needs_approval",
      "modify_config": "needs_approval",
      "modify_secrets": "dangerous",

      // Learning
      "store_memory": "safe",
      "implement_discovery": "needs_approval",

      // GPU/Voice
      "tts_generate": "safe",
      "stt_transcribe": "safe"
    }
  }
}
```

### Approval Flow

```
Action classified as 'needs_approval'
    │
    ▼
Send approval request to user (Telegram/Desktop)
    │
    ├── User replies 'approve' → Execute action → Log
    │
    ├── User replies 'deny' → Skip action → Log
    │
    ├── Timeout (5 min for interactive, 24h for learning)
    │   └── Skip action → Log
    │
    └── User replies 'always allow <pattern>'
        └── Update policy → Execute → Log
```

## Audit Trail

Every action is logged in the audit table:

```sql
CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    session_id TEXT,
    action TEXT NOT NULL,           -- 'shell_exec', 'file_write', etc.
    classification TEXT NOT NULL,   -- 'safe', 'needs_approval', 'dangerous'
    approved_by TEXT,               -- NULL, 'auto', 'user', 'policy'
    target TEXT,                    -- What was affected
    details TEXT,                   -- JSON: command, args, result, etc.
    success BOOLEAN,
    error TEXT
);
```

### CLI

```bash
# View recent audit entries
eidolon audit --since 24h

# Filter by classification
eidolon audit --classification needs_approval

# Filter by action type
eidolon audit --action shell_exec

# Export for review
eidolon audit --since 7d --format json > audit-export.json
```

## Provider Safety

### Lessons from OpenClaw

OpenClaw issue #14203: Users connected Google accounts via experimental Gemini CLI OAuth. Google permanently banned their accounts (personal AND work), with no recovery path. The OpenClaw maintainer's response was dismissive.

### Eidolon's Approach

1. **Only Anthropic OAuth.** We only support OAuth for Anthropic (Claude) where the flow is documented and sanctioned.
2. **API keys for everything else.** No experimental OAuth flows. If a provider needs a key, use a key.
3. **Explicit warnings.** If a user tries to configure an unsupported auth method, show a clear warning.
4. **No third-party OAuth proxies.** No redirecting through undocumented OAuth endpoints.

## Prompt Injection Defense

### Web Scraping (Self-Learning)

Content from the web (Reddit, HN, etc.) is treated as untrusted input:
- Scraped content is sanitized before being passed to the LLM
- Content is evaluated in a separate context (not in the main conversation)
- The relevance filter prompt explicitly instructs the model to evaluate, not execute
- No code from scraped content is executed without going through the full safety pipeline

### Inbound Messages

Messages from Telegram are treated as trusted (since the user whitelist controls who can send messages), but:
- Unknown senders are blocked (allowlist-based)
- Group messages (if enabled later) go through additional validation
- Media attachments are validated before processing

## Container Sandbox (Optional)

For higher security requirements, Claude Code can run inside a container:

```jsonc
{
  "security": {
    "sandbox": {
      "enabled": false,            // Enable container isolation
      "runtime": "docker",         // 'docker' or 'podman'
      "image": "eidolon-sandbox",  // Custom image with Claude Code
      "network": "none",           // No network access by default
      "mounts": [
        {
          "source": "~/.eidolon/workspaces",
          "target": "/workspace",
          "readonly": false
        }
      ]
    }
  }
}
```

## GPU Worker Authentication

> **Review finding C-4:** GPU worker port 8420 was exposed on Tailscale with no authentication.

All GPU worker endpoints require pre-shared key authentication:

```
Authorization: Bearer <GPU_WORKER_TOKEN>
```

The token is stored in the encrypted secret store and injected into both Core and GPU worker configuration:

```bash
# Set GPU worker token
eidolon secrets set GPU_WORKER_TOKEN

# Token is referenced in config
# gpu.workers[].authToken: { "$secret": "GPU_WORKER_TOKEN" }
```

The GPU worker validates the token on every request. Requests without a valid token receive `401 Unauthorized`.

**Token rotation:** `eidolon secrets rotate GPU_WORKER_TOKEN` generates a new token and restarts the GPU connection.

## API Key Isolation in Subprocess Environment

> **Review finding C-3:** Decrypted API keys were exposed in process environment variables.

API keys are **never** set in the parent process environment. They are passed only to the Claude Code subprocess via isolated environment:

```typescript
// CORRECT: key only exists in subprocess environment
const proc = spawn('claude', args, {
  env: {
    // Minimal env: only what Claude Code needs
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: decryptedKey,  // Only in this subprocess
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

// Parent process never has ANTHROPIC_API_KEY in its env
// Key is decrypted in-memory, passed to spawn(), then dereferenced
```

The decrypted key exists in memory only for the duration of the `spawn()` call. It is not stored in any file or persistent variable.

## Self-Learning Sandboxing

> **Review finding C-5:** Self-learning pipeline could become a prompt injection → RCE vector.

The self-learning pipeline has strict security boundaries:

1. **Content sanitization:** All scraped content is stripped of markdown injection patterns, code blocks with shell commands, and known prompt injection templates before LLM evaluation.
2. **Restricted evaluation context:** The relevance filter runs with `--allowedTools Read,Grep,Glob` — no shell execution, no file writing.
3. **Code changes always require approval:** Implementation is never auto-classified as `safe`. The user must explicitly approve every code change.
4. **Isolated execution:** All implementations run in a separate git worktree, never on the main branch.
5. **Auto-lint and test gate:** Code changes must pass lint and test before the merge option is even offered to the user.

## GDPR / Privacy

> **Review finding H-5:** Multiple GDPR compliance gaps identified.

### Right to Erasure

```bash
# Forget a specific entity (cascading delete from all tables)
eidolon privacy forget "entity name"

# Forget all memories from a date range
eidolon privacy forget --since 2026-01-01 --until 2026-01-31

# Full data wipe
eidolon privacy forget --all --confirm
```

The `forget` command performs cascading deletion:
1. Delete from `memories` table (matching content or entity)
2. Delete from `kg_entities` and `kg_relations` (matching entity)
3. Delete from `memory_edges` (referencing deleted memories)
4. Delete from `audit` table (referencing deleted sessions)
5. Regenerate MEMORY.md without deleted content

### Data Portability

```bash
# Export all personal data as JSON
eidolon privacy export --output eidolon-data.json

# Export format includes: memories, KG entities/relations, sessions, preferences
```

### Voice Data as Biometric Data

Voice recordings are biometric data under GDPR Art. 9. Requirements:
- Explicit opt-in consent on first voice use (stored in config)
- Voice data is not stored after transcription (STT result only)
- Consent can be withdrawn: `eidolon privacy revoke-voice-consent`

### Third-Party PII in Knowledge Graph

The KG extraction pipeline flags entities of type `person` (other than the user):
- Third-party persons require explicit user acknowledgment before storage
- `eidolon privacy list-third-parties` shows all stored third-party entities
- Third-party entities can be individually deleted

### MEMORY.md Transparency

MEMORY.md contents are sent to Anthropic's API as part of Claude Code sessions. The onboarding wizard requires explicit acknowledgment of this data flow.

## Security Checklist for Users

```
[ ] Master password set for secret store
[ ] All API keys stored via 'eidolon secrets set'
[ ] No plaintext secrets in eidolon.json
[ ] Telegram bot token in secret store
[ ] Gateway token set for WebSocket auth
[ ] GPU worker authentication token set
[ ] Tailscale ACLs configured for device access
[ ] Action policies reviewed and adjusted
[ ] Audit logging enabled
[ ] Regular audit log review scheduled
[ ] Voice consent acknowledged (if using voice)
[ ] MEMORY.md data flow acknowledged
```
