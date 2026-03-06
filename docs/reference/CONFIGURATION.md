# Configuration Reference

> **Status: Synchronized with the Zod schema in `packages/protocol/src/config.ts` as of v0.1.6.**

All configuration lives in `eidolon.json` (searched in: explicit path, `$EIDOLON_CONFIG`, `./eidolon.json`, `~/.config/eidolon/eidolon.json`). Secrets are never stored in this file -- they are referenced via `{ "$secret": "KEY_NAME" }` and resolved from the encrypted secret store (`secrets.db`).

## Minimal Configuration

The smallest viable `eidolon.json`:

```jsonc
{
  "identity": {
    "ownerName": "Manuel"
  },
  "brain": {
    "accounts": [
      { "type": "oauth", "name": "primary", "credential": "oauth" }
    ]
  },
  "gateway": {
    "auth": { "type": "none" }
  }
}
```

`identity.ownerName` and `brain.accounts` (min 1) are required. `gateway.auth` requires a token when type is `"token"`, so set `"none"` or provide a token. Everything else has sensible defaults.

## Full Schema

The following reflects the actual Zod schema in `packages/protocol/src/config.ts`. Field names, types, and defaults are exact.

```jsonc
{
  // --- Identity --------------------------------------------------------
  "identity": {
    "name": "Eidolon",                    // string, default "Eidolon"
    "ownerName": "Manuel"                 // string, REQUIRED
  },

  // --- Brain (Claude Code Integration) ---------------------------------
  "brain": {
    "accounts": [                         // array, min 1, REQUIRED
      {
        "type": "oauth",                  // "oauth" | "api-key"
        "name": "primary",               // string
        "credential": "oauth",            // string | { "$secret": "KEY" }
        "priority": 50,                   // int 1-100, default 50
        "maxTokensPerHour": 200000,       // positive int, optional
        "enabled": true                   // boolean, default true
      }
    ],
    "model": {
      "default": "claude-sonnet-4-20250514",  // string
      "complex": "claude-opus-4-20250514",    // string
      "fast": "claude-haiku-3-20250414"       // string
    },
    "session": {
      "maxTurns": 50,                     // positive int, default 50
      "compactAfter": 40,                 // positive int, default 40
      "timeoutMs": 300000                 // positive int, default 300000 (5 min)
    },
    "mcpServers": {                       // optional record<string, object>
      "home-assistant": {
        "command": "npx",
        "args": ["-y", "mcp-server-home-assistant"],
        "env": { "HA_TOKEN": "..." }      // optional record<string, string>
      }
    },
    "mcpTemplates": []                    // string array, default [] -- IDs of MCP templates to enable
  },

  // --- Cognitive Loop ---------------------------------------------------
  "loop": {
    "energyBudget": {
      "maxTokensPerHour": 100000,         // positive int, default 100000
      "categories": {
        "user": 0.5,                      // 0.0-1.0, default 0.5
        "tasks": 0.2,                     // 0.0-1.0, default 0.2
        "learning": 0.2,                  // 0.0-1.0, default 0.2
        "dreaming": 0.1                   // 0.0-1.0, default 0.1
      }
    },
    "rest": {
      "activeMinMs": 2000,               // positive int, default 2000
      "idleMinMs": 30000,                // positive int, default 30000
      "maxMs": 300000,                   // positive int, default 300000
      "nightModeStartHour": 23,          // int 0-23, default 23
      "nightModeEndHour": 7,             // int 0-23, default 7
      "nightModeMultiplier": 3           // 1-10, default 3
    },
    "businessHours": {
      "start": "07:00",                  // HH:MM format, default "07:00"
      "end": "23:00",                    // HH:MM format, default "23:00"
      "timezone": "Europe/Berlin"        // IANA timezone, default "Europe/Berlin"
    }
  },

  // --- Memory Engine ----------------------------------------------------
  "memory": {
    "extraction": {
      "strategy": "hybrid",              // "llm" | "rule-based" | "hybrid", default "hybrid"
      "minConfidence": 0.7               // 0.0-1.0, default 0.7
    },
    "consolidation": {                   // default {}
      "enabled": true,                   // boolean, default true
      "duplicateThreshold": 0.95,        // 0.0-1.0, default 0.95
      "updateThreshold": 0.85,           // 0.0-1.0, default 0.85
      "maxCandidates": 10,               // positive int, default 10
      "compressionStrategy": "none",     // "none" | "progressive" | "hierarchical", default "none"
      "compressionThreshold": 10         // positive int, default 10
    },
    "dreaming": {
      "enabled": true,                   // boolean, default true
      "schedule": "02:00",              // string, default "02:00"
      "maxDurationMinutes": 30          // positive int, default 30
    },
    "search": {
      "maxResults": 20,                  // positive int, default 20
      "rrfK": 60,                        // positive int, default 60 (RRF constant)
      "bm25Weight": 0.4,                // 0.0-1.0, default 0.4
      "vectorWeight": 0.4,              // 0.0-1.0, default 0.4
      "graphWeight": 0.2                 // 0.0-1.0, default 0.2
    },
    "embedding": {
      "model": "Xenova/multilingual-e5-small",  // string
      "dimensions": 384,                // positive int, default 384
      "batchSize": 32                   // positive int, default 32
    },
    "retention": {
      "shortTermDays": 90,              // positive int, default 90
      "decayRate": 0.01                 // 0.0-1.0, default 0.01
    },
    "entityResolution": {
      "personThreshold": 0.95,          // 0.0-1.0, default 0.95
      "technologyThreshold": 0.90,      // 0.0-1.0, default 0.90
      "conceptThreshold": 0.85          // 0.0-1.0, default 0.85
    },
    "obsidian": {                        // optional
      "enabled": false,                  // boolean, default false
      "vaultPath": "/path/to/vault",    // string, required when present
      "exclude": [".obsidian", ".trash"],// string array, default [".obsidian", ".trash"]
      "maxFileSize": 1048576             // positive int, default 1048576 (1 MB)
    },
    "indexing": {                        // default {}
      "enabled": false,                  // boolean, default false
      "paths": [],                       // string array, default []
      "fileTypes": [".md", ".txt", ".pdf", ".ts", ".py", ".js"],  // string array
      "exclude": ["node_modules", ".git", "dist"],                 // string array
      "maxFileSize": 1048576,            // positive int, default 1048576 (1 MB)
      "recheckIntervalSeconds": 3600     // positive int, default 3600
    }
  },

  // --- Self-Learning ----------------------------------------------------
  "learning": {
    "enabled": false,                     // boolean, default false
    "sources": [                          // array, default []
      {
        "type": "reddit",                // "reddit" | "hackernews" | "github" | "rss" | "arxiv"
        "config": {                       // record<string, string|number|boolean>
          "subreddits": "selfhosted,homelab"
        },
        "schedule": "*/6 * * * *"        // cron expression (5 fields), default "*/6 * * * *"
      }
    ],
    "relevance": {
      "minScore": 0.6,                   // 0.0-1.0, default 0.6
      "userInterests": []                // string array, default []
    },
    "autoImplement": {
      "enabled": false,                  // boolean, default false
      "requireApproval": true,           // boolean, default true
      "allowedScopes": []               // string array, default []
    },
    "budget": {
      "maxTokensPerDay": 50000,          // positive int, default 50000
      "maxDiscoveriesPerDay": 20         // positive int, default 20
    }
  },

  // --- Channels ---------------------------------------------------------
  "channels": {
    "telegram": {                         // optional
      "enabled": false,                  // boolean, default false
      "botToken": { "$secret": "TELEGRAM_BOT_TOKEN" },  // string | SecretRef
      "allowedUserIds": [123456789],     // int array, REQUIRED when telegram is set
      "notifyOnDiscovery": true,         // boolean, default true
      "dndSchedule": {                   // optional
        "start": "22:00",               // string, default "22:00"
        "end": "07:00"                  // string, default "07:00"
      }
    },
    "discord": {                          // optional (v1.1+)
      "enabled": false,                  // boolean, default false
      "botToken": { "$secret": "DISCORD_BOT_TOKEN" },  // string | SecretRef
      "allowedUserIds": ["123456789"],   // string array (Discord IDs)
      "guildId": "optional-guild-id",    // string, optional -- restrict to specific guild
      "dmOnly": true                     // boolean, default true -- DMs only or allow guild channels
    },
    "whatsapp": {                         // optional (v1.2+)
      "enabled": false,                  // boolean, default false
      "phoneNumberId": "123456",         // string, REQUIRED
      "businessAccountId": "789",        // string, REQUIRED
      "accessToken": { "$secret": "WHATSAPP_ACCESS_TOKEN" },  // string | SecretRef
      "verifyToken": { "$secret": "WHATSAPP_VERIFY_TOKEN" },  // string | SecretRef
      "appSecret": { "$secret": "WHATSAPP_APP_SECRET" },      // string | SecretRef
      "allowedPhoneNumbers": ["+491234567890"],  // string array, E.164 format
      "notifyOnDiscovery": true,         // boolean, default true
      "dndSchedule": {                   // optional
        "start": "22:00",
        "end": "07:00"
      }
    },
    "email": {                            // optional (v1.2+)
      "enabled": false,                  // boolean, default false
      "imap": {
        "host": "imap.example.com",      // string, REQUIRED
        "port": 993,                     // positive int, default 993
        "tls": true,                     // boolean, default true
        "user": "user@example.com",      // string, REQUIRED
        "password": { "$secret": "IMAP_PASSWORD" },  // string | SecretRef
        "pollIntervalMs": 30000,         // positive int, default 30000
        "folder": "INBOX"               // string, default "INBOX"
      },
      "smtp": {
        "host": "smtp.example.com",      // string, REQUIRED
        "port": 587,                     // positive int, default 587
        "tls": true,                     // boolean, default true
        "user": "user@example.com",      // string, REQUIRED
        "password": { "$secret": "SMTP_PASSWORD" },  // string | SecretRef
        "from": "eidolon@example.com"    // string, REQUIRED
      },
      "allowedSenders": ["user@example.com"],  // string array
      "subjectPrefix": "[Eidolon]",      // string, default "[Eidolon]"
      "maxAttachmentSizeMb": 10,         // positive number, default 10
      "threadingEnabled": true           // boolean, default true
    }
  },

  // --- Gateway (WebSocket API) ------------------------------------------
  "gateway": {
    "host": "127.0.0.1",                 // string, default "127.0.0.1"
    "port": 8419,                         // positive int, default 8419
    "tls": {                              // default {} (disabled)
      "enabled": false,                  // boolean, default false
      "cert": "/path/to/cert.pem",      // string, optional (required when enabled=true)
      "key": "/path/to/key.pem"         // string, optional (required when enabled=true)
    },
    "maxMessageBytes": 1048576,           // positive int, default 1048576 (1 MB)
    "maxClients": 10,                     // positive int, default 10
    "allowedOrigins": [],                 // string array, default []
    "rateLimiting": {                     // default {}
      "maxFailures": 5,                  // positive int, default 5
      "windowMs": 60000,                // positive int, default 60000
      "blockMs": 300000,                // positive int, default 300000
      "maxBlockMs": 3600000             // positive int, default 3600000
    },
    "auth": {                             // REQUIRED
      "type": "token",                   // "token" | "none", default "token"
      "token": { "$secret": "GATEWAY_TOKEN" }  // string | SecretRef (required when type="token")
    },
    "webhooks": {                         // default {} (v1.1+)
      "endpoints": [                     // array of webhook endpoints, default []
        {
          "id": "my-webhook",            // string, 1-100 chars -- URL path: /webhooks/{id}
          "name": "My Webhook",          // string, 1-200 chars
          "token": { "$secret": "WEBHOOK_TOKEN" },  // string | SecretRef
          "eventType": "webhook:received",// string, default "webhook:received"
          "priority": "normal",          // "critical" | "high" | "normal" | "low", default "normal"
          "enabled": true                // boolean, default true
        }
      ]
    }
  },

  // --- GPU Workers ------------------------------------------------------
  "gpu": {
    "workers": [                          // array, default []
      {
        "name": "windows-5080",
        "host": "100.64.0.2",
        "port": 8420,                    // positive int, default 8420
        "token": { "$secret": "GPU_WORKER_TOKEN" },  // string | SecretRef
        "capabilities": ["tts", "stt"],  // ("tts"|"stt"|"realtime")[], default ["tts","stt"]
        "priority": 50,                  // int 1-100, default 50
        "maxConcurrent": 4               // positive int, optional
      }
    ],
    "pool": {                             // default {} (v1.1+)
      "loadBalancing": "least-connections",// "round-robin" | "least-connections" | "latency-weighted"
      "healthCheckIntervalMs": 30000,    // positive int, default 30000
      "maxRetriesPerRequest": 2          // int 0-5, default 2
    },
    "tts": {
      "model": "Qwen/Qwen3-TTS-1.7B",   // string
      "defaultSpeaker": "Chelsie",       // string, default "Chelsie"
      "sampleRate": 24000                // positive int, default 24000
    },
    "stt": {
      "model": "large-v3",               // string, default "large-v3"
      "language": "auto"                 // string, default "auto"
    },
    "fallback": {
      "cpuTts": true,                    // boolean, default true
      "systemTts": true                  // boolean, default true
    }
  },

  // --- Home Automation (v1.1+) ------------------------------------------
  "homeAutomation": {                     // default {}
    "enabled": false,                    // boolean, default false
    "haUrl": "http://homeassistant.local:8123",  // string, optional
    "haToken": { "$secret": "HA_TOKEN" },        // string | SecretRef, optional
    "syncIntervalMinutes": 5,            // positive int, default 5
    "domainPolicies": [                  // array with defaults for common domains
      { "domain": "light", "level": "safe" },
      { "domain": "switch", "level": "safe" },
      { "domain": "sensor", "level": "safe" },
      { "domain": "climate", "level": "needs_approval" },
      { "domain": "lock", "level": "needs_approval" },
      { "domain": "alarm_control_panel", "level": "dangerous" },
      { "domain": "cover", "level": "safe" },
      { "domain": "media_player", "level": "safe" }
    ],
    "anomalyDetection": {                // default {}
      "enabled": true,                   // boolean, default true
      "rules": []                        // array of { entityPattern, condition, message }
    },
    "scenes": []                          // array of { name, actions[] }
  },

  // --- Calendar (v1.1+) ------------------------------------------------
  "calendar": {                           // default {}
    "enabled": false,                    // boolean, default false
    "providers": [                       // array, default []
      {
        "type": "google",               // "google" | "caldav"
        "name": "My Calendar",          // string
        "config": {},                    // record<string, unknown>
        "syncIntervalMinutes": 15       // positive int, default 15
      }
    ],
    "reminders": {                       // default {}
      "defaultMinutesBefore": [15, 60], // int array, default [15, 60]
      "notifyVia": ["telegram"]         // string array, default ["telegram"]
    },
    "injection": {                       // default {}
      "enabled": true,                  // boolean, default true
      "daysAhead": 1                    // positive int, default 1
    }
  },

  // --- Security ---------------------------------------------------------
  "security": {
    "policies": {
      "shellExecution": "needs_approval",  // "safe"|"needs_approval"|"dangerous", default "needs_approval"
      "fileModification": "needs_approval",// "safe"|"needs_approval"|"dangerous", default "needs_approval"
      "networkAccess": "safe",             // "safe"|"needs_approval"|"dangerous", default "safe"
      "secretAccess": "dangerous"          // "safe"|"needs_approval"|"dangerous", default "dangerous"
    },
    "approval": {
      "timeout": 300000,                   // positive int (ms), default 300000
      "defaultAction": "deny",             // "deny" | "allow", default "deny"
      "escalation": [],                    // array of escalation rules, default []
      "checkIntervalMs": 10000             // positive int, default 10000
    },
    "sandbox": {
      "enabled": false,                    // boolean, default false
      "runtime": "none"                    // "none" | "docker" | "bubblewrap", default "none"
    },
    "audit": {
      "enabled": true,                     // boolean, default true
      "retentionDays": 365                 // positive int, default 365
    }
  },

  // --- Privacy & Retention ----------------------------------------------
  "privacy": {                             // default {}
    "retention": {                         // default {}
      "conversationsDays": 365,           // positive int, default 365
      "eventsDays": 90,                   // positive int, default 90
      "tokenUsageDays": 180,             // positive int, default 180
      "auditLogDays": -1                  // -1 (never delete) | positive int, default -1
    },
    "encryptBackups": true                // boolean, default true
  },

  // --- Digest (Daily Briefing, v1.1+) -----------------------------------
  "digest": {                              // default {}
    "enabled": false,                     // boolean, default false
    "time": "07:00",                      // HH:MM format, default "07:00"
    "timezone": "Europe/Berlin",          // IANA timezone, default "Europe/Berlin"
    "channel": "telegram",                // "telegram" | "desktop" | "all", default "telegram"
    "sections": {                          // default {}
      "conversations": true,              // boolean, default true
      "learning": true,
      "memory": true,
      "schedule": true,
      "metrics": true,
      "actionItems": true
    }
  },

  // --- Telemetry (OpenTelemetry, v1.2+) ---------------------------------
  "telemetry": {                           // default {}
    "enabled": false,                     // boolean, default false
    "endpoint": "http://localhost:4318",  // string, default "http://localhost:4318"
    "protocol": "http",                   // "grpc" | "http", default "http"
    "serviceName": "eidolon-core",        // string, default "eidolon-core"
    "sampleRate": 1.0,                    // 0.0-1.0, default 1.0
    "exportIntervalMs": 5000,             // positive int, default 5000
    "attributes": {}                      // record<string, string>, default {}
  },

  // --- Plugin System (v2.0+) --------------------------------------------
  "plugins": {                             // default {}
    "enabled": false,                     // boolean, default false
    "directory": "",                      // string, default "" (resolved at runtime)
    "autoUpdate": false,                  // boolean, default false
    "allowedPermissions": [               // string array
      "events:listen",
      "events:emit",
      "config:read",
      "gateway:register"
    ],
    "blockedPlugins": []                  // string array, default []
  },

  // --- Local LLM Providers (v2.0+) -------------------------------------
  "llm": {                                // default {}
    "providers": {                        // default {}
      "ollama": {                         // optional
        "enabled": false,                // boolean, default false
        "host": "http://localhost:11434",// string, default "http://localhost:11434"
        "defaultModel": "llama3.2",      // string, default "llama3.2"
        "models": {                       // record<string, { contextLength, supportsTools }>
          "llama3.2": {
            "contextLength": 8192,       // positive int, default 8192
            "supportsTools": false       // boolean, default false
          }
        }
      },
      "llamacpp": {                       // optional
        "enabled": false,                // boolean, default false
        "serverPath": "",                // string, path to llama-server binary
        "modelPath": "",                 // string, path to GGUF model file
        "gpuLayers": 0,                  // int >= 0, default 0
        "contextLength": 8192,           // positive int, default 8192
        "port": 8421                     // positive int, default 8421
      }
    },
    "routing": {                          // default {} -- maps task types to provider priority
      // Keys: "conversation" | "extraction" | "filtering" | "dreaming" |
      //        "code-generation" | "summarization" | "embedding"
      // Values: arrays of ["claude", "ollama", "llamacpp"] in priority order
    }
  },

  // --- Database ---------------------------------------------------------
  "database": {
    "directory": "",                       // string, default "" (resolved at runtime to platform default)
    "walMode": true,                       // boolean, default true
    "backupPath": "/mnt/backup/eidolon",   // string, optional
    "backupSchedule": "0 3 * * *"         // cron expression, default "0 3 * * *"
  },

  // --- Logging ----------------------------------------------------------
  "logging": {
    "level": "info",                       // "debug"|"info"|"warn"|"error", default "info"
    "format": "json",                      // "json"|"pretty", default "json"
    "directory": "",                       // string, default "" (resolved at runtime)
    "maxSizeMb": 50,                       // positive number, default 50
    "maxFiles": 10                         // positive int, default 10
  },

  // --- Daemon -----------------------------------------------------------
  "daemon": {
    "pidFile": "",                         // string, default "" (resolved at runtime)
    "gracefulShutdownMs": 10000           // positive int, default 10000
  }
}
```

## Environment Variables

Environment variables override config file values. The naming convention is `EIDOLON_` prefix with double underscores for nesting.

| Variable | Config Path | Description |
|---|---|---|
| `EIDOLON_LOGGING__LEVEL` | `logging.level` | Override log level |
| `EIDOLON_GATEWAY__PORT` | `gateway.port` | Override WebSocket port |
| `EIDOLON_LOOP__ENERGY_BUDGET__MAX_TOKENS_PER_HOUR` | `loop.energyBudget.maxTokensPerHour` | Override token budget |
| `EIDOLON_DATA_DIR` | (special) | Override base data directory |
| `EIDOLON_MASTER_KEY` | (special) | Master encryption key for secret store |
| `EIDOLON_CONFIG` | (special) | Path to config file |

## Secret References

Anywhere in the config where a secret value is needed, use the `$secret` reference:

```jsonc
{
  "botToken": { "$secret": "TELEGRAM_BOT_TOKEN" }
}
```

This resolves at runtime from the encrypted secret store (`secrets.db`). The secret must have been previously set via:

```bash
eidolon secrets set TELEGRAM_BOT_TOKEN
```

Fields that accept secret references (`stringOrSecret()` in the Zod schema):
- `brain.accounts[].credential`
- `channels.telegram.botToken`
- `channels.discord.botToken`
- `channels.whatsapp.accessToken`, `.verifyToken`, `.appSecret`
- `channels.email.imap.password`, `.smtp.password`
- `gateway.auth.token`
- `gateway.webhooks.endpoints[].token`
- `gpu.workers[].token`
- `homeAutomation.haToken`

## Configuration Validation

When the daemon starts, the configuration is validated against the Zod schema. Invalid configurations fail fast with descriptive error messages:

```
$ eidolon daemon start
Error: Configuration validation failed:
  - identity.ownerName: Required
  - brain.accounts: Array must contain at least 1 element(s)
  - gateway.auth: Token value is required when auth type is 'token'
```

Notable validation rules:
- `gateway.tls`: When `enabled` is `true`, both `cert` and `key` are required.
- `gateway.auth`: When `type` is `"token"`, a `token` value is required.
- `loop.businessHours.start/end`: Must match `HH:MM` format with valid hours (00-23) and minutes (00-59).
- `learning.sources[].schedule`: Must be a valid 5-field cron expression.

## Hot-Reload

The following configuration sections support hot-reload (no daemon restart required):

| Section | Hot-Reload | Notes |
|---|---|---|
| `identity` | Yes | |
| `brain.accounts` | Yes | New accounts added to rotation immediately |
| `brain.model` | Yes | |
| `loop.energyBudget` | Yes | |
| `loop.rest` | Yes | |
| `memory.extraction` | Yes | |
| `memory.dreaming.schedule` | Yes | |
| `learning.sources` | Yes | Sources added/removed on next cycle |
| `learning.relevance` | Yes | |
| `channels.telegram` | No | Requires restart |
| `channels.discord` | No | Requires restart |
| `channels.whatsapp` | No | Requires restart |
| `channels.email` | No | Requires restart |
| `gateway` | No | Requires restart |
| `gpu.workers` | Yes | Workers re-discovered |
| `homeAutomation` | Yes | Domain policies and scenes updated |
| `calendar` | Yes | Providers re-synced |
| `security.policies` | Yes | |
| `logging.level` | Yes | |
| `telemetry` | No | Requires restart |
| `plugins` | No | Requires restart |
| `llm.providers` | No | Requires restart |
| `llm.routing` | Yes | Routing table updated |

Hot-reload is triggered by:
1. File system watcher on `eidolon.json`
2. CLI command: `eidolon config reload`

## CLI Configuration Commands

```bash
# Show current configuration (secrets masked)
eidolon config show

# Show a specific section
eidolon config show brain

# Validate configuration without starting
eidolon config validate
```

## Default Data Directory

| Platform | Default Path |
|---|---|
| Linux | `~/.local/share/eidolon/` |
| macOS | `~/Library/Application Support/eidolon/` |

Override with `EIDOLON_DATA_DIR` environment variable.
