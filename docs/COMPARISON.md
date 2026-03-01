# Eidolon vs OpenClaw: Detailed Comparison

This document compares Eidolon's architecture with OpenClaw's, based on direct analysis of the OpenClaw codebase (v0.42.x). The goal is not to disparage OpenClaw -- it pioneered the concept of an AI-powered personal assistant. But after analyzing its architecture, codebase, and community feedback, we identified fundamental problems that can't be fixed incrementally. Eidolon is a ground-up rethinking.

## Executive Summary

| Dimension | OpenClaw | Eidolon |
|---|---|---|
| Codebase size | ~430k lines | Target ~8k lines |
| Agent runtime | Custom (`@mariozechner/pi-coding-agent`) | Claude Code CLI (managed subprocess) |
| Proactivity | Heartbeat timer (30 min) + Cron | Continuous cognitive loop |
| Memory | Model prompted to write MEMORY.md | Automatic extraction + dreaming |
| Self-learning | None | Autonomous discovery + implementation |
| Secrets | Plaintext in config file | AES-256-GCM encrypted |
| TTS | ElevenLabs cloud ($$$) | Qwen3-TTS local (free) |
| Security advisories | 223 open | Zero (small dependency surface) |
| Target | Multi-user framework | Single-user personal daemon |

---

## Architecture

### Agent Runtime

**OpenClaw:** Built an entire custom agent runtime from scratch. The Pi coding agent handles tool registration, shell execution, file operations, web browsing, streaming, error recovery, context management, and model-specific prompt formatting. This is approximately 80% of the codebase.

**Eidolon:** Uses Claude Code CLI as the execution engine. Shell, filesystem, web search, and code generation come for free. Eidolon only implements the unique features: cognitive loop, memory, self-learning, multi-device orchestration.

**Why this matters:** Every bug in the agent runtime is a bug OpenClaw must fix. Every model API change requires OpenClaw updates. Eidolon delegates this to Anthropic's maintained tooling.

### Proactive Behavior

**OpenClaw:**
```
HEARTBEAT.md checked every 30 minutes
  -> LLM reads it, decides if anything needs attention
  -> Responds HEARTBEAT_OK if nothing to do
  -> ~$0.02 per heartbeat = ~$30/month for doing nothing

Cron: standard cron expressions
  -> Fires scheduled tasks at fixed times
  -> No priority, no energy awareness
```

**Eidolon:**
```
Continuous Cognitive Loop:
  PERCEIVE -> EVALUATE -> ACT -> REFLECT

  - Event-driven, not timer-driven
  - Priority scoring: user messages > tasks > learning > dreaming
  - Energy budget prevents runaway costs
  - Adaptive rest: 2s when user is active, 5min when idle
  - Idle time used productively (learning, dreaming)
```

**Why this matters:** OpenClaw wastes tokens checking an empty heartbeat file 48 times per day. It can't respond to events between heartbeats (up to 30 minutes of latency). It has no concept of prioritization or energy management.

### Memory

**OpenClaw:**
- Memory relies on the model voluntarily writing to `MEMORY.md`
- System prompt says: "Always save important information about the user and their preferences to MEMORY.md"
- The model often doesn't comply (this is a known issue)
- When context fills up, a panic "pre-compaction flush" tries to save unsaved knowledge
- No semantic search -- just the full MEMORY.md file injected into context
- No consolidation, no contradiction resolution, no decay

**Eidolon:**
- **Automatic extraction** after every conversation turn -- not optional, not model-dependent
- **5-layer memory**: working (session), short-term (90 days), long-term (permanent), episodic (interaction summaries), procedural (skills)
- **Hybrid search**: BM25 full-text + vector similarity, weighted combination
- **Dreaming consolidation** in 3 biologically-inspired phases:
  - Housekeeping: dedup, resolve contradictions, apply confidence decay
  - REM: discover associations between unrelated memories
  - NREM: abstract general rules from specific episodes
- **Selective injection**: only relevant memories are injected, not the entire database

**Why this matters:** OpenClaw's memory is fundamentally unreliable because it depends on model cooperation. Eidolon treats memory as infrastructure, not a suggestion.

---

## Code Quality

### Codebase Size

| Metric | OpenClaw | Eidolon (Target) |
|---|---|---|
| Total lines | ~430,000 | ~8,000 |
| Dependencies | 200+ | ~30 |
| Security advisories | 223 | 0 (goal) |
| Build time | Minutes | Seconds (Bun) |

OpenClaw's size isn't just about reading comprehension. Every line is attack surface, every dependency is a supply chain risk, and every module is a maintenance burden.

### Security

**OpenClaw:**
- API keys stored in plaintext in `~/.openclaw/openclaw.json`
- 223 open security advisories (npm audit)
- Google OAuth flow caused permanent account bans (issue #14203)
- No action classification -- the LLM can execute any shell command
- No audit trail

**Eidolon:**
- AES-256-GCM encrypted secrets at rest (Argon2id key derivation)
- Config references secrets by key (`{ "$secret": "KEY" }`), never by value
- Only Anthropic OAuth (documented, sanctioned, safe)
- Every action classified: `safe`, `needs_approval`, `dangerous`
- Full audit trail in SQLite with retention policy
- Optional container sandboxing for untrusted execution

### Project Health

**OpenClaw (as of analysis):**
- "Stabilization mode" -- closing feature requests, merging only bug fixes
- Pull request rate: ~1 every 2 minutes (overwhelmed maintainers)
- Core contributor burnout evident in issue responses
- Dismissive response to security concerns (Google account bans)
- Fundamental architecture limits what can be improved

**Eidolon:**
- Fresh start with lessons learned from OpenClaw and 15+ competitors
- Single-author project with clear vision
- Architecture designed for the features we want, not retrofitted

---

## Feature Comparison

### Voice / TTS

| Aspect | OpenClaw | Eidolon |
|---|---|---|
| Provider | ElevenLabs (cloud) | Qwen3-TTS (local) |
| Cost | ~$0.30 per 1000 chars | Free (your GPU) |
| Latency | ~200ms (network) | ~97ms (local, streaming) |
| Privacy | Audio sent to cloud | Audio stays local |
| Languages | ElevenLabs supported | 10+ (zh, en, ja, ko, de, fr, ...) |
| Hardware | None (cloud) | RTX 5080 (16GB VRAM, ~3.4GB used) |
| Fallback | None (service down = no voice) | Text-only mode |

### Clients

| Client | OpenClaw | Eidolon |
|---|---|---|
| Telegram | Yes | Yes (v1.0) |
| Desktop | macOS menu bar (Electron-based) | Tauri 2.0 (~5MB, all platforms) |
| iOS | Limited | Native Swift app (v1.0) |
| Web | Built-in | Post v1.0 |
| CLI | Yes | Yes |

### Self-Learning

| Aspect | OpenClaw | Eidolon |
|---|---|---|
| Discovery | None | Reddit, HN, GitHub, RSS |
| Relevance filtering | N/A | LLM-scored against user interests |
| Implementation | Manual skill installation | Auto-implementation in feature branch |
| Safety | N/A | 3-tier classification + approval flow |
| Journal | N/A | Markdown learning journal |

### Multi-Device

| Aspect | OpenClaw | Eidolon |
|---|---|---|
| Networking | SSH tunnels / direct | Tailscale mesh VPN |
| Protocol | Various | WebSocket + JSON-RPC 2.0 |
| GPU offloading | None | Dedicated GPU worker protocol |
| Deep access | macOS only | Any device running Tauri client |

---

## What OpenClaw Does Well

Credit where it's due:

1. **Pioneered the concept.** OpenClaw proved that a personal AI assistant running locally is viable and valuable. Every project in this space, including Eidolon, builds on this foundation.

2. **Community.** 242k+ stars, active Discord, extensive documentation. The community discovered what works and what doesn't.

3. **Skills system.** The idea of reusable, installable procedures ("skills") is sound. Eidolon adopts this concept.

4. **Session management.** OpenClaw's compaction strategy (summarize when context is full) is battle-tested. Eidolon's workspace preparer learns from this.

5. **Multi-provider support.** Supporting multiple LLM providers gives users flexibility. Eidolon intentionally limits this to Claude (via Claude Code) but acknowledges the tradeoff.

## What Eidolon Learns From OpenClaw's Mistakes

1. **Don't build an agent runtime.** Use one that's already maintained.
2. **Don't trust the model to write memories.** Extract them automatically.
3. **Don't use timers for proactivity.** Use event-driven loops with priority.
4. **Don't store secrets in plaintext.** Encrypt everything.
5. **Don't use experimental OAuth.** Users permanently lost accounts.
6. **Don't grow to 430k lines.** Stay focused, stay small.
7. **Don't support 15 channels from day one.** Start with one, get it right.
8. **Don't ignore security advisories.** 223 is a systemic problem, not a backlog.
