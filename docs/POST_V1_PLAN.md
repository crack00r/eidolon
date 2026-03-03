# Post-v1.0 Implementation Plan (v1.1 Release)

> **Status: Planning draft. Created 2026-03-03.**
> Based on codebase analysis of ~38,400 lines, 1,197 passing tests, and competitive findings from docs/INTEGRATION_PLAN.md.

---

## Table of Contents

1. [Prioritization Analysis](#1-prioritization-analysis)
2. [Feature 1: Calendar Integration](#2-feature-1-calendar-integration)
3. [Feature 2: Advanced Home Automation](#3-feature-2-advanced-home-automation)
4. [Feature 3: Web Dashboard Enhancement](#4-feature-3-web-dashboard-enhancement)
5. [Feature 4: Multi-GPU Worker Pool](#5-feature-4-multi-gpu-worker-pool)
6. [Deferred Features](#6-deferred-features)
7. [Dependency Graph](#7-dependency-graph)
8. [Effort Summary](#8-effort-summary)

---

## 1. Prioritization Analysis

### Candidate Evaluation

The v1.1 roadmap (from docs/ROADMAP.md) lists eight features. After analyzing the current codebase, three candidates are eliminated or deprioritized:

| Feature | Status | Rationale |
|---|---|---|
| **Discord channel** | ALREADY IMPLEMENTED | `packages/core/src/channels/discord/` exists (403+109 lines, tests, formatter). Not a v1.1 item. |
| **WhatsApp channel** | DEPRIORITIZED | Requires WhatsApp Business API account ($$$) or reverse-engineered Baileys (fragile). Low ROI given Telegram + Discord already cover messaging. Move to v1.2. |
| **Distributed tracing (OTel)** | DEPRIORITIZED | Nice for debugging but does not add user-facing value. Prometheus metrics are already implemented. Move to v1.2. |
| **Mobile widget** | DEPRIORITIZED | iOS-only, requires widget extension architecture. Low impact relative to effort. Move to v1.2. |

### Top 4 Features (Prioritized)

| Rank | Feature | User Impact | Effort | Dependencies | Rationale |
|---|---|---|---|---|---|
| **1** | Calendar Integration | HIGH | MEDIUM | scheduler, EventBus, notifications | Daily-use feature. Enables reminders, schedule awareness, proactive suggestions. Leverages existing TaskScheduler and AutomationEngine. |
| **2** | Advanced Home Automation | HIGH | MEDIUM | MCP passthrough, security policies, Channel | Builds on existing Phase 4.5 MCP passthrough. Adds scenes, proactive suggestions, voice control patterns. Extremely high daily-use value. |
| **3** | Web Dashboard Enhancement | MEDIUM | LOW-MEDIUM | gateway, existing apps/web | apps/web already has 5 routes and ~5,090 lines. Needs: approval workflow UI, automation management, health dashboard, real-time metrics. Most infrastructure already exists. |
| **4** | Multi-GPU Worker Pool | MEDIUM | HIGH | GPUManager refactor, config schema | Enables distributing TTS/STT across multiple GPUs. Current GPUManager is single-worker (230 lines, `config.url` based). Requires pool architecture. |

### What Already Exists (Extension Points)

These existing systems are the foundation for all four features:

| System | File | Lines | Extension Mechanism |
|---|---|---|---|
| EventBus | `core/src/loop/event-bus.ts` | 498 | `VALID_EVENT_TYPES` Set, `publish()`, `subscribe()` |
| TaskScheduler | `core/src/scheduler/scheduler.ts` | 350 | `create()`, `createFromNaturalLanguage()` |
| AutomationEngine | `core/src/scheduler/automation.ts` | 426 | Natural language schedule parsing |
| MessageRouter | `core/src/channels/router.ts` | 216 | `registerChannel()`, `sendNotification()` |
| GatewayServer | `core/src/gateway/server.ts` | 1001 | `registerHandler(method, handler)` for JSON-RPC |
| GPUManager | `core/src/gpu/manager.ts` | 230 | Single-worker, needs pool refactor |
| MCPHealthMonitor | `core/src/mcp/health.ts` | ~160 | Health checks for MCP servers |
| MCP Templates | `core/src/mcp/templates.ts` | 221 | Pre-configured MCP server definitions |
| Daemon | `core/src/daemon/index.ts` | 857 | Module wiring and initialization order |
| Protocol Types | `protocol/src/types/gateway.ts` | ~200 | GatewayMethod types (already has automation, feedback, approval, research) |
| Web Dashboard | `apps/web/` | ~5,090 | SvelteKit with 6 routes, 6 stores, WebSocket connection |

---

## 2. Feature 1: Calendar Integration

### Summary

Add bidirectional calendar synchronization (Google Calendar via API, CalDAV for self-hosted). Eidolon can read upcoming events, create reminders, proactively notify about conflicts, and inject schedule context into MEMORY.md for time-aware responses.

### Architecture

```
CalendarProvider (interface)
  |-- GoogleCalendarProvider (Google Calendar API v3)
  |-- CalDAVProvider (RFC 4791, supports Nextcloud/Radicale/iCloud)

CalendarManager
  |-- Sync engine (incremental sync via syncToken/ctag)
  |-- Event cache (operational.db calendar_events table)
  |-- Conflict detection

Integration Points:
  |-- EventBus: "calendar:event_upcoming", "calendar:event_created", "calendar:conflict_detected"
  |-- TaskScheduler: auto-create reminders for upcoming events
  |-- MemoryInjector: inject today's schedule into MEMORY.md
  |-- Gateway: RPC methods for calendar.list, calendar.create, calendar.upcoming
  |-- Notifications: proactive alerts via Telegram/Desktop
```

### Files to Create

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/protocol/src/types/calendar.ts` | CalendarEvent, CalendarProvider interface, CalendarSyncResult types | ~120 |
| `packages/core/src/calendar/index.ts` | Barrel exports | ~15 |
| `packages/core/src/calendar/manager.ts` | CalendarManager: sync, cache, conflict detection, schedule injection | ~400 |
| `packages/core/src/calendar/providers/google.ts` | Google Calendar API v3 provider (OAuth2 + service account) | ~350 |
| `packages/core/src/calendar/providers/caldav.ts` | CalDAV provider (RFC 4791 with XML parsing) | ~400 |
| `packages/core/src/calendar/__tests__/manager.test.ts` | Manager tests with mock providers | ~250 |
| `packages/core/src/calendar/__tests__/providers.test.ts` | Provider-specific tests | ~200 |

### Files to Modify

| File | Change | Impact |
|---|---|---|
| `packages/protocol/src/index.ts` | Export calendar types | 1 line |
| `packages/protocol/src/config.ts` | Add `CalendarConfigSchema` to `EidolonConfigSchema` | ~30 lines |
| `packages/protocol/src/types/events.ts` | Add `"calendar:event_upcoming"`, `"calendar:event_created"`, `"calendar:conflict_detected"` EventTypes | 3 lines |
| `packages/core/src/loop/event-bus.ts` | Add calendar event types to `VALID_EVENT_TYPES` | 3 lines |
| `packages/core/src/daemon/index.ts` | Initialize CalendarManager, wire to EventBus and scheduler | ~20 lines |
| `packages/core/src/memory/injector.ts` | Inject today's schedule into MEMORY.md | ~30 lines |
| `packages/core/src/gateway/server.ts` | Register `calendar.*` RPC handlers | ~40 lines |
| `packages/protocol/src/types/gateway.ts` | Add `"calendar.list"`, `"calendar.create"`, `"calendar.upcoming"` methods | 3 lines |

### Key Interfaces

```typescript
// packages/protocol/src/types/calendar.ts

export interface CalendarEvent {
  readonly id: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly startTime: number;       // Unix ms
  readonly endTime: number;
  readonly allDay: boolean;
  readonly recurrence?: string;     // RRULE
  readonly reminders: number[];     // minutes before
  readonly source: "google" | "caldav" | "manual";
  readonly syncedAt: number;
}

export interface CalendarProvider {
  readonly id: string;
  readonly name: string;
  connect(): Promise<Result<void, EidolonError>>;
  disconnect(): Promise<void>;
  listEvents(start: number, end: number): Promise<Result<CalendarEvent[], EidolonError>>;
  createEvent(event: Omit<CalendarEvent, "id" | "syncedAt">): Promise<Result<CalendarEvent, EidolonError>>;
  deleteEvent(eventId: string): Promise<Result<void, EidolonError>>;
  sync(since?: string): Promise<Result<CalendarSyncResult, EidolonError>>;
}

export interface CalendarSyncResult {
  readonly added: number;
  readonly updated: number;
  readonly deleted: number;
  readonly syncToken: string;
}
```

### Config Schema Addition

```typescript
// Added to packages/protocol/src/config.ts
export const CalendarConfigSchema = z.object({
  enabled: z.boolean().default(false),
  providers: z.array(z.object({
    type: z.enum(["google", "caldav"]),
    name: z.string(),
    config: z.record(z.string(), z.unknown()),
    syncIntervalMinutes: z.number().int().positive().default(15),
  })).default([]),
  reminders: z.object({
    defaultMinutesBefore: z.array(z.number().int().positive()).default([15, 60]),
    notifyVia: z.array(z.string()).default(["telegram"]),
  }),
  injection: z.object({
    enabled: z.boolean().default(true),
    daysAhead: z.number().int().positive().default(1),
  }),
});
```

### Database Schema

```sql
-- Added to operational.db migrations
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('google', 'caldav', 'manual')),
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  recurrence TEXT,
  reminders TEXT NOT NULL DEFAULT '[]',  -- JSON array of minutes
  raw_data TEXT,                          -- Original provider data for sync
  sync_token TEXT,
  synced_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_calendar_events_time ON calendar_events(start_time, end_time);
CREATE INDEX idx_calendar_events_provider ON calendar_events(provider);
```

### Implementation Steps

1. Define protocol types (`calendar.ts`) and config schema additions
2. Create `CalendarManager` with in-memory event cache and DB persistence
3. Implement Google Calendar provider (OAuth2 flow via existing secret store)
4. Implement CalDAV provider (XML request/response, RFC 4791 REPORT method)
5. Wire into daemon: EventBus calendar events, scheduler reminders
6. Add MEMORY.md injection (today's schedule as structured context)
7. Register gateway RPC handlers for calendar operations
8. Write tests with mock providers

### Dependencies

- `googleapis` or direct HTTP (for Google Calendar API v3)
- `fast-xml-parser` or similar (for CalDAV XML parsing)
- No new protocol dependencies -- uses existing Result pattern, EventBus, Zod validation

### Estimated Complexity: MEDIUM (~1,735 new lines + ~130 lines modified)

---

## 3. Feature 2: Advanced Home Automation

### Summary

Extend the existing basic MCP passthrough (Phase 4.5) with automation scenes, proactive state monitoring, voice control patterns, and a semantic entity resolution layer that maps natural language to HA entity IDs without requiring the LLM to know exact entity names.

### Architecture

```
Current (Phase 4.5): User -> Claude Code -> MCP -> Home Assistant (passthrough)

Enhanced (v1.1):
  HAManager (new)
    |-- Entity cache: sync HA entity registry, cache in operational.db
    |-- Semantic resolver: "Wohnzimmer Licht" -> light.living_room (embedding-based)
    |-- Scene engine: named groups of actions ("Movie time" -> dim lights, TV on)
    |-- State monitor: subscribe to HA state changes, detect anomalies
    |-- Proactive suggestions: "Kitchen light left on for 3 hours"

  Integration:
    |-- EventBus: "ha:state_changed", "ha:anomaly_detected", "ha:scene_executed"
    |-- AutomationEngine: "every day at sunset, run Movie Time scene"
    |-- Security policies: granular per-domain (lights=safe, locks=approval, alarm=dangerous)
    |-- Memory: HA state awareness in MEMORY.md context
```

### Files to Create

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/protocol/src/types/home-automation.ts` | HAEntity, HAScene, HAStateChange types | ~100 |
| `packages/core/src/home-automation/index.ts` | Barrel exports | ~15 |
| `packages/core/src/home-automation/manager.ts` | HAManager: entity cache, state monitoring, proactive alerts | ~450 |
| `packages/core/src/home-automation/resolver.ts` | Semantic entity resolver (embedding similarity for natural language -> entity_id) | ~250 |
| `packages/core/src/home-automation/scenes.ts` | Scene engine: define, execute, and schedule named action groups | ~200 |
| `packages/core/src/home-automation/policies.ts` | Per-domain security policies with entity type classification | ~150 |
| `packages/core/src/home-automation/__tests__/manager.test.ts` | Manager tests | ~200 |
| `packages/core/src/home-automation/__tests__/resolver.test.ts` | Resolver tests with mock embeddings | ~150 |
| `packages/core/src/home-automation/__tests__/scenes.test.ts` | Scene execution tests | ~120 |

### Files to Modify

| File | Change | Impact |
|---|---|---|
| `packages/protocol/src/index.ts` | Export HA types | 1 line |
| `packages/protocol/src/config.ts` | Add `HomeAutomationConfigSchema` | ~35 lines |
| `packages/protocol/src/types/events.ts` | Add `"ha:state_changed"`, `"ha:anomaly_detected"`, `"ha:scene_executed"` | 3 lines |
| `packages/core/src/loop/event-bus.ts` | Add HA event types to `VALID_EVENT_TYPES` | 3 lines |
| `packages/core/src/daemon/index.ts` | Initialize HAManager, wire state monitor to EventBus | ~25 lines |
| `packages/core/src/memory/injector.ts` | Inject HA state summary (which lights are on, temperature, etc.) | ~25 lines |
| `packages/core/src/gateway/server.ts` | Register `ha.*` RPC handlers (ha.entities, ha.scenes, ha.execute) | ~35 lines |
| `packages/protocol/src/types/gateway.ts` | Add `"ha.entities"`, `"ha.scenes"`, `"ha.execute"`, `"ha.state"` methods | 4 lines |
| `packages/core/src/mcp/templates.ts` | Enhance home-assistant template with scene support metadata | ~10 lines |

### Key Interfaces

```typescript
// packages/protocol/src/types/home-automation.ts

export interface HAEntity {
  readonly entityId: string;          // "light.living_room"
  readonly domain: string;            // "light", "switch", "sensor", "lock", "climate"
  readonly friendlyName: string;      // "Wohnzimmer Licht"
  readonly state: string;             // "on", "off", "22.5"
  readonly attributes: Record<string, unknown>;
  readonly lastChanged: number;
}

export type HASecurityLevel = "safe" | "needs_approval" | "dangerous";

export interface HADomainPolicy {
  readonly domain: string;
  readonly level: HASecurityLevel;
  readonly exceptions?: Record<string, HASecurityLevel>;  // entity_id overrides
}

export interface HAScene {
  readonly id: string;
  readonly name: string;               // "Movie Time"
  readonly actions: HASceneAction[];
  readonly createdAt: number;
}

export interface HASceneAction {
  readonly entityId: string;
  readonly domain: string;
  readonly service: string;            // "turn_on", "turn_off", "set_temperature"
  readonly data?: Record<string, unknown>;
}

export interface HAStateChange {
  readonly entityId: string;
  readonly oldState: string;
  readonly newState: string;
  readonly timestamp: number;
}
```

### Config Schema Addition

```typescript
export const HomeAutomationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  haUrl: z.string().optional(),                     // Home Assistant URL
  syncIntervalMinutes: z.number().int().positive().default(5),
  domainPolicies: z.array(z.object({
    domain: z.string(),
    level: z.enum(["safe", "needs_approval", "dangerous"]),
  })).default([
    { domain: "light", level: "safe" },
    { domain: "switch", level: "safe" },
    { domain: "sensor", level: "safe" },
    { domain: "climate", level: "needs_approval" },
    { domain: "lock", level: "needs_approval" },
    { domain: "alarm_control_panel", level: "dangerous" },
    { domain: "cover", level: "safe" },
    { domain: "media_player", level: "safe" },
  ]),
  anomalyDetection: z.object({
    enabled: z.boolean().default(true),
    rules: z.array(z.object({
      entityPattern: z.string(),          // glob: "light.*"
      condition: z.string(),              // "on_for_hours > 3"
      message: z.string(),               // "{{ friendly_name }} has been on for {{ hours }} hours"
    })).default([]),
  }),
  scenes: z.array(z.object({
    name: z.string(),
    actions: z.array(z.object({
      entityId: z.string(),
      service: z.string(),
      data: z.record(z.string(), z.unknown()).optional(),
    })),
  })).default([]),
});
```

### Database Schema

```sql
-- Added to operational.db migrations
CREATE TABLE ha_entities (
  entity_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  friendly_name TEXT NOT NULL,
  state TEXT NOT NULL,
  attributes TEXT NOT NULL DEFAULT '{}',
  last_changed INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);

CREATE TABLE ha_scenes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  actions TEXT NOT NULL,              -- JSON array of HASceneAction
  created_at INTEGER NOT NULL,
  last_executed_at INTEGER
);

CREATE INDEX idx_ha_entities_domain ON ha_entities(domain);
```

### Implementation Steps

1. Define protocol types and config schema
2. Build HAManager with entity sync from Home Assistant REST API
3. Implement semantic entity resolver using existing EmbeddingModel
4. Build scene engine (CRUD + execution via MCP passthrough)
5. Add state change monitoring (polling HA `/api/states` endpoint)
6. Implement anomaly detection rules (entity on too long, unexpected state changes)
7. Wire into daemon, EventBus, and MEMORY.md injection
8. Register gateway RPC handlers
9. Write tests

### Dependencies

- Home Assistant REST API (already accessible via existing MCP configuration)
- Existing EmbeddingModel for semantic entity resolution
- No new npm dependencies needed

### Estimated Complexity: MEDIUM (~1,335 new lines + ~140 lines modified)

---

## 4. Feature 3: Web Dashboard Enhancement

### Summary

The web dashboard (`apps/web/`) already has 5 routes (dashboard, chat, memory, learning, settings) with ~5,090 lines of code. For v1.1, enhance it to feature parity with the desktop app by adding: approval workflow UI, automation management, health/metrics dashboard, calendar view, and real-time event stream. This is primarily a frontend effort with minor gateway additions.

### Current State

| Route | Lines | Functionality |
|---|---|---|
| `dashboard/+page.svelte` | 641 | Brain state, energy bar, active tasks, memory count, client list, activity feed |
| `chat/+page.svelte` | 316 | Text messaging with streaming responses |
| `memory/+page.svelte` | 586 | Search, browse, type filtering, knowledge graph |
| `learning/+page.svelte` | 351 | Discovery list, approve/reject actions |
| `settings/+page.svelte` | 699 | Config display, log level, DND, energy budget |
| `+layout.svelte` | ~100 | Navigation, WebSocket connection, theme |

### Files to Create

| File | Purpose | Est. Lines |
|---|---|---|
| `apps/web/src/routes/approvals/+page.svelte` | Approval workflow: pending requests, approve/deny, history | ~400 |
| `apps/web/src/routes/automations/+page.svelte` | Automation management: create, list, enable/disable, execution history | ~450 |
| `apps/web/src/routes/health/+page.svelte` | Health dashboard: circuit breakers, metrics charts, rate limits, GPU status | ~500 |
| `apps/web/src/routes/calendar/+page.svelte` | Calendar view: upcoming events, create reminders (requires Feature 1) | ~400 |
| `apps/web/src/lib/stores/approvals.ts` | Approval state management | ~80 |
| `apps/web/src/lib/stores/automations.ts` | Automation state management | ~80 |
| `apps/web/src/lib/stores/health.ts` | Health/metrics state management | ~80 |
| `apps/web/src/lib/stores/calendar.ts` | Calendar state management | ~60 |
| `apps/web/src/lib/components/MetricsChart.svelte` | Reusable time-series chart component (token usage, latency) | ~200 |
| `apps/web/src/lib/components/ApprovalCard.svelte` | Approval request card with action buttons | ~120 |
| `apps/web/src/lib/components/EventStream.svelte` | Real-time event stream panel (EventBus events) | ~150 |

### Files to Modify

| File | Change | Impact |
|---|---|---|
| `apps/web/src/routes/+layout.svelte` | Add navigation links for 4 new routes | ~15 lines |
| `apps/web/src/routes/dashboard/+page.svelte` | Add approval badge, automation count, health indicator summary cards | ~40 lines |
| `apps/web/src/lib/stores/connection.ts` | Subscribe to new push event types (approval, automation, health) | ~20 lines |
| `packages/core/src/gateway/server.ts` | Register RPC handlers for approval.list, approval.respond, automation.list, health.detailed | ~60 lines |
| `packages/protocol/src/types/gateway.ts` | Add new GatewayMethod entries if not already present | ~5 lines |

### Key Components

**Approval Workflow Page (`approvals/+page.svelte`):**
- Lists pending approval requests (from learning, HA, code changes)
- Each card shows: action description, risk level, requester, timeout countdown
- Approve/Deny buttons with confirmation dialog
- History tab showing past decisions
- Uses existing `approval:requested` EventBus events

**Automation Management Page (`automations/+page.svelte`):**
- Create automations from natural language (delegates to AutomationEngine)
- List all automations with enable/disable toggles
- Execution history per automation
- Cron expression visualization
- Uses existing AutomationEngine and TaskScheduler

**Health Dashboard Page (`health/+page.svelte`):**
- Circuit breaker status cards (Claude, GPU, Telegram) with state colors
- Token usage time-series chart (hourly/daily/weekly)
- Rate limit utilization bars per account
- GPU worker health (VRAM, temperature, utilization)
- Event queue depth and processing latency
- Uses existing Prometheus metrics and health check endpoints

**Calendar View Page (`calendar/+page.svelte`):**
- Depends on Feature 1 (Calendar Integration)
- Week/day view of upcoming events
- Quick-create reminder from the UI
- Conflict detection highlights

### Implementation Steps

1. Create store files for new data types (approvals, automations, health, calendar)
2. Build reusable components (MetricsChart, ApprovalCard, EventStream)
3. Implement approval workflow page
4. Implement automation management page
5. Implement health dashboard page
6. Update layout navigation and dashboard summary cards
7. Add gateway RPC handlers for any missing methods
8. Calendar page (after Feature 1 is complete)

### Dependencies

- Feature 1 (Calendar Integration) for the calendar route
- Possibly a lightweight charting library for MetricsChart (e.g., `chart.js` or `layercake`)
- All other pages use existing gateway RPC methods

### Estimated Complexity: LOW-MEDIUM (~2,585 new lines + ~140 lines modified)

---

## 5. Feature 4: Multi-GPU Worker Pool

### Summary

Refactor the current single-worker GPUManager (230 lines, `config.url` based) into a worker pool that can distribute TTS/STT requests across multiple GPU workers. Includes load balancing, health-based routing, capability matching, and automatic failover.

### Current State

The existing `GPUManager` (`packages/core/src/gpu/manager.ts`, 230 lines) is designed for a single GPU worker:
- `GpuWorkerConfig` has a single `url` field
- Health checking is one-worker
- No load balancing or failover between workers
- `tts()` and `stt()` methods target the single worker

The config schema (`packages/protocol/src/config.ts`) already defines `GpuConfigSchema` with a `workers` array, but the implementation does not use it.

### Architecture

```
Current:
  GPUManager -> single worker URL -> GPU Worker

Enhanced:
  GPUWorkerPool (replaces GPUManager)
    |-- Worker registry: multiple workers with capabilities
    |-- Health monitor: periodic health checks per worker
    |-- Load balancer: route requests by capability + load + latency
    |-- Failover: automatic retry on next worker if primary fails
    |-- Circuit breaker: per-worker circuit breaker (reuses existing CircuitBreaker)

  Request Flow:
    tts("Hello") -> pool.selectWorker("tts") -> route to least-loaded capable worker
    If worker fails -> circuit breaker trips -> retry on next worker
    If all workers down -> fallback chain (Kitten TTS -> System TTS -> text)
```

### Files to Create

| File | Purpose | Est. Lines |
|---|---|---|
| `packages/core/src/gpu/pool.ts` | GPUWorkerPool: multi-worker management, load balancing, failover | ~450 |
| `packages/core/src/gpu/worker.ts` | GPUWorker: single worker abstraction with health state and circuit breaker | ~250 |
| `packages/core/src/gpu/balancer.ts` | Load balancing strategies: round-robin, least-connections, latency-weighted | ~200 |
| `packages/core/src/gpu/__tests__/pool.test.ts` | Pool tests with multiple mock workers | ~300 |
| `packages/core/src/gpu/__tests__/balancer.test.ts` | Balancer strategy tests | ~150 |

### Files to Modify

| File | Change | Impact |
|---|---|---|
| `packages/core/src/gpu/manager.ts` | Refactor to delegate to GPUWorkerPool (keep as facade for backward compat) | ~80 lines changed |
| `packages/core/src/gpu/index.ts` | Export new pool and worker types | ~5 lines |
| `packages/protocol/src/config.ts` | Enhance `GpuConfigSchema` with load balancing and per-worker options | ~20 lines |
| `packages/core/src/daemon/index.ts` | Wire GPUWorkerPool instead of single GPUManager | ~15 lines |
| `packages/core/src/gateway/server.ts` | Enhance `gpu.*` RPC methods to show pool status | ~20 lines |
| `packages/protocol/src/types/gateway.ts` | Add `"gpu.workers"`, `"gpu.pool_status"` methods | 2 lines |

### Key Interfaces

```typescript
// packages/core/src/gpu/worker.ts

export interface GPUWorkerInfo {
  readonly name: string;
  readonly url: string;
  readonly capabilities: readonly ("tts" | "stt" | "realtime")[];
  readonly health: GpuHealth | null;
  readonly circuitState: CircuitState;
  readonly activeRequests: number;
  readonly avgLatencyMs: number;
  readonly lastHealthCheck: number;
}

// packages/core/src/gpu/pool.ts

export interface GPUWorkerPoolConfig {
  readonly workers: readonly GpuWorkerConfig[];
  readonly healthCheckIntervalMs: number;
  readonly loadBalancing: "round-robin" | "least-connections" | "latency-weighted";
  readonly maxRetries: number;
}

export class GPUWorkerPool {
  constructor(config: GPUWorkerPoolConfig, logger: Logger);

  /** Select the best available worker for a capability. */
  selectWorker(capability: "tts" | "stt" | "realtime"): Result<GPUWorkerInfo, EidolonError>;

  /** Execute TTS with automatic failover. */
  tts(text: string, options?: TtsOptions): Promise<Result<Uint8Array, EidolonError>>;

  /** Execute STT with automatic failover. */
  stt(audio: Uint8Array, options?: SttOptions): Promise<Result<string, EidolonError>>;

  /** Get status of all workers. */
  getPoolStatus(): GPUWorkerInfo[];

  /** Start health monitoring. */
  startHealthChecks(): void;

  /** Stop health monitoring and clean up. */
  dispose(): void;
}

// packages/core/src/gpu/balancer.ts

export interface LoadBalancerStrategy {
  select(workers: readonly GPUWorkerInfo[], capability: string): GPUWorkerInfo | null;
}

export class RoundRobinBalancer implements LoadBalancerStrategy { /* ... */ }
export class LeastConnectionsBalancer implements LoadBalancerStrategy { /* ... */ }
export class LatencyWeightedBalancer implements LoadBalancerStrategy { /* ... */ }
```

### Config Schema Enhancement

```typescript
// Enhanced GpuConfigSchema workers array (already defined but not fully used)
const GpuWorkerSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int().positive().default(8420),
  token: SecretRefSchema.or(z.string()),
  capabilities: z.array(z.enum(["tts", "stt", "realtime"])).default(["tts", "stt"]),
  priority: z.number().int().min(1).max(100).default(50),   // NEW
  maxConcurrent: z.number().int().positive().default(4),      // NEW
});

// Add to GpuConfigSchema
const GpuPoolSchema = z.object({
  loadBalancing: z.enum(["round-robin", "least-connections", "latency-weighted"]).default("least-connections"),
  healthCheckIntervalMs: z.number().int().positive().default(30_000),
  maxRetriesPerRequest: z.number().int().min(0).max(5).default(2),
});
```

### Implementation Steps

1. Create `GPUWorker` class (single worker abstraction with CircuitBreaker)
2. Create load balancer strategies (round-robin, least-connections, latency-weighted)
3. Create `GPUWorkerPool` (multi-worker orchestration, health monitoring)
4. Refactor `GPUManager` to use pool internally (backward compatible facade)
5. Enhance config schema with per-worker and pool options
6. Update daemon wiring to construct pool from config
7. Add pool status to gateway RPC
8. Write tests with multiple mock workers and failure scenarios

### Dependencies

- Existing `CircuitBreaker` from `packages/core/src/health/circuit-breaker.ts`
- Existing `GpuWorkerConfig` from protocol
- No new npm dependencies

### Estimated Complexity: HIGH (~1,350 new lines + ~142 lines modified)

---

## 6. Deferred Features

These features are explicitly deferred from v1.1:

### v1.2 (Next Cycle)

| Feature | Rationale for Deferral |
|---|---|
| **WhatsApp channel** | Requires WhatsApp Business API account or fragile Baileys reverse-engineering. Low incremental value over Telegram + Discord. |
| **Multi-user** | Architectural change (per-user memory isolation, auth). Too large for v1.1. |
| **Email channel** | IMAP/SMTP integration is well-understood but low daily-use value compared to calendar/HA. |
| **Distributed tracing (OTel)** | Developer tooling, not user-facing. Prometheus metrics already provide operational visibility. |
| **Mobile widget** | iOS-only, requires WidgetKit extension. Low impact relative to effort. |

### v2.0 (Major Release)

| Feature | Rationale for Deferral |
|---|---|
| **Plugin system** | Requires fundamental architecture change (dynamic module loading, API stability guarantees). |
| **Local LLM support** | Requires IClaudeProcess abstraction extension to support non-Claude backends (Ollama, llama.cpp). |
| **Secondary node replication** | Distributed systems complexity (conflict resolution, eventual consistency). |

---

## 7. Dependency Graph

```
Feature 1: Calendar Integration
  |-- No dependencies on other v1.1 features
  |-- Enables: Feature 3 (calendar route in web dashboard)

Feature 2: Advanced Home Automation
  |-- No dependencies on other v1.1 features
  |-- Optional: Feature 3 (HA dashboard in web)

Feature 3: Web Dashboard Enhancement
  |-- Partial dependency on Feature 1 (calendar route)
  |-- Partial dependency on Feature 2 (HA dashboard)
  |-- Core pages (approvals, automations, health) are independent

Feature 4: Multi-GPU Worker Pool
  |-- No dependencies on other v1.1 features
  |-- Independent of Features 1-3
```

### Recommended Implementation Order

```
Sprint 1 (Weeks 1-2):  Feature 1 (Calendar) + Feature 4 (Multi-GPU) in parallel
Sprint 2 (Weeks 3-4):  Feature 2 (Advanced HA) + Feature 3 core pages (approvals, automations, health)
Sprint 3 (Week 5):     Feature 3 remaining pages (calendar route) + integration testing + polish
```

Features 1 and 4 have zero dependencies on each other and can be developed in parallel. Feature 2 is also independent but benefits from being slightly later (so calendar and GPU pool are stable). Feature 3 (web dashboard) should come last because it depends on the APIs from Features 1, 2, and 4 being stable.

---

## 8. Effort Summary

### New Source Files

| Feature | New Files | New Lines (est.) |
|---|---|---|
| Calendar Integration | 7 source + 2 test | ~1,735 |
| Advanced Home Automation | 6 source + 3 test | ~1,335 |
| Web Dashboard Enhancement | 11 source (Svelte + stores) | ~2,585 |
| Multi-GPU Worker Pool | 3 source + 2 test | ~1,350 |
| **Total** | **34 files** | **~7,005 lines** |

### Modified Files

| Feature | Files Modified | Lines Changed (est.) |
|---|---|---|
| Calendar Integration | 8 | ~130 |
| Advanced Home Automation | 9 | ~140 |
| Web Dashboard Enhancement | 5 | ~140 |
| Multi-GPU Worker Pool | 6 | ~142 |
| **Total** | **28 modifications** | **~552 lines** |

### Test Coverage

| Feature | Test Files | Test Lines (est.) |
|---|---|---|
| Calendar Integration | 2 | ~450 |
| Advanced Home Automation | 3 | ~470 |
| Web Dashboard Enhancement | 0 (Svelte components, manual testing) | 0 |
| Multi-GPU Worker Pool | 2 | ~450 |
| **Total** | **7 test files** | **~1,370 lines** |

### Grand Total

- **34 new source files** (~7,005 lines)
- **7 new test files** (~1,370 lines)
- **28 file modifications** (~552 lines changed)
- **Estimated total effort: 5 weeks** (2 developers working in parallel on Sprint 1)

### Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Google Calendar OAuth complexity | Medium | Medium | Start with CalDAV (simpler). Google OAuth can use existing secret store patterns. |
| HA REST API rate limits | Low | Low | Cache entity state locally, poll at configurable intervals (default 5 min). |
| Multi-GPU latency variance | Medium | Medium | Latency-weighted balancer adapts automatically. Circuit breakers prevent routing to degraded workers. |
| Web dashboard charting library choice | Low | Low | Start with simple CSS-based bars. Add chart.js only if time-series visualization is essential. |
| Config schema backward compatibility | Medium | High | All new config sections use `.default()` values. Existing configs remain valid without changes. |
