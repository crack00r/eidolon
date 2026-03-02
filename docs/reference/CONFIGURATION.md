# Configuration Reference

All configuration lives in `~/.eidolon/eidolon.json`. Secrets are never stored in this file -- they are referenced via `{ "$secret": "KEY_NAME" }` and resolved from the encrypted secret store (`secrets.enc`).

## Minimal Configuration

The smallest viable `eidolon.json`:

```jsonc
{
  "brain": {
    "accounts": [
      { "type": "oauth", "name": "main" }
    ]
  }
}
```

Everything else has sensible defaults.

## Full Schema

```jsonc
{
  // ─── Identity ───────────────────────────────────────────
  "identity": {
    "name": "Eidolon",                    // Display name
    "timezone": "Europe/Berlin",          // IANA timezone
    "locale": "de-DE",                    // Locale for date/number formatting
    "owner": {
      "name": "Manuel",                   // User's name
      "pronouns": "he/him"               // Optional
    }
  },

  // ─── Brain (Claude Code Integration) ────────────────────
  "brain": {
    "accounts": [
      {
        "type": "oauth",                  // 'oauth' | 'api-key'
        "name": "max-primary",            // Human-readable name
        "priority": 1,                    // Lower = preferred
        "model": "claude-sonnet-4-20250514"    // Default model for this account
      },
      {
        "type": "oauth",
        "name": "max-secondary",
        "priority": 2,
        "model": "claude-sonnet-4-20250514"
      },
      {
        "type": "api-key",
        "name": "api-fallback",
        "priority": 10,
        "keyRef": { "$secret": "ANTHROPIC_KEY_1" },
        "model": "claude-sonnet-4-20250514"
      }
    ],
    "defaultModel": "claude-sonnet-4-20250514",    // Model when not specified per-account
    "maxTurns": 25,                       // Max tool-use turns per session
    "sessionTimeout": 3600,               // Session timeout in seconds (1h)
    "warmPool": {
      "enabled": true,                    // Keep a warm process for main session
      "maxProcesses": 2                   // Max warm processes
    }
  },

  // ─── Cognitive Loop ─────────────────────────────────────
  "loop": {
    "energyBudget": {
      "tokensPerHour": 50000,             // Max tokens consumed per hour
      "responseAllocation": 0.6,          // 60% for user responses
      "learningAllocation": 0.3,          // 30% for learning
      "dreamingAllocation": 0.1           // 10% for dreaming
    },
    "rest": {
      "activeTyping": 2000,               // ms: user just typed
      "recentActivity": 5000,             // ms: user active within 1 min
      "businessHours": 30000,             // ms: during configured business hours
      "hasPendingLearning": 60000,        // ms: learning queue not empty
      "idle": 300000                      // ms: deep idle (5 min)
    },
    "businessHours": {
      "start": "08:00",                   // 24h format in configured timezone
      "end": "22:00",
      "days": [1, 2, 3, 4, 5, 6, 7]      // 1=Monday, 7=Sunday
    }
  },

  // ─── Memory Engine ──────────────────────────────────────
  "memory": {
    "extraction": {
      "enabled": true,                    // Auto-extract after every interaction
      "model": "claude-haiku",            // Lightweight model for extraction
      "minConfidence": 0.7                // Minimum confidence to store a memory
    },
    "dreaming": {
      "enabled": true,
      "schedule": "02:00",                // When to start dreaming (local time)
      "maxDuration": 3600,                // Max dreaming duration in seconds
      "phases": {
        "housekeeping": true,             // Phase 1: cleanup, dedup, decay
        "rem": true,                      // Phase 2: associative discovery
        "nrem": true                      // Phase 3: schema abstraction
      }
    },
    "search": {
      "hybridWeight": 0.7,                // 0=pure BM25, 1=pure vector
      "maxResults": 20,                   // Max memories per search
      "embedding": {
        "provider": "local",              // 'local' | 'voyage' | 'openai'
        "model": "all-MiniLM-L6-v2",     // Local: ONNX model via @huggingface/transformers
        "dimensions": 384                 // Embedding vector dimensions
        // For 'voyage': model = "voyage-3-lite", requires VOYAGE_API_KEY secret
        // For 'openai': model = "text-embedding-3-small", requires OPENAI_API_KEY secret
      }
    },
    "retention": {
      "shortTermDays": 90,                // Short-term memory TTL in days (90d)
      "episodicDays": 365,                // Episodic memory TTL in days (1 year)
      "decayEnabled": true,               // Enable confidence decay over time
      "decayRate": 0.01                   // Confidence decay per day
    }
  },

  // ─── Self-Learning ──────────────────────────────────────
  "learning": {
    "enabled": true,
    "sources": [
      {
        "type": "reddit",
        "subreddits": ["programming", "typescript", "linux", "selfhosted"],
        "minScore": 50,                   // Minimum upvotes
        "interval": 3600                  // Check interval in seconds
      },
      {
        "type": "hackernews",
        "minScore": 100,
        "interval": 1800
      },
      {
        "type": "github",
        "topics": ["ai", "typescript", "personal-assistant"],
        "interval": 7200
      },
      {
        "type": "rss",
        "feeds": [
          "https://example.com/feed.xml"
        ],
        "interval": 3600
      }
    ],
    "relevanceThreshold": 60,             // Min relevance score (0-100) to keep
    "autoImplement": false,               // Auto-implement safe discoveries
    "maxDiscoveriesPerDay": 50,           // Prevent runaway scraping
    "implementationBranch": "eidolon/learning"  // Git branch for auto-implementations
  },

  // ─── Channels ───────────────────────────────────────────
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": { "$secret": "TELEGRAM_BOT_TOKEN" },
      "allowedUsers": [123456789],        // Telegram user IDs
      "mode": "polling",                  // 'polling' | 'webhook'
      "webhook": {
        "url": "https://example.com/telegram/webhook",
        "port": 8443,
        "certPath": "/path/to/cert.pem"
      },
      "features": {
        "voice": true,                    // Process voice messages (STT)
        "images": true,                   // Process image attachments
        "documents": true,                // Process document attachments
        "reactions": true                 // React to messages
      }
    }
    // Future channels will follow the same pattern
  },

  // ─── Gateway (WebSocket API) ────────────────────────────
  "gateway": {
    "enabled": true,
    "host": "0.0.0.0",                    // Bind address
    "port": 8419,                         // WebSocket port
    "authToken": { "$secret": "GATEWAY_TOKEN" },
    "tls": {
      "enabled": false,                   // TLS handled by Tailscale
      "certPath": "",
      "keyPath": ""
    },
    "maxConnections": 10,                 // Max simultaneous clients
    "heartbeatInterval": 30000            // Client keepalive (ms)
  },

  // ─── GPU Workers ────────────────────────────────────────
  "gpu": {
    "workers": [
      {
        "name": "windows-pc",
        "host": "windows-pc.tailnet.ts.net",  // Tailscale hostname
        "port": 8420,
        "capabilities": ["tts", "stt"],
        "healthCheckInterval": 30000      // ms between health checks
      }
    ],
    "tts": {
      "model": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
      "defaultVoice": "Vivian",           // Qwen3-TTS voice preset (see GPU_AND_VOICE.md)
      "defaultLanguage": "de",            // ISO 639-1 language code
      "sampleRate": 24000,
      "streaming": true
    },
    "stt": {
      "model": "openai/whisper-large-v3",
      "language": "de"
    },
    "fallback": {
      "ttsDisabled": "text-only",         // 'text-only' | 'cloud-tts'
      "sttDisabled": "text-only"          // 'text-only' | 'cloud-stt'
    }
  },

  // ─── Security ───────────────────────────────────────────
  "security": {
    "policies": {
      "file_read": "safe",
      "file_write_workspace": "safe",
      "file_write_outside": "needs_approval",
      "file_delete": "needs_approval",
      "shell_read_only": "safe",
      "shell_write": "needs_approval",
      "shell_system": "dangerous",
      "shell_network": "needs_approval",
      "api_call_read": "safe",
      "api_call_write": "needs_approval",
      "send_message": "needs_approval",
      "send_email": "dangerous",
      "modify_own_code": "needs_approval",
      "modify_config": "needs_approval",
      "modify_secrets": "dangerous",
      "store_memory": "safe",
      "implement_discovery": "needs_approval",
      "tts_generate": "safe",
      "stt_transcribe": "safe"
    },
    "approvalTimeout": {
      "interactive": 300,                 // seconds (5 min)
      "learning": 86400                   // seconds (24h)
    },
    "sandbox": {
      "enabled": false,
      "runtime": "docker",               // 'docker' | 'podman'
      "image": "eidolon-sandbox",
      "network": "none",
      "mounts": []
    },
    "audit": {
      "enabled": true,
      "retentionDays": 90,                // Keep audit logs for 90 days
      "logFile": "~/.eidolon/logs/audit.log"
    }
  },

  // ─── Database ───────────────────────────────────────────
  "database": {
    "path": "~/.eidolon/eidolon.db",      // SQLite database path
    "walMode": true,                      // Write-ahead logging
    "backupInterval": 86400,              // Auto-backup interval in seconds (24h)
    "backupRetention": 7                  // Keep N backups
  },

  // ─── Logging ────────────────────────────────────────────
  "logging": {
    "level": "info",                      // 'debug' | 'info' | 'warn' | 'error'
    "file": "~/.eidolon/logs/daemon.log",
    "maxSize": "50MB",                    // Rotate at this size
    "maxFiles": 5,                        // Keep N rotated files
    "console": true                       // Also log to stdout
  },

  // ─── Daemon ─────────────────────────────────────────────
  "daemon": {
    "pidFile": "~/.eidolon/eidolon.pid",
    "autoStart": false,                   // Start on system boot
    "gracefulShutdownTimeout": 30000      // ms to wait for cleanup on shutdown
  }
}
```

## Environment Variables

Environment variables override config file values. The naming convention is `EIDOLON_` prefix with double underscores for nesting.

| Variable | Config Path | Description |
|---|---|---|
| `EIDOLON_BRAIN__DEFAULT_MODEL` | `brain.defaultModel` | Override default model |
| `EIDOLON_LOOP__ENERGY_BUDGET__TOKENS_PER_HOUR` | `loop.energyBudget.tokensPerHour` | Override token budget |
| `EIDOLON_GATEWAY__PORT` | `gateway.port` | Override WebSocket port |
| `EIDOLON_LOGGING__LEVEL` | `logging.level` | Override log level |
| `EIDOLON_DATA_DIR` | (special) | Override `~/.eidolon/` base directory |

## Secret References

Anywhere in the config where a secret value is needed, use the `$secret` reference:

```jsonc
{
  "botToken": { "$secret": "TELEGRAM_BOT_TOKEN" }
}
```

This resolves at runtime from the encrypted `secrets.enc` file. The secret must have been previously set via:

```bash
eidolon secrets set TELEGRAM_BOT_TOKEN
```

## Configuration Validation

When the daemon starts, the configuration is validated against a Zod schema. Invalid configurations fail fast with descriptive error messages:

```
$ eidolon start
Error: Configuration validation failed:
  - brain.accounts: At least one account is required
  - channels.telegram.allowedUsers: Must contain at least one user ID
  - gateway.port: Must be between 1024 and 65535
```

## Hot-Reload

The following configuration sections support hot-reload (no daemon restart required):

| Section | Hot-Reload | Notes |
|---|---|---|
| `identity` | Yes | |
| `brain.accounts` | Yes | New accounts added to rotation immediately |
| `brain.defaultModel` | Yes | |
| `loop.energyBudget` | Yes | |
| `loop.rest` | Yes | |
| `memory.extraction` | Yes | |
| `memory.dreaming.schedule` | Yes | |
| `learning.sources` | Yes | Sources added/removed on next cycle |
| `learning.relevanceThreshold` | Yes | |
| `channels.telegram` | No | Requires restart |
| `gateway` | No | Requires restart |
| `gpu.workers` | Yes | Workers re-discovered |
| `security.policies` | Yes | |
| `logging.level` | Yes | |

Hot-reload is triggered by:
1. File system watcher on `eidolon.json`
2. CLI command: `eidolon config reload`
3. API call: `POST /config/reload`

## CLI Configuration Commands

```bash
# Show current configuration (secrets masked)
eidolon config show

# Show a specific section
eidolon config show brain

# Validate configuration without starting
eidolon config validate

# Reload configuration (hot-reload)
eidolon config reload

# Edit configuration in $EDITOR
eidolon config edit

# Reset to defaults
eidolon config reset --section loop

# Show effective config (with env overrides applied)
eidolon config effective
```

## Default Data Directory

| Platform | Default Path |
|---|---|
| Linux | `~/.eidolon/` |
| macOS | `~/.eidolon/` |
| Windows | `%APPDATA%\eidolon\` |

Override with `EIDOLON_DATA_DIR` environment variable or `--data-dir` CLI flag.
