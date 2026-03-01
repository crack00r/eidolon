# Vision

## The Problem

Personal AI assistants today follow the same broken pattern: they wait for you to talk, they respond, and then they go to sleep. Even the most advanced ones (OpenClaw, nanobot, nanoclaw) simulate proactivity through timers -- a heartbeat every 30 minutes that reads a checklist, cron jobs that fire at scheduled times. This isn't intelligence. It's a glorified alarm clock.

Memory is treated as an afterthought. The model is asked to "please write important things to MEMORY.md." Sometimes it does. Usually it doesn't. When the context window fills up, a panic mechanism ("pre-compaction flush") tries to save what it can. Knowledge that isn't written down is lost forever.

Self-learning doesn't exist. The agent knows what it knew when it was last configured. It can't discover new tools, learn new techniques, or improve itself. It depends entirely on its human operator to manually install skills and update configurations.

## The Vision

Eidolon is a different kind of assistant. It isn't a chatbot with extra features. It's an autonomous system that:

1. **Thinks continuously** -- not on a timer, but with its own rhythm. Active when needed, restful when not. Using idle time to learn rather than sleeping.

2. **Remembers reliably** -- not through optional model cooperation, but through automatic extraction. Every conversation is analyzed. Facts, decisions, and patterns are stored. During quiet hours, memory is consolidated through a biologically-inspired "dreaming" process that resolves contradictions, finds hidden associations, and abstracts general rules from specific experiences.

3. **Learns autonomously** -- it discovers interesting content from the web, evaluates relevance, stores knowledge, and can implement improvements to its own codebase. With safety gates that prevent unintended damage.

4. **Lives in your infrastructure** -- runs on your server, uses your GPU for voice, connects to your devices over your network. No cloud dependency beyond the LLM API itself.

## Design Principles

### 1. Autonomy over Reactivity

The system should have its own initiative. It should decide when to act, what to learn, and how to prioritize -- not just respond to external triggers.

### 2. Memory as Infrastructure, Not Optional Feature

Memory extraction and consolidation are system-level concerns, not prompts asking the model to cooperate. If a fact was discussed, it is stored. Period.

### 3. Small Codebase, Large Capability

We target ~8,000 lines of own code. This is possible because we use Claude Code CLI as our execution engine instead of building a custom agent runtime. Every line we write serves our unique value proposition: cognitive loop, dreaming memory, self-learning, and multi-device orchestration.

### 4. Security by Default

Encrypted secrets at rest. Policy-based action classification. Audit trail for every action. Self-modification requires explicit approval. No plaintext API keys in config files.

### 5. Local Voice, Not Cloud Voice

Text-to-speech runs on your own GPU (Qwen3-TTS on an RTX 5080 uses ~3.4GB VRAM). No per-character billing from cloud TTS providers. Latency is lower. Privacy is better.

### 6. Cross-Platform from Day One

Desktop apps for macOS, Windows, and Linux from the first release. Not macOS-first with Linux/Windows as an afterthought. Tauri 2.0 makes this possible with ~5MB binaries.

### 7. Focused Feature Set

Start with one messaging channel (Telegram). Get it right. Then expand. The kitchen-sink approach of supporting 15+ channels from the start leads to none of them working properly.

## What Eidolon Is Not

- **Not a chatbot framework.** It's a personal assistant for a single user/household.
- **Not a LangChain wrapper.** There are no framework dependencies. Claude Code CLI is the execution engine.
- **Not a cloud service.** It runs entirely on your own hardware (except the LLM API).
- **Not a clone of OpenClaw.** It's inspired by OpenClaw's concept but rebuilt from scratch with a fundamentally different architecture.

## Target User

A technical user who:
- Runs a home server or has always-on hardware
- Has a Tailscale network connecting their devices
- Wants a personal AI assistant that remembers, learns, and grows
- Values privacy and local-first operation
- Has a GPU available for voice synthesis
- Is willing to configure and maintain the system

## Name

**Eidolon** (ancient Greek: *eidolon*) means "ideal form," "phantom," or "spirit." In Greek philosophy, an eidolon is the essence or ideal representation of something -- a form that captures the truth of what it represents. In later usage, it became associated with a spirit or phantom that operates in the background.

Both meanings apply: Eidolon is the ideal form of a personal AI assistant, and it operates as an ever-present spirit in your digital life -- always thinking, always learning, always available.
