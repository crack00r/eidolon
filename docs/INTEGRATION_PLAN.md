# Competitive Integration Plan

> **Date:** 2026-03-03
> **Author:** eidolon-planner agent
> **Status:** Proposed -- requires user approval before implementation begins
> **Baseline:** Eidolon v0.1.5, ~38,400 lines source, 946+ tests, 0 type errors, 92% complete per audit

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Strategic Decisions: What NOT to Build](#2-strategic-decisions-what-not-to-build)
3. [Dependency Map](#3-dependency-map)
4. [Sprint Plan](#4-sprint-plan)
5. [Sprint Details](#5-sprint-details)
6. [Files Index](#6-files-index)
7. [Risk Register](#7-risk-register)
8. [Effort Summary](#8-effort-summary)

---

## 1. Executive Summary

This plan integrates 43 competitive findings from OpenClaw, Mem0, Khoj, ZeroClaw, Aider, and the
MCP ecosystem into Eidolon's existing codebase. After analyzing the current code (90+ core source
files, WebSocket gateway with JSON-RPC, Channel interface, EventBus, scheduler, Prometheus metrics,
OpenAI-compat REST API already implemented), the findings are organized into 12 sprints across
3 tiers:

- **Tier 1 (Sprints 1-4):** High-impact, low-dependency features that enhance core value -- 4 weeks
- **Tier 2 (Sprints 5-8):** Medium-impact features that broaden capabilities -- 4 weeks
- **Tier 3 (Sprints 9-12):** Nice-to-haves and ecosystem features -- 4 weeks

**7 findings are explicitly rejected** as bad ideas or wrong for Eidolon's architecture.
**4 findings are already implemented** in the current codebase (marked in dependency map).

---

## 2. Strategic Decisions: What NOT to Build

### REJECT: 50+ Messaging Channels (Finding A-1)

OpenClaw's 15+ channel support is their biggest maintenance burden. Most channels are fragile,
poorly tested, and maintained by drive-by contributors. Eidolon takes the opposite approach:
support few channels well.

**Build instead:** Discord (large overlap with target users), WhatsApp Business API (most popular
messenger), Email (IMAP/SMTP). That gives 5 total channels (Telegram, Desktop, iOS, Discord,
WhatsApp). Email is deferred to v1.2. Signal, Slack, Matrix, iMessage are post-v2.0.

### REJECT: ClawHub / Skill Marketplace (Finding A-2)

A marketplace with 3000+ community skills requires enormous moderation, security review,
versioning, and support infrastructure. The ROI is negative for a personal assistant.

**Build instead:** MCP server templates (Finding D-35) provide the same extensibility through
the standardized MCP protocol, with the 10,000+ MCP server ecosystem as the "marketplace."

### REJECT: Plugin System (Finding A-12)

Same reasoning as the marketplace. MCP servers ARE the plugin system. Claude Code natively
supports MCP servers via `--mcp-config`. Building a custom plugin system would duplicate
existing infrastructure.

### REJECT: 22+ AI Provider Support (Finding B-25)

Eidolon's architecture is built around Claude Code CLI as the execution engine. Supporting
22+ providers would require building a custom agent runtime -- the exact thing we avoided by
using Claude Code. Local LLM support via Ollama is a v2.0 feature per the roadmap.

### REJECT: Session Branching (Finding A-6 / C-28)

Claude Code CLI does not support session forking at the process level. Implementing this would
require building a custom conversation state manager that replays conversation history into
new sessions -- significant complexity for a feature that is primarily a developer/debugging
tool rather than a personal assistant feature.

### REJECT: Conversation Templates (Finding A-14)

Pre-built conversation starters solve a problem Eidolon does not have. The Cognitive Loop and
memory system provide context automatically. Templates are a band-aid for stateless chatbots.

### REJECT: Remote Control via QR Code (Finding A-11)

Eidolon already has this as `eidolon pair` with QR code for client pairing
(`/Users/manuelguttmann/Projekte/eidolon/packages/cli/src/commands/pair.ts`). This is
ALREADY IMPLEMENTED.

### Already Implemented (no work needed)

| Finding | Status | Location |
|---|---|---|
| A-4: OpenAI-compatible REST API | DONE | `packages/core/src/gateway/openai-compat.ts` |
| A-11: Remote Control | DONE | `packages/cli/src/commands/pair.ts`, discovery module |
| A-15: Export/Import | DONE | `packages/cli/src/commands/privacy.ts` (GDPR export) |
| B-22: Aider auto-lint/test | DONE | Learning implementation pipeline + CI |

---

## 3. Dependency Map

```
                        ┌──────────────────────────┐
                        │ S1: Memory Consolidation  │ (no deps)
                        │ S2: Feedback Loop         │ (no deps)
                        │ S3: Structured Output     │ (no deps)
                        │ S4: Daily Digest          │ (needs scheduler)
                        └──────────┬───────────────┘
                                   │
                        ┌──────────▼───────────────┐
                        │ S5: Approval Escalation   │ (needs channels)
                        │ S6: Scheduled Automations │ (needs scheduler, memory)
                        │ S7: Webhook Ingestion     │ (needs gateway)
                        │ S8: MCP Templates + Health│ (needs config)
                        └──────────┬───────────────┘
                                   │
                        ┌──────────▼───────────────┐
                        │ S9: Discord Channel       │ (needs Channel interface)
                        │ S10: Rate Limit Dashboard │ (needs metrics)
                        │ S11: User Profile API     │ (needs memory)
                        │ S12: Multi-modal Input    │ (needs channels, memory)
                        └──────────────────────────┘
```

---

## 4. Sprint Plan

| Sprint | Theme | Duration | Effort | Findings Covered |
|---|---|---|---|---|
| S1 | Memory Consolidation (Mem0-style) | 1 week | Large | A-8, B-16, B-18, C-26 |
| S2 | Output Feedback Loop | 1 week | Medium | B-23, C-31 |
| S3 | Structured Output / JSON Mode | 1 week | Medium | A-5, C-29 |
| S4 | Daily Digest / Morning Briefing | 1 week | Medium | A-9, C-30 |
| S5 | Approval Gates with Escalation | 1 week | Medium | A-7, C-27 |
| S6 | Scheduled Automations (Khoj-style) | 1 week | Medium | B-19, C-33 |
| S7 | Webhook Ingestion | 1 week | Medium | C-32 |
| S8 | MCP Server Templates and Health | 1 week | Medium | D-35, D-36, D-37 |
| S9 | Discord Channel | 1 week | Large | partial A-1 |
| S10 | Rate Limit Dashboard and Metrics | 1 week | Medium | A-13, C-40, E-38 |
| S11 | User Profile API and Memory Compression | 1 week | Medium | B-17, B-20, B-24 |
| S12 | Multi-modal Input and Deep Research | 1 week | Large | C-34, B-21 |

**Total: ~12 weeks of focused implementation work.**

---

## 5. Sprint Details

### Sprint 1: Memory Consolidation (Mem0-style)

**Findings:** A-8 (Memory Compression), B-16 (ADD/UPDATE/DELETE/NOOP), B-18 (26% accuracy boost), C-26 (Configurable strategies)

**Summary:** Replace the current "always add" memory extraction with Mem0's consolidation approach:
classify each extracted memory as ADD, UPDATE, DELETE, or NOOP before writing. This prevents
memory bloat, resolves contradictions at extraction time (not just during dreaming), and measurably
improves memory quality.

**Current state:** The `MemoryExtractor` at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/memory/extractor.ts` extracts memories
and always creates new entries. The `MemoryStore` at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/memory/store.ts` has full CRUD. The
dreaming housekeeping phase at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/memory/dreaming/housekeeping.ts`
does deduplication post-hoc.

**Design:**

```typescript
// New type in packages/protocol/src/types/memory.ts
export type MemoryConsolidationAction = "ADD" | "UPDATE" | "DELETE" | "NOOP";

export interface ConsolidationDecision {
  readonly action: MemoryConsolidationAction;
  readonly memoryId?: string;        // for UPDATE/DELETE: which existing memory
  readonly content?: string;         // for ADD/UPDATE: the memory content
  readonly confidence?: number;      // for ADD/UPDATE
  readonly reason: string;           // why this action was chosen
}

// New type for compression strategy
export type CompressionStrategy = "none" | "progressive" | "hierarchical";
```

**Files to create:**

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/core/src/memory/consolidation.ts` | MemoryConsolidator class -- classify ADD/UPDATE/DELETE/NOOP | ~250 |
| `packages/core/src/memory/compression.ts` | MemoryCompressor -- progressive summarization, hierarchical compression | ~200 |
| `packages/core/src/memory/__tests__/consolidation.test.ts` | Tests for consolidation logic | ~300 |
| `packages/core/src/memory/__tests__/compression.test.ts` | Tests for compression strategies | ~200 |

**Files to modify:**

| File | Changes |
|---|---|
| `packages/protocol/src/types/memory.ts` | Add ConsolidationAction, ConsolidationDecision, CompressionStrategy types |
| `packages/protocol/src/config.ts` | Add `memory.consolidation` config section with strategy, thresholds |
| `packages/core/src/memory/extractor.ts` | Integrate consolidation step after extraction, before store write |
| `packages/core/src/memory/store.ts` | Add `findSimilar(content, threshold)` method for consolidation lookup |
| `packages/core/src/memory/search.ts` | Add `findByContent(content, limit)` for exact/near-exact match |
| `packages/core/src/daemon/index.ts` | Wire MemoryConsolidator into the daemon initialization chain |

**Implementation steps:**

1. Add types to protocol (ConsolidationAction, CompressionStrategy)
2. Add config schema for `memory.consolidation` with `strategy`, `similarityThreshold`, `compressionStrategy`
3. Implement `MemoryConsolidator` class:
   - Takes an extracted memory + searches existing store for similar content
   - Uses cosine similarity on embeddings to find candidates (threshold configurable, default 0.85)
   - Classification logic: if sim > 0.95 = NOOP (duplicate), if sim > 0.85 = UPDATE (merge), if content contradicts = DELETE old + ADD new, else ADD
   - Optional LLM-based classification for ambiguous cases (injected function like extractor)
4. Implement `MemoryCompressor` class:
   - Progressive: when a memory cluster grows past N items, summarize older ones into a single compressed memory
   - Hierarchical: organize memories into topic groups, compress each group independently
5. Modify `MemoryExtractor.extract()` to run consolidation before writing
6. Add `MemoryStore.findSimilar()` using embedding cosine similarity
7. Wire into daemon initialization
8. Write tests: consolidation decisions (ADD/UPDATE/DELETE/NOOP), compression triggers, end-to-end

**Test plan:** 15+ tests covering:
- Duplicate detection (NOOP when sim > 0.95)
- Update detection (UPDATE when sim 0.85-0.95)
- Contradiction handling (DELETE old + ADD new)
- New memory (ADD when no similar found)
- Progressive compression trigger
- Hierarchical compression grouping
- Config-driven threshold changes

**Exit criteria:** Memory extraction uses consolidation by default. Running the same conversation
twice does not create duplicate memories. Contradictory information replaces old memories.

---

### Sprint 2: Output Feedback Loop

**Findings:** B-23 (Aider's feedback loop), C-31 (Rate responses)

**Summary:** Allow users to rate Eidolon's responses with thumbs up/down (or 1-5 stars). Ratings
are stored in operational.db and used to: (1) adjust memory extraction confidence, (2) provide
training signal during dreaming, (3) surface in dashboards for self-monitoring.

**Current state:** The gateway server at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/gateway/server.ts` supports JSON-RPC
method registration. The Telegram channel at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/channels/telegram/channel.ts` supports
editing messages. The EventBus already has typed events.

**Files to create:**

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/core/src/feedback/store.ts` | FeedbackStore -- CRUD for response ratings | ~200 |
| `packages/core/src/feedback/index.ts` | Barrel export | ~5 |
| `packages/core/src/feedback/__tests__/store.test.ts` | Tests | ~250 |

**Files to modify:**

| File | Changes |
|---|---|
| `packages/protocol/src/types/events.ts` | Add `"user:feedback"` event type |
| `packages/protocol/src/types/gateway.ts` | Add `"feedback.submit"` and `"feedback.list"` RPC methods |
| `packages/protocol/src/types/index.ts` | Export new feedback types |
| `packages/core/src/gateway/server.ts` | Register `feedback.submit` and `feedback.list` handlers |
| `packages/core/src/channels/telegram/channel.ts` | Add inline keyboard for thumbs up/down after responses |
| `packages/core/src/memory/extractor.ts` | Boost/decay memory confidence based on feedback for associated session |
| `packages/core/src/loop/event-bus.ts` | Add `"user:feedback"` to valid event types |
| `packages/core/src/database/schemas/operational.ts` | Add `feedback` table migration |
| `apps/desktop/src/routes/chat/+page.svelte` | Add rating UI to chat messages |
| `apps/web/src/routes/chat/+page.svelte` | Add rating UI to chat messages |

**Implementation steps:**

1. Add feedback types to protocol
2. Create `feedback` table in operational.db: `id, session_id, message_id, rating (1-5), channel, created_at`
3. Implement `FeedbackStore` with `submit()`, `getForSession()`, `getAverageRating()`
4. Register gateway RPC handlers
5. Add Telegram inline keyboard (thumbs up = 5, thumbs down = 1)
6. Modify memory extractor: when feedback arrives, adjust confidence of memories extracted from that session (+0.1 for positive, -0.1 for negative)
7. Add feedback event to EventBus for downstream processing
8. Add UI controls in desktop and web chat views

**Test plan:** 10+ tests covering store CRUD, rating aggregation, confidence adjustment, Telegram keyboard

---

### Sprint 3: Structured Output / JSON Mode

**Findings:** A-5 (Structured Output), C-29 (Force JSON schemas)

**Summary:** Allow Claude Code sessions to be constrained to output specific JSON schemas. This
is critical for memory extraction, relevance filtering, and any programmatic use of Claude responses.

**Current state:** The `ClaudeCodeManager` at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/claude/manager.ts` implements
`IClaudeProcess`. The args builder at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/claude/args.ts` constructs CLI arguments.
Claude Code CLI supports `--output-format stream-json` but not schema constraints natively.

**Design:** Structured output is achieved by injecting a system prompt suffix that includes the
Zod/JSON schema and validation instructions, then parsing the response against the schema on
the Eidolon side. If parsing fails, retry with an error correction prompt (up to 2 retries).

**Files to create:**

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/core/src/claude/structured-output.ts` | StructuredOutputParser -- schema injection + response validation | ~250 |
| `packages/core/src/claude/__tests__/structured-output.test.ts` | Tests | ~200 |

**Files to modify:**

| File | Changes |
|---|---|
| `packages/protocol/src/types/claude.ts` | Add `outputSchema?: z.ZodType` to `ClaudeSessionOptions` |
| `packages/core/src/claude/args.ts` | Generate schema instruction prompt from Zod schema |
| `packages/core/src/claude/manager.ts` | Integrate structured output parsing into response pipeline |
| `packages/core/src/memory/extractor.ts` | Use structured output for LLM extraction (replace free-form JSON prompt) |
| `packages/core/src/learning/relevance.ts` | Use structured output for relevance scoring |

**Implementation steps:**

1. Create `StructuredOutputParser` class that accepts a Zod schema
2. Generate a system prompt suffix from the schema: "You MUST respond with valid JSON matching this schema: ..."
3. After response, attempt `schema.safeParse(JSON.parse(response))`
4. On parse failure, construct correction prompt: "Your response did not match the required schema. Error: {error}. Please correct and respond again."
5. Retry up to 2 times
6. Return `Result<T, EidolonError>` where T is the inferred Zod type
7. Refactor memory extractor and relevance filter to use structured output

**Test plan:** 10+ tests covering schema generation, valid parse, invalid parse with retry, max retries exhausted

---

### Sprint 4: Daily Digest / Morning Briefing

**Findings:** A-9 (Daily Digest), C-30 (Customizable sections)

**Summary:** Every morning (configurable time), Eidolon compiles a digest of: what happened
yesterday (conversations, learning discoveries, memory changes), what is scheduled today,
actionable items, and optional weather/calendar context via MCP servers.

**Current state:** The `TaskScheduler` at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/scheduler/scheduler.ts` supports
recurring tasks with cron-like scheduling. The `EventBus` already emits `scheduler:task_due`.
The `MessageRouter` at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/channels/router.ts` can route messages
to any registered channel.

**Files to create:**

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/core/src/digest/builder.ts` | DigestBuilder -- assembles digest sections from various sources | ~300 |
| `packages/core/src/digest/index.ts` | Barrel export | ~5 |
| `packages/core/src/digest/__tests__/builder.test.ts` | Tests | ~250 |

**Files to modify:**

| File | Changes |
|---|---|
| `packages/protocol/src/config.ts` | Add `digest` config section: enabled, time, timezone, sections, channel |
| `packages/core/src/daemon/index.ts` | Wire DigestBuilder, register scheduled task on startup |
| `packages/core/src/loop/cognitive-loop.ts` | Handle `digest:generate` event type |
| `packages/core/src/loop/event-bus.ts` | Add `"digest:generate"` and `"digest:delivered"` to valid event types |

**Design:**

```typescript
export interface DigestConfig {
  readonly enabled: boolean;
  readonly time: string;          // "07:00" -- when to deliver
  readonly timezone: string;      // "Europe/Berlin"
  readonly channel: string;       // "telegram" | "desktop" | "all"
  readonly sections: {
    readonly conversations: boolean;   // Summary of yesterday's conversations
    readonly learning: boolean;        // Discoveries and implemented changes
    readonly memory: boolean;          // New memories, consolidation stats
    readonly schedule: boolean;        // Today's scheduled tasks
    readonly metrics: boolean;         // Token usage, cost summary
    readonly actionItems: boolean;     // Pending approvals, reminders
  };
}
```

**Implementation steps:**

1. Add digest config schema to protocol
2. Implement `DigestBuilder` class with methods for each section
3. `buildConversationSummary()`: query sessions from last 24h, summarize
4. `buildLearningSummary()`: query discoveries from last 24h
5. `buildMemoryStats()`: count new memories, consolidation results
6. `buildSchedule()`: query today's scheduled tasks
7. `buildMetrics()`: query token usage summary from TokenTracker
8. `buildActionItems()`: query pending approvals from discoveries table
9. On daemon startup, register a recurring task at the configured digest time
10. When triggered, build digest markdown and route via MessageRouter

**Test plan:** 10+ tests covering each section builder, empty state handling, config-driven section selection, delivery routing

---

### Sprint 5: Approval Gates with Escalation

**Findings:** A-7 (Timeout Policies), C-27 (Escalation chains)

**Summary:** Enhance the existing approval system with configurable timeout policies and
escalation chains. When an approval request times out, it can auto-deny, auto-approve (for
safe actions only), or escalate to a different channel.

**Current state:** The security policies at
`/Users/manuelguttmann/Projekte/eidolon/packages/protocol/src/types/security.ts` define
`ActionLevel`. The daemon handles approvals inline. There is no escalation mechanism.

**Files to create:**

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/core/src/security/approval-manager.ts` | ApprovalManager -- timeout, escalation, policy enforcement | ~300 |
| `packages/core/src/security/__tests__/approval-manager.test.ts` | Tests | ~250 |

**Files to modify:**

| File | Changes |
|---|---|
| `packages/protocol/src/config.ts` | Add `security.approval` config: timeouts per level, escalation chain |
| `packages/protocol/src/types/security.ts` | Add `ApprovalRequest`, `EscalationPolicy` types |
| `packages/protocol/src/types/events.ts` | Add `"approval:requested"`, `"approval:timeout"`, `"approval:escalated"` |
| `packages/core/src/loop/event-bus.ts` | Add new event types |
| `packages/core/src/channels/telegram/channel.ts` | Add inline keyboard for approve/deny |
| `packages/core/src/gateway/server.ts` | Register `approval.list`, `approval.respond` RPC methods |
| `packages/core/src/database/schemas/operational.ts` | Add `approval_requests` table |

**Design:**

```typescript
export interface EscalationPolicy {
  readonly timeoutMs: number;             // Time before escalation
  readonly action: "deny" | "approve" | "escalate";
  readonly escalateTo?: string;           // Channel ID to escalate to
  readonly maxEscalations?: number;       // Max chain length (default 3)
}

export interface ApprovalRequest {
  readonly id: string;
  readonly action: string;
  readonly level: ActionLevel;
  readonly description: string;
  readonly requestedAt: number;
  readonly timeoutAt: number;
  readonly channel: string;
  readonly status: "pending" | "approved" | "denied" | "timeout" | "escalated";
  readonly respondedBy?: string;
  readonly escalationLevel: number;
}
```

**Implementation steps:**

1. Add types and config schema
2. Create `approval_requests` table in operational.db
3. Implement `ApprovalManager` class:
   - `requestApproval(action, level, description)` -- creates request, sends to channel
   - `checkTimeouts()` -- called periodically, handles expired requests
   - `respond(id, approved, respondedBy)` -- records response
   - `escalate(id)` -- moves to next channel in chain
4. Integrate with Telegram via inline keyboards
5. Add gateway RPC methods for desktop/web
6. Wire timeout checking into cognitive loop cycle
7. Write tests

**Test plan:** 12+ tests covering request creation, timeout auto-deny, timeout auto-approve, escalation chain, max escalation limit, concurrent approvals

---

### Sprint 6: Scheduled Automations (Khoj-style)

**Findings:** B-19 (Khoj automations), C-33 (Natural language scheduling)

**Summary:** Allow users to create scheduled automations in natural language: "Every Monday at 9am,
research TypeScript news and send me a summary." The automation is parsed into a scheduled task
with a Claude Code session prompt.

**Current state:** The `TaskScheduler` at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/scheduler/scheduler.ts` supports
once/recurring/conditional tasks with cron expressions. The `CognitiveLoop` handles
`scheduler:task_due` events.

**Files to create:**

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/core/src/scheduler/automation.ts` | AutomationEngine -- natural language to scheduled task | ~250 |
| `packages/core/src/scheduler/__tests__/automation.test.ts` | Tests | ~200 |

**Files to modify:**

| File | Changes |
|---|---|
| `packages/protocol/src/types/scheduling.ts` | Add `AutomationTask` type with `prompt`, `deliverTo` fields |
| `packages/protocol/src/types/gateway.ts` | Add `"automation.create"`, `"automation.list"`, `"automation.delete"` |
| `packages/core/src/gateway/server.ts` | Register automation RPC methods |
| `packages/core/src/scheduler/scheduler.ts` | Add `createFromNaturalLanguage()` method |
| `packages/core/src/loop/cognitive-loop.ts` | Route automation tasks to Claude Code session with result delivery |
| `packages/cli/src/commands/daemon.ts` | Add `eidolon automation create/list/delete` subcommands |

**Implementation steps:**

1. Add automation types to protocol
2. Implement `AutomationEngine.parseNaturalLanguage(text)`:
   - Use Claude (Haiku) to extract: schedule (cron), action description, delivery channel
   - Return structured `AutomationTask`
3. Store automation as a scheduled task with `action: "automation"` and payload containing the Claude prompt
4. When triggered, spawn a Claude Code session with the automation prompt
5. Deliver results via MessageRouter to configured channel
6. Register gateway RPC methods and CLI commands
7. Write tests

**Test plan:** 10+ tests covering NL parsing (weekly, daily, conditional), task creation, execution routing, result delivery

---

### Sprint 7: Webhook Ingestion

**Findings:** C-32 (Webhook events from external services)

**Summary:** Add a webhook endpoint to the gateway that can receive events from external services
(GitHub, monitoring tools, CI pipelines, IFTTT, etc.) and route them through the EventBus for
the Cognitive Loop to process.

**Current state:** The `GatewayServer` at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/gateway/server.ts` already serves
HTTP on the gateway port (for health, metrics, OpenAI-compat). Adding webhook routes is
straightforward.

**Files to create:**

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/core/src/gateway/webhooks.ts` | WebhookHandler -- route incoming webhooks to EventBus | ~250 |
| `packages/core/src/gateway/__tests__/webhooks.test.ts` | Tests | ~200 |

**Files to modify:**

| File | Changes |
|---|---|
| `packages/protocol/src/config.ts` | Add `gateway.webhooks` config: enabled, endpoints list with token + eventType |
| `packages/protocol/src/types/events.ts` | Add `"webhook:received"` event type |
| `packages/core/src/gateway/server.ts` | Route `POST /webhooks/:id` to WebhookHandler |
| `packages/core/src/loop/event-bus.ts` | Add `"webhook:received"` to valid event types |
| `packages/core/src/loop/cognitive-loop.ts` | Handle webhook events in the evaluate phase |

**Design:**

```typescript
// Config
export const WebhookEndpointSchema = z.object({
  id: z.string(),                           // URL path segment: /webhooks/{id}
  name: z.string(),                         // Human-readable name
  token: SecretRefSchema.or(z.string()),    // Auth token (Bearer or query param)
  eventType: z.string().default("webhook:received"),
  priority: z.enum(["critical", "high", "normal", "low"]).default("normal"),
  enabled: z.boolean().default(true),
});
```

**Implementation steps:**

1. Add webhook config schema
2. Implement `WebhookHandler` class:
   - Validate auth token (Bearer header or `?token=` query param)
   - Parse JSON body
   - Publish to EventBus as `webhook:received` with payload including source ID
3. Integrate into gateway HTTP routing
4. The Cognitive Loop treats webhook events like any other -- prioritized and processed
5. Write tests

**Test plan:** 10+ tests covering auth validation, payload parsing, EventBus integration, invalid auth rejection, malformed body

---

### Sprint 8: MCP Server Templates and Health Monitoring

**Findings:** D-35 (Pre-configured templates), D-36 (Health monitoring), D-37 (Marketplace browsing)

**Summary:** Provide pre-configured MCP server definitions for common integrations (GitHub,
Slack, databases, filesystem), monitor MCP server health, and enable browsing the MCP ecosystem.

**Current state:** MCP servers are configured in `brain.mcpServers` as a record of name to
`{command, args, env}`. There is no health monitoring or templating.

**Files to create:**

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/core/src/mcp/templates.ts` | MCP server template definitions | ~200 |
| `packages/core/src/mcp/health.ts` | MCPHealthMonitor -- check if MCP servers respond | ~200 |
| `packages/core/src/mcp/index.ts` | Barrel export | ~5 |
| `packages/core/src/mcp/__tests__/health.test.ts` | Tests | ~150 |
| `packages/cli/src/commands/mcp.ts` | `eidolon mcp list/add/status` CLI commands | ~200 |

**Files to modify:**

| File | Changes |
|---|---|
| `packages/protocol/src/config.ts` | Add `brain.mcpTemplates` for available templates |
| `packages/core/src/health/checker.ts` | Add MCP server health checks |
| `packages/core/src/daemon/index.ts` | Wire MCPHealthMonitor |
| `packages/cli/src/index.ts` | Register mcp commands |

**Design -- Templates:**

```typescript
export const MCP_TEMPLATES: Record<string, McpTemplate> = {
  "home-assistant": {
    name: "Home Assistant",
    command: "npx",
    args: ["-y", "mcp-server-home-assistant"],
    env: { HA_TOKEN: "$secret:HA_TOKEN", HA_URL: "http://homeassistant.local:8123" },
    requiredSecrets: ["HA_TOKEN"],
    description: "Control Home Assistant devices",
  },
  "github": {
    name: "GitHub",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "$secret:GITHUB_TOKEN" },
    requiredSecrets: ["GITHUB_TOKEN"],
    description: "GitHub repository operations",
  },
  // ... brave-search, filesystem, sqlite, slack, notion, linear
};
```

**Implementation steps:**

1. Define template catalog (10+ common MCP servers)
2. Implement `MCPHealthMonitor`: periodically spawn MCP server with a ping, track response time
3. Implement `eidolon mcp add github` -- reads template, prompts for secrets, adds to config
4. Implement `eidolon mcp status` -- shows health of configured MCP servers
5. Integrate health into HealthChecker
6. Write tests

**Test plan:** 8+ tests covering template loading, health check pass/fail, CLI add flow, health integration

---

### Sprint 9: Discord Channel

**Findings:** partial A-1 (second channel beyond Telegram)

**Summary:** Add Discord as a second messaging channel using discord.js. Discord has significant
overlap with the technical user base and is simpler than WhatsApp (no phone pairing, stable API).

**Current state:** The `Channel` interface at
`/Users/manuelguttmann/Projekte/eidolon/packages/protocol/src/types/channels.ts` is well-defined.
The `MessageRouter` at `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/channels/router.ts`
supports multiple channels. The `TelegramChannel` is a reference implementation.

**Files to create:**

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/core/src/channels/discord/channel.ts` | DiscordChannel implements Channel | ~350 |
| `packages/core/src/channels/discord/formatter.ts` | Format markdown for Discord (embed support) | ~100 |
| `packages/core/src/channels/discord/index.ts` | Barrel export | ~5 |
| `packages/core/src/channels/discord/__tests__/channel.test.ts` | Tests | ~300 |
| `packages/core/src/channels/discord/__tests__/formatter.test.ts` | Tests | ~100 |

**Files to modify:**

| File | Changes |
|---|---|
| `packages/protocol/src/config.ts` | Add `channels.discord` config section |
| `packages/core/src/daemon/index.ts` | Wire DiscordChannel if enabled |
| `packages/core/src/channels/router.ts` | Register Discord channel |
| `packages/core/package.json` | Add `discord.js` dependency |

**Design:** Follow the TelegramChannel pattern exactly:
- Capabilities: text, markdown, images, documents, voice (partial), reactions, editing, streaming (via message edits)
- User allowlist by Discord user ID
- Slash commands: `/status`, `/new`, `/memory`, `/learn`, `/approve`
- DM-only mode (no public channel responses)
- Rate limiting per user

**Implementation steps:**

1. Add Discord config schema (botToken, allowedUserIds, guildId)
2. Implement `DiscordChannel` following TelegramChannel patterns
3. Implement Discord markdown formatter (embeds for structured content)
4. Wire into daemon and message router
5. Write tests with mocked discord.js client

**Test plan:** 15+ tests covering connect/disconnect, message routing, formatting, allowlist enforcement, rate limiting, slash commands

---

### Sprint 10: Rate Limit Dashboard and Metrics Export

**Findings:** A-13 (Rate Limit Dashboard), C-40 (Visualization), E-38 (Dependency auditing)

**Summary:** Enhance the existing Prometheus metrics with per-account rate limit tracking, add a
visual dashboard view, and add automated dependency vulnerability scanning.

**Current state:** The `MetricsRegistry` at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/metrics/prometheus.ts` tracks events,
tokens, cost, sessions, queue depth, and loop cycle time. The health server exposes `/metrics`.
Account rotation at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/claude/account-rotation.ts` tracks
per-account usage.

**Files to create:**

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/core/src/metrics/rate-limits.ts` | RateLimitTracker -- per-account usage metrics | ~150 |
| `packages/core/src/metrics/__tests__/rate-limits.test.ts` | Tests | ~100 |

**Files to modify:**

| File | Changes |
|---|---|
| `packages/core/src/metrics/prometheus.ts` | Add rate limit gauges per account |
| `packages/core/src/metrics/wiring.ts` | Wire rate limit metrics from account rotation |
| `packages/core/src/claude/account-rotation.ts` | Expose usage stats for metrics collection |
| `packages/protocol/src/types/gateway.ts` | Add `"metrics.rateLimit"` RPC method |
| `packages/core/src/gateway/server.ts` | Register metrics RPC handler |
| `apps/desktop/src/routes/dashboard/+page.svelte` | Add rate limit visualization |
| `apps/web/src/routes/dashboard/+page.svelte` | Add rate limit visualization |
| `.github/workflows/ci.yml` | Add `pnpm audit --audit-level=high` step |

**Implementation steps:**

1. Implement `RateLimitTracker` that exposes per-account: tokens used (current hour), remaining quota, cooldown status, error count
2. Add Prometheus gauges for each account's rate limit state
3. Add gateway RPC method to query rate limit status
4. Add dashboard UI with per-account bars showing usage vs. limits
5. Add `pnpm audit` to CI pipeline

**Test plan:** 8+ tests covering metric recording, per-account tracking, Prometheus output format, RPC response

---

### Sprint 11: User Profile API and Obsidian Integration

**Findings:** B-17 (Mem0's `get_profile()`), B-20 (Khoj Obsidian plugin), B-24 (ZeroClaw performance insights)

**Summary:** Generate a structured user profile from accumulated memories (like Mem0), and add
Obsidian vault indexing as a document source.

**Current state:** The `MemoryInjector` at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/memory/injector.ts` already aggregates
user context. The document indexer (referenced in memory/dreaming) indexes files. The KG entity
store tracks person entities.

**Files to create:**

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/core/src/memory/profile.ts` | UserProfileBuilder -- structured profile from memories | ~250 |
| `packages/core/src/memory/obsidian.ts` | ObsidianIndexer -- index Obsidian vault with wikilink support | ~200 |
| `packages/core/src/memory/__tests__/profile.test.ts` | Tests | ~200 |
| `packages/core/src/memory/__tests__/obsidian.test.ts` | Tests | ~150 |

**Files to modify:**

| File | Changes |
|---|---|
| `packages/protocol/src/types/memory.ts` | Add `UserProfile` type |
| `packages/protocol/src/types/gateway.ts` | Add `"profile.get"` RPC method |
| `packages/protocol/src/config.ts` | Add `memory.indexing.obsidian` config with vault path |
| `packages/core/src/gateway/server.ts` | Register `profile.get` handler |
| `packages/core/src/memory/injector.ts` | Use profile in MEMORY.md injection |

**Design -- UserProfile:**

```typescript
export interface UserProfile {
  readonly name: string;
  readonly timezone?: string;
  readonly languages: readonly string[];
  readonly interests: readonly string[];
  readonly preferences: ReadonlyMap<string, string>;   // key-value pairs
  readonly devices: readonly string[];
  readonly recentTopics: readonly string[];             // from last 7 days
  readonly skills: readonly string[];                   // from procedural memory
  readonly relationships: readonly { name: string; relation: string }[];
  readonly generatedAt: number;
}
```

**Implementation steps:**

1. Add `UserProfile` type to protocol
2. Implement `UserProfileBuilder`:
   - Query memories of type `preference` to build preferences map
   - Query KG entities of type `person` for relationships
   - Query KG entities of type `technology` for interests
   - Query recent episodic memories for recent topics
   - Query skill memories for skills list
3. Implement `ObsidianIndexer`:
   - Read `.md` files from configured vault path
   - Parse `[[wikilinks]]` and `#tags`
   - Store as memories with type `fact` and source `document:obsidian`
   - Create KG edges from wikilinks (entity A links_to entity B)
4. Register gateway RPC method
5. Integrate profile into memory injection
6. Write tests

**Test plan:** 12+ tests covering profile building from memories, empty state, Obsidian parsing with wikilinks, tag extraction

---

### Sprint 12: Multi-modal Input and Deep Research

**Findings:** C-34 (Multi-modal input), B-21 (Khoj `/research`)

**Summary:** Enhance message handling to analyze images, PDFs, and screenshots in conversations,
and add a `/research` command for deep multi-source research with citations.

**Current state:** The Telegram channel at
`/Users/manuelguttmann/Projekte/eidolon/packages/core/src/channels/telegram/media.ts` already
handles media downloads. Claude Code natively supports image analysis. PDF indexing exists in
the document indexer.

**Files to create:**

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/core/src/research/engine.ts` | ResearchEngine -- multi-source deep research | ~350 |
| `packages/core/src/research/index.ts` | Barrel export | ~5 |
| `packages/core/src/research/__tests__/engine.test.ts` | Tests | ~250 |

**Files to modify:**

| File | Changes |
|---|---|
| `packages/protocol/src/types/events.ts` | Add `"research:started"`, `"research:completed"` events |
| `packages/protocol/src/types/gateway.ts` | Add `"research.start"`, `"research.status"` RPC methods |
| `packages/core/src/channels/telegram/channel.ts` | Pass image/document attachments to Claude Code workspace |
| `packages/core/src/claude/workspace.ts` (or equivalent) | Copy attachments to workspace directory for Claude Code access |
| `packages/core/src/gateway/server.ts` | Register research RPC methods |
| `packages/core/src/loop/event-bus.ts` | Add research event types |
| `packages/core/src/loop/cognitive-loop.ts` | Handle research events |

**Design -- ResearchEngine:**

```typescript
export interface ResearchRequest {
  readonly query: string;
  readonly sources: readonly ("web" | "academic" | "github" | "hackernews" | "reddit")[];
  readonly maxSources: number;         // default 10
  readonly deliverTo: string;          // channel ID
}

export interface ResearchResult {
  readonly query: string;
  readonly findings: readonly ResearchFinding[];
  readonly summary: string;
  readonly citations: readonly Citation[];
  readonly tokensUsed: number;
  readonly duration: number;
}
```

**Implementation steps:**

1. For multi-modal: when Telegram receives images/documents, save to workspace directory and include in Claude Code session context
2. For research: implement `ResearchEngine`:
   - Accept research query
   - Spawn Claude Code session with web search tools enabled
   - System prompt instructs: "Research the following topic from multiple sources. Cite every claim. Produce a structured report."
   - Parse response for citations
   - Store findings in memory
   - Deliver formatted report to channel
3. Add `/research` as Telegram command and gateway RPC
4. Write tests

**Test plan:** 12+ tests covering research flow with FakeClaudeProcess, citation extraction, image attachment handling, PDF pass-through

---

## 6. Files Index

### New Files (by sprint)

| Sprint | File | Lines |
|---|---|---|
| S1 | `packages/core/src/memory/consolidation.ts` | ~250 |
| S1 | `packages/core/src/memory/compression.ts` | ~200 |
| S2 | `packages/core/src/feedback/store.ts` | ~200 |
| S2 | `packages/core/src/feedback/index.ts` | ~5 |
| S3 | `packages/core/src/claude/structured-output.ts` | ~250 |
| S4 | `packages/core/src/digest/builder.ts` | ~300 |
| S4 | `packages/core/src/digest/index.ts` | ~5 |
| S5 | `packages/core/src/security/approval-manager.ts` | ~300 |
| S6 | `packages/core/src/scheduler/automation.ts` | ~250 |
| S7 | `packages/core/src/gateway/webhooks.ts` | ~250 |
| S8 | `packages/core/src/mcp/templates.ts` | ~200 |
| S8 | `packages/core/src/mcp/health.ts` | ~200 |
| S8 | `packages/core/src/mcp/index.ts` | ~5 |
| S8 | `packages/cli/src/commands/mcp.ts` | ~200 |
| S9 | `packages/core/src/channels/discord/channel.ts` | ~350 |
| S9 | `packages/core/src/channels/discord/formatter.ts` | ~100 |
| S9 | `packages/core/src/channels/discord/index.ts` | ~5 |
| S10 | `packages/core/src/metrics/rate-limits.ts` | ~150 |
| S11 | `packages/core/src/memory/profile.ts` | ~250 |
| S11 | `packages/core/src/memory/obsidian.ts` | ~200 |
| S12 | `packages/core/src/research/engine.ts` | ~350 |
| S12 | `packages/core/src/research/index.ts` | ~5 |
| **Total new source files** | **22** | **~4,075** |

### New Test Files

| Sprint | File | Lines |
|---|---|---|
| S1 | `packages/core/src/memory/__tests__/consolidation.test.ts` | ~300 |
| S1 | `packages/core/src/memory/__tests__/compression.test.ts` | ~200 |
| S2 | `packages/core/src/feedback/__tests__/store.test.ts` | ~250 |
| S3 | `packages/core/src/claude/__tests__/structured-output.test.ts` | ~200 |
| S4 | `packages/core/src/digest/__tests__/builder.test.ts` | ~250 |
| S5 | `packages/core/src/security/__tests__/approval-manager.test.ts` | ~250 |
| S6 | `packages/core/src/scheduler/__tests__/automation.test.ts` | ~200 |
| S7 | `packages/core/src/gateway/__tests__/webhooks.test.ts` | ~200 |
| S8 | `packages/core/src/mcp/__tests__/health.test.ts` | ~150 |
| S9 | `packages/core/src/channels/discord/__tests__/channel.test.ts` | ~300 |
| S9 | `packages/core/src/channels/discord/__tests__/formatter.test.ts` | ~100 |
| S10 | `packages/core/src/metrics/__tests__/rate-limits.test.ts` | ~100 |
| S11 | `packages/core/src/memory/__tests__/profile.test.ts` | ~200 |
| S11 | `packages/core/src/memory/__tests__/obsidian.test.ts` | ~150 |
| S12 | `packages/core/src/research/__tests__/engine.test.ts` | ~250 |
| **Total new test files** | **15** | **~3,100** |

### Frequently Modified Files (across sprints)

| File | Sprints | Total Changes |
|---|---|---|
| `packages/protocol/src/config.ts` | S1, S4, S5, S7, S8, S9, S11 | 7 sprints |
| `packages/protocol/src/types/events.ts` | S2, S5, S7, S12 | 4 sprints |
| `packages/protocol/src/types/gateway.ts` | S2, S5, S6, S10, S11, S12 | 6 sprints |
| `packages/core/src/gateway/server.ts` | S2, S5, S6, S7, S10, S11, S12 | 7 sprints |
| `packages/core/src/daemon/index.ts` | S1, S4, S8, S9 | 4 sprints |
| `packages/core/src/loop/event-bus.ts` | S2, S4, S5, S7, S12 | 5 sprints |

---

## 7. Risk Register

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Discord.js adds significant bundle size | Medium | High | Tree-shake, lazy import only when Discord enabled |
| Memory consolidation may over-aggressively DELETE | High | Medium | Conservative default thresholds, always require sim > 0.95 for NOOP, log all decisions |
| Structured output retry loop burns tokens | Medium | Medium | Max 2 retries, use Haiku for retries, budget cap per structured call |
| Webhook endpoint becomes attack vector | High | Medium | Per-endpoint auth tokens, rate limiting, payload size limits, input validation |
| MCP health monitoring spawns too many processes | Medium | Low | Health check interval minimum 60s, sequential (not parallel) checks |
| Approval escalation creates notification spam | Medium | Medium | Max 3 escalations, DND respected on all channels, configurable cooldown |
| Obsidian indexer overwhelmed by large vaults | Medium | Medium | Max file count, incremental indexing, configurable exclude patterns |
| Natural language schedule parsing unreliable | Medium | High | Always confirm parsed schedule with user before creating, show cron preview |

---

## 8. Effort Summary

| Category | Count | Est. Lines |
|---|---|---|
| New source files | 22 | ~4,075 |
| New test files | 15 | ~3,100 |
| Modified source files | ~25 unique | ~1,500 net additions |
| Modified test files | ~5 | ~500 net additions |
| **Total new code** | **37 files** | **~7,175** |
| **Total modifications** | **~30 files** | **~2,000** |

**Projected codebase after integration:**
- Source: ~42,500 lines (from ~38,400)
- Tests: ~20,900 lines (from ~17,800)
- Test count: ~1,100 (from ~946)

| Sprint | Effort | Duration |
|---|---|---|
| S1: Memory Consolidation | Large | 1 week |
| S2: Feedback Loop | Medium | 1 week |
| S3: Structured Output | Medium | 1 week |
| S4: Daily Digest | Medium | 1 week |
| S5: Approval Escalation | Medium | 1 week |
| S6: Scheduled Automations | Medium | 1 week |
| S7: Webhook Ingestion | Medium | 1 week |
| S8: MCP Templates | Medium | 1 week |
| S9: Discord Channel | Large | 1 week |
| S10: Rate Limit Dashboard | Medium | 1 week |
| S11: User Profile + Obsidian | Medium | 1 week |
| S12: Multi-modal + Research | Large | 1 week |
| **Total** | | **~12 weeks** |

---

## Appendix A: Finding Disposition Table

| # | Finding | Disposition | Sprint |
|---|---|---|---|
| A-1 | 50+ messaging channels | PARTIAL (Discord + WhatsApp in roadmap) | S9 |
| A-2 | ClawHub / Skill Marketplace | REJECT (use MCP ecosystem) | -- |
| A-3 | Canvas / Visual Output | DEFER to v1.2 (needs client-side rendering) | -- |
| A-4 | OpenAI-compatible REST API | ALREADY DONE | -- |
| A-5 | Structured Output / JSON Mode | BUILD | S3 |
| A-6 | Session Branching | REJECT (CLI limitation) | -- |
| A-7 | Approval Gates with Escalation | BUILD | S5 |
| A-8 | Memory Compression | BUILD | S1 |
| A-9 | Daily Digest / Morning Briefing | BUILD | S4 |
| A-10 | Multi-user Support | DEFER to v1.2 (architectural change) | -- |
| A-11 | Remote Control | ALREADY DONE | -- |
| A-12 | Plugin System | REJECT (MCP is the plugin system) | -- |
| A-13 | Rate Limit Dashboard | BUILD | S10 |
| A-14 | Conversation Templates | REJECT (solved by memory/context) | -- |
| A-15 | Export/Import | ALREADY DONE (GDPR export) | -- |
| B-16 | Mem0 ADD/UPDATE/DELETE/NOOP | BUILD | S1 |
| B-17 | Mem0 `get_profile()` | BUILD | S11 |
| B-18 | Mem0 26% accuracy boost | BUILD (via S1 consolidation) | S1 |
| B-19 | Khoj Scheduled Automations | BUILD | S6 |
| B-20 | Khoj Obsidian Plugin | BUILD (as indexer) | S11 |
| B-21 | Khoj `/research` Deep Research | BUILD | S12 |
| B-22 | Aider auto-lint/test | ALREADY DONE | -- |
| B-23 | Aider Output Feedback Loop | BUILD | S2 |
| B-24 | ZeroClaw Performance | MONITOR (Eidolon already lean via Bun) | -- |
| B-25 | ZeroClaw 22+ AI Providers | REJECT (Claude-only by design) | -- |
| C-26 | Memory Compression Strategies | BUILD | S1 |
| C-27 | Approval Escalation | BUILD | S5 |
| C-28 | Session Branching | REJECT (same as A-6) | -- |
| C-29 | Structured Output | BUILD (same as A-5) | S3 |
| C-30 | Daily Digest Customizable | BUILD (same as A-9) | S4 |
| C-31 | Output Feedback Loop | BUILD (same as B-23) | S2 |
| C-32 | Webhook Ingestion | BUILD | S7 |
| C-33 | Scheduled Automations | BUILD (same as B-19) | S6 |
| C-34 | Multi-modal Input | BUILD | S12 |
| D-35 | MCP Server Templates | BUILD | S8 |
| D-36 | MCP Server Health Monitoring | BUILD | S8 |
| D-37 | MCP Marketplace Integration | BUILD (as template catalog) | S8 |
| E-38 | Dependency Auditing | BUILD (CI step) | S10 |
| E-39 | Skill/Plugin Sandboxing | DEFER (no marketplace = no risk) | -- |
| C-40 | Rate Limit Visualization | BUILD | S10 |
| F-41 | SDK/API for Extensions | DEFER to v2.0 (MCP covers this) | -- |
| F-42 | Documentation Site | DEFER to v1.1 (post-release polish) | -- |
| F-43 | Contributing Guide | DEFER to v1.1 (needs community first) | -- |

**Summary: 24 BUILD, 7 REJECT, 4 ALREADY DONE, 8 DEFER**

---

## Appendix B: Post-v1.0 Roadmap Additions

Features deferred from this plan that should be added to the v1.1/v1.2 roadmap:

| Feature | Version | Rationale |
|---|---|---|
| WhatsApp Business API Channel | v1.1 | Most popular messenger, requires Business API account |
| Email Channel (IMAP/SMTP) | v1.2 | Complex (threading, HTML, attachments) |
| Canvas / Visual Output | v1.2 | Requires significant client-side work |
| Multi-user Support | v1.2 | Requires memory store partitioning, auth system |
| Documentation Site | v1.1 | Post-release, when community exists |
| Contributing Guide | v1.1 | Same as docs site |
| SDK for Extensions | v2.0 | After plugin architecture stabilizes |
| Skill/Plugin Sandboxing | v2.0 | Only needed with marketplace |

---

## Appendix C: Database Migrations Required

### operational.db

**Sprint 2 -- Feedback table:**
```sql
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT,
  rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
  channel TEXT NOT NULL,
  comment TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_feedback_session ON feedback(session_id);
CREATE INDEX idx_feedback_created ON feedback(created_at);
```

**Sprint 5 -- Approval requests table:**
```sql
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('safe','needs_approval','dangerous')),
  description TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','timeout','escalated')),
  requested_at INTEGER NOT NULL,
  timeout_at INTEGER NOT NULL,
  responded_at INTEGER,
  responded_by TEXT,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  metadata TEXT DEFAULT '{}'
);
CREATE INDEX idx_approval_status ON approval_requests(status) WHERE status = 'pending';
CREATE INDEX idx_approval_timeout ON approval_requests(timeout_at) WHERE status = 'pending';
```

**Sprint 6 -- Automation tasks (extends existing scheduled_tasks):**
```sql
-- No new table needed; automations use the existing scheduled_tasks table
-- with action = 'automation' and payload containing the prompt and delivery config.
```

**Sprint 7 -- Webhook log (optional, for debugging):**
```sql
CREATE TABLE webhook_log (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processed','rejected','error')),
  error TEXT
);
CREATE INDEX idx_webhook_received ON webhook_log(received_at);
```

### memory.db

No new tables needed. Sprint 1 (consolidation) and Sprint 11 (profile, Obsidian) use existing
`memories`, `kg_entities`, and `kg_relations` tables.
