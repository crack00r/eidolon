# Security Model

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
    kdf: 'argon2id';          // Key derivation function
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
| Fallback | Argon2id-derived from master password |

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

## Security Checklist for Users

```
[ ] Master password set for secret store
[ ] All API keys stored via 'eidolon secrets set'
[ ] No plaintext secrets in eidolon.json
[ ] Telegram bot token in secret store
[ ] Gateway token set for WebSocket auth
[ ] Tailscale ACLs configured for device access
[ ] Action policies reviewed and adjusted
[ ] Audit logging enabled
[ ] Regular audit log review scheduled
```
