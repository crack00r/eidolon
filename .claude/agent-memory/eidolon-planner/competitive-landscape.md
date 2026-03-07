# Competitive Landscape Research -- March 2026

## OpenClaw (Vorgaenger von Eidolon)

### Facts (from local repo at /Users/manuelguttmann/Projekte/OpenClaw/openclaw/)
- GitHub: `openclaw/openclaw` (public, MIT license)
- Version: 2026.2.1 (calendar versioning)
- Runtime: Node.js 22+ (not Bun)
- Package manager: pnpm
- Language: TypeScript (ESM, ES2023)
- Agent: Pi agent (RPC mode) via @mariozechner/pi-agent-core
- Linter: oxlint + oxfmt (not Biome)
- Tests: vitest, ~897 test files, ~5,418 test cases
- Source: ~1,614 non-test TS files, ~280k lines
- Validation: @sinclair/typebox (not Zod)
- Memory: sqlite-vec + BM25 hybrid, OpenAI/Gemini embeddings (cloud API)
- Channels: 16+ (WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/BlueBubbles/MS Teams/Matrix/Zalo/ZaloPersonal/WebChat/LINE + more via extensions)
- Apps: macOS (native Swift), iOS (Swift), Android (Kotlin)
- Skills system: bundled + managed + workspace skills, ClawHub registry
- Voice: ElevenLabs TTS (cloud), Voice Wake, Talk Mode
- Browser: Playwright-based CDP control, dedicated Chrome instance
- Canvas: agent-driven visual workspace (A2UI)
- Extensions: 30+ extension packages in extensions/ directory
- Cloud TTS: node-edge-tts, ElevenLabs
- Deployment: Docker, fly.io, Nix, npm global install
- Coverage threshold: 70% lines/functions/statements
- LOC limit: 500 lines per file (vs Eidolon's 300)

### OpenClaw vs Eidolon Key Differences
- OpenClaw: ~280k lines, 16+ channels, cloud-dependent (embeddings, TTS)
- Eidolon: ~55k lines, 4 channels, local-first (embeddings, TTS, KG)
- OpenClaw uses Pi agent runtime; Eidolon uses Claude Code CLI
- OpenClaw has no cognitive loop or dreaming; Eidolon has both
- OpenClaw has no knowledge graph; Eidolon has ComplEx + PageRank + Louvain
- OpenClaw has no self-learning pipeline; Eidolon has discovery + implementation
- OpenClaw has browser control + Canvas; Eidolon has neither
- OpenClaw has Android app; Eidolon does not

## Key Competitors by GitHub Stars (snapshot)
- AutoGPT: 182K stars
- Claude Code: 75K stars
- Open Interpreter: 63K stars
- Cline: 59K stars
- Mem0: 49K stars
- CrewAI: 45K stars
- Aider: 42K stars
- Jan: 41K stars
- AgentGPT: 36K stars
- Khoj: 33K stars
- Goose (Block): 33K stars
- Continue: 32K stars
- LangGraph: 26K stars
- smolagents (HF): 26K stars
- Letta (MemGPT): 21K stars
- OpenAI Agents SDK: 19K stars
- Google ADK: 18K stars
- Plandex: 15K stars
- E2B: 11K stars
- Pipecat: 11K stars
- LiveKit Agents: 10K stars
- Zep: 4K stars
- Devon: 3.5K stars

## Closest Competitors to Eidolon
1. Khoj -- most similar (personal AI, self-hosted, memory, automations)
2. Letta -- stateful agents with memory (but SDK/platform, not personal assistant)
3. Mem0 -- memory layer (component, not full system)
4. Jan -- local AI desktop app (but no daemon, no autonomy)

## Eidolon's Unique Combination (no single competitor has all):
- Self-hosted daemon with cognitive loop (autonomy)
- 5-layer memory with dreaming consolidation
- Self-learning from web sources
- Multi-channel (Telegram, Discord, WhatsApp, Email)
- Voice with GPU offloading
- Home automation integration
- Multi-device (Desktop, iOS, Web)
- Knowledge graph with ComplEx embeddings
- Claude Code as engine (not custom runtime)

## Biggest Competitive Gaps (March 2026 detailed analysis)
1. Community size -- all major competitors have 10-180x more stars
2. Computer-Use / Desktop automation -- Open Interpreter does this, Eidolon doesn't
3. IDE integration -- Continue.dev has deep IDE extension, Eidolon has none
4. Multimodal (video/image understanding) -- Apple/Google excel here
5. Wake-word + always-listening -- HA Voice has ESP32 satellites
6. Meeting recording + summarization -- Limitless specializes in this
7. UX polish for non-developers -- Eidolon is developer-centric

## Strategic Feature Priorities (derived from competitive analysis)
1. npm publish + better onboarding (adoption blocker)
2. Wyoming protocol for HA Voice satellite integration
3. Computer-Use plugin (Claude has computer-use API)
4. Meeting assistant (Calendar + Voice transcription)
5. IDE extension as plugin (bring Eidolon memory to VS Code/Cursor)
6. Visual automation builder in web dashboard (like AutoGPT)
7. Screen capture / activity tracking plugin (like Limitless)
8. Self-editing memory (from Letta -- agent actively edits its core memory)

## Detailed Competitor Notes

### Open Interpreter (63K stars)
- Natural language computer control (files, scripts, GUI)
- Multi-LLM, sandbox options, "01" hardware (experimental)
- Strengths vs Eidolon: computer-use, broader LLM support, bigger community, simpler install
- Weaknesses: no memory, no autonomy, no channels, no voice pipeline, no home automation

### Aider (42K stars)
- Git-aware AI coding, auto-commits, Tree-Sitter repo-map
- Architect+editor dual model, broad LLM support, SWE-Bench results
- Strengths vs Eidolon: mature coding workflow, Tree-Sitter analysis, LLM benchmarks
- Weaknesses: coding-only, no memory, no autonomy, terminal-only

### Continue.dev (32K stars)
- IDE extension (VS Code, JetBrains), tab-autocomplete, @-mentions
- Local model support, MCP integration, config hub
- Strengths vs Eidolon: deep IDE integration, tab-complete, @-mention context
- Weaknesses: IDE-only, no memory, no autonomy, no channels

### AutoGPT (182K stars)
- Evolved to agent platform with visual builder + marketplace
- Multi-agent orchestration, web browsing
- Strengths vs Eidolon: huge community, visual builder, marketplace, multi-agent
- Weaknesses: cloud-based, simple vector memory, no KG, no channels, no voice

### Letta/MemGPT (21K stars)
- Stanford research: hierarchical self-editing memory
- Core/Archival/Recall memory layers, memory pagination, SDK/API
- Strengths vs Eidolon: deeper memory research, self-editing memory, pagination
- Weaknesses: SDK only (not full assistant), no channels, no voice, no home automation

### Limitless/Rewind AI (commercial)
- Screen capture + meeting recording + wearable pendant
- Auto-transcription, searchable archive, action items
- Strengths vs Eidolon: screen capture, meeting recording, polished UX
- Weaknesses: cloud-dependent, no autonomy, no self-learning, subscription cost

### Home Assistant Voice
- Local STT/TTS, Wyoming protocol, ESP32 satellites, wake-word
- Strengths vs Eidolon: mature smart home ecosystem, voice satellites, multi-room
- Weaknesses: smart-home only, rule-based intents, no memory/learning

### Rabbit R1 / Humane AI Pin
- Dedicated hardware AI assistants, largely failed commercially
- Strengths vs Eidolon: dedicated hardware, camera AI
- Weaknesses: unreliable, expensive, closed, no real advantage over phone

### Apple Intelligence / Google Gemini
- System-level OS integration, massive user base, multimodal
- Strengths vs Eidolon: OS integration, multimodal, on-device models, polish
- Weaknesses: vendor lock-in, limited autonomy, no self-hosting, no self-learning
