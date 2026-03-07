# Proactive Intelligence

> **Status: Planned.** This document describes the design for proactive intelligence in Eidolon.
> Eidolon learns from user patterns and anticipates needs before the user asks.

## The Problem

Current Eidolon is purely reactive: the user asks, Eidolon responds. Calendar reminders
fire at fixed offsets (15/60 minutes). Scheduled automations run on cron. Nothing adapts
to individual behavior. This wastes the rich data Eidolon already collects across memory,
calendar, KG relationships, and user profile.

## Examples of Proactive Behavior

| Scenario | Trigger | Action |
|---|---|---|
| Travel prep | Calendar event "Munich trip" tomorrow + location context | Weather forecast + train connections for Munich |
| Meeting prep | Calendar event with attendee X in 30 min | Notes from last conversation with X |
| Health nudge | No "training" memory today + user preference for daily exercise | Suggest workout reminder at 18:00 |
| Commute alert | Recurring weekday pattern + time of day | Traffic/transit update before departure |
| Follow-up | Promise made ("I'll send you that article") + 48h elapsed | Reminder to follow up |
| Birthday | KG relation "friend:birthday" approaching | Suggest sending wishes |

## Architecture Overview

```
                    ┌──────────────────────────┐
                    │     Anticipation Engine   │
                    │                           │
   ┌────────────┐   │  ┌──────────┐            │   ┌──────────────┐
   │  Calendar   │──>│  │ Pattern  │            │──>│  EventBus     │
   │  Manager    │   │  │ Detector │            │   │              │
   └────────────┘   │  └────┬─────┘            │   │ anticipation: │
                    │       │                   │   │ suggestion    │
   ┌────────────┐   │  ┌────▼─────┐            │   └──────┬───────┘
   │  Memory     │──>│  │ Context  │            │          │
   │  Search     │   │  │ Enricher │            │          ▼
   └────────────┘   │  └────┬─────┘            │   ┌──────────────┐
                    │       │                   │   │  Cognitive    │
   ┌────────────┐   │  ┌────▼─────┐            │   │  Loop         │
   │  User       │──>│  │ Trigger  │            │   │  (PEAR)       │
   │  Profile     │   │  │ Evaluator│            │   └──────┬───────┘
   └────────────┘   │  └────┬─────┘            │          │
                    │       │                   │          ▼
   ┌────────────┐   │  ┌────▼─────┐            │   ┌──────────────┐
   │  KG Entity  │──>│  │ Action   │            │   │  Message      │
   │  Store      │   │  │ Composer │            │   │  Router       │
   └────────────┘   │  └──────────┘            │   └──────────────┘
                    └──────────────────────────┘
```

The Anticipation Engine is **not** a new loop. It runs as a scheduled check within the
existing Cognitive Loop, emitting `anticipation:suggestion` events that the loop evaluates
like any other event.

## Integration into the PEAR Cycle

The Anticipation Engine hooks into the existing scheduler mechanism. It does NOT modify the
Cognitive Loop itself. Instead:

1. **A recurring scheduled task** (`anticipation:check`) fires every 5 minutes (configurable).
2. The **Scheduler** emits a `scheduler:task_due` event with action `anticipation:check`.
3. The **event handler** in `event-handlers.ts` routes it to `handleAnticipationCheck()`.
4. The handler runs the Anticipation Engine pipeline (pattern detection, context enrichment,
   trigger evaluation, action composition).
5. If suggestions are produced, each is published as an `anticipation:suggestion` event.
6. On the next cycle, the loop picks up `anticipation:suggestion` events and the handler
   delivers them to the user via `MessageRouter.sendNotification()`.

This design keeps the Cognitive Loop untouched and leverages the existing scheduler, event
bus, energy budget, and DND enforcement.

```
Scheduler (every 5 min)
  │
  ▼
EventBus: scheduler:task_due { action: "anticipation:check" }
  │
  ▼
event-handlers.ts → handleAnticipationCheck()
  │
  ├── PatternDetector.detect() → matched patterns
  ├── ContextEnricher.enrich() → enriched context per pattern
  ├── TriggerEvaluator.evaluate() → which ones fire now?
  └── ActionComposer.compose() → notification text
  │
  ▼
EventBus: anticipation:suggestion { ... }  (one per suggestion)
  │
  ▼ (next PEAR cycle)
event-handlers.ts → handleAnticipationSuggestion()
  │
  ▼
MessageRouter.sendNotification()  (DND-aware)
```

## Pattern Detection Algorithm

### Data Sources

The Pattern Detector queries four data sources, all of which already exist:

| Source | Query | What it reveals |
|---|---|---|
| `CalendarManager.listEvents()` | Next 24-48h events | Upcoming meetings, travel, deadlines |
| `MemorySearch.search()` | Semantic search by entity/topic | Past interactions with attendees, related notes |
| `UserProfileGenerator.generateProfile()` | Cached profile | Preferences, routines, interests, decision patterns |
| `KGEntityStore` + `KGRelationStore` | Entity relationships | People, places, recurring associations |

### Pattern Types

Each pattern type is a self-contained detector class implementing `IPatternDetector`:

```typescript
interface IPatternDetector {
  readonly id: string;
  readonly name: string;
  detect(context: DetectionContext): Promise<DetectedPattern[]>;
}

interface DetectionContext {
  readonly now: number;
  readonly profile: UserProfile;
  readonly upcomingEvents: readonly CalendarEvent[];
  readonly recentMemories: readonly Memory[];
  readonly timezone: string;
}

interface DetectedPattern {
  readonly detectorId: string;
  readonly type: PatternType;
  readonly confidence: number;      // 0-1
  readonly relevantEntities: readonly string[];
  readonly calendarEventId?: string;
  readonly metadata: Record<string, unknown>;
}

type PatternType =
  | "meeting_prep"
  | "travel_prep"
  | "health_nudge"
  | "follow_up"
  | "birthday_reminder"
  | "routine_deviation"
  | "commute_alert";
```

#### Built-in Detectors (Phase 1)

**1. MeetingPrepDetector**
- Scans upcoming calendar events within a configurable window (default: 60 min).
- For each event with attendees: queries `MemorySearch` for past conversations with
  those people (using KG entity names as search terms).
- Confidence = 0.9 if attendee found in KG, 0.6 if only name match in memories.

**2. TravelPrepDetector**
- Scans calendar events for location keywords or events with a `location` field.
- Cross-references with user's home location from profile/preferences.
- If location differs from home city: emits travel_prep pattern.
- Confidence = 0.85 for explicit location, 0.5 for keyword inference.

**3. HealthNudgeDetector**
- Checks user profile for health/exercise preferences (memory type `preference`
  with tags like "health", "exercise", "training").
- Queries today's memories for exercise-related content.
- If preference exists but no activity today and time is past configurable threshold
  (default: 17:00): emits health_nudge.
- Confidence = 0.7.

**4. FollowUpDetector**
- Queries recent memories (type `decision` or `episode`) for commitment patterns:
  content containing "I will", "I'll send", "remind me", "follow up".
- Checks if the commitment has a corresponding resolution (search for related
  content within a time window).
- If unresolved after configurable delay (default: 48h): emits follow_up.
- Confidence = 0.75.

**5. BirthdayDetector**
- Queries KG relations for type `birthday` or `born_on`.
- Compares dates to current date (within 3-day window).
- Confidence = 0.95.

### Temporal Pattern Mining (Phase 2, future)

Phase 2 introduces statistical pattern detection from behavioral sequences stored in
the audit log and memory timestamps:

- **Recurring time patterns**: user checks weather every morning at 7:30 -> proactively
  provide weather at 7:25.
- **Sequential patterns**: after event X, user always does Y -> suggest Y after X.
- **Absence detection**: user normally does X on Tuesdays but hasn't today.

Implementation: sliding-window frequency analysis over audit log timestamps, grouped
by action type and day-of-week/hour. No ML required -- simple counting with
statistical significance thresholds.

## Context Enrichment

When a pattern is detected, the Context Enricher gathers supporting information to
make the proactive notification actually useful (not just "you have a meeting").

```typescript
interface EnrichedContext {
  readonly pattern: DetectedPattern;
  readonly relatedMemories: readonly MemorySearchResult[];
  readonly calendarContext: string;  // from buildScheduleContext()
  readonly externalData?: ExternalDataResult;
}

interface ExternalDataResult {
  readonly type: "weather" | "transit" | "news";
  readonly content: string;
  readonly fetchedAt: number;
}
```

**Enrichment sources by pattern type:**

| Pattern | Memory Query | External Data | Calendar Data |
|---|---|---|---|
| meeting_prep | Last 5 conversations with attendee | None | Event details |
| travel_prep | Previous visits to destination | Weather API (optional) | Travel event |
| health_nudge | Exercise preferences | None | Free time slots |
| follow_up | Original commitment memory | None | None |
| birthday_reminder | Relationship memories | None | None |

External data fetching (weather, transit) is behind circuit breakers and is optional.
The suggestion is still valuable without it. External data providers are injected as
an optional dependency; Phase 1 ships without them, Phase 2 adds weather via
Open-Meteo (free, no API key).

## Trigger Evaluation

Not every detected pattern should become a notification. The Trigger Evaluator applies
filters:

```typescript
interface TriggerEvaluator {
  evaluate(
    patterns: readonly DetectedPattern[],
    history: readonly SuggestionRecord[],
    config: AnticipationConfig,
  ): DetectedPattern[];
}
```

**Filter rules:**

1. **Confidence threshold**: pattern.confidence >= config.minConfidence (default: 0.6).
2. **Cooldown**: same pattern type + same entity not fired within config.cooldownMinutes
   (default: 240 min / 4 hours).
3. **Max suggestions per hour**: config.maxSuggestionsPerHour (default: 3). Prevents
   notification fatigue.
4. **User feedback**: if user dismissed/snoozed a specific pattern type 3+ times,
   reduce its confidence by 0.3 (learned suppression).
5. **Energy budget**: anticipation suggestions consume from the `tasks` budget category.
   If budget exhausted, defer to next window.
6. **DND**: enforced by MessageRouter.sendNotification() -- no special handling needed here.

## Action Composition

Patterns that pass trigger evaluation are composed into user-facing notifications.
This is the only step that may use an LLM call (optional, configurable).

```typescript
interface ActionComposer {
  compose(enrichedContext: EnrichedContext): Promise<ComposedSuggestion>;
}

interface ComposedSuggestion {
  readonly patternType: PatternType;
  readonly title: string;
  readonly body: string;
  readonly priority: NotificationPriority;
  readonly channelId: string;
  readonly actionable: boolean;  // has a suggested follow-up action
  readonly suggestedAction?: string;  // e.g., "Set reminder for 18:00"
}
```

**Two composition modes (configurable):**

1. **Template mode** (default, no LLM cost): pre-defined templates per pattern type,
   filled with data from EnrichedContext. Fast, predictable, zero tokens.
2. **LLM mode** (optional): sends enriched context to a fast model (Haiku) to generate
   a natural-sounding notification. Uses ~500 tokens per suggestion.

Template examples:

```
meeting_prep:
  title: "Meeting with {attendee} in {minutes} minutes"
  body: "Last discussed: {lastTopicSummary}\nKey points: {bulletPoints}"

travel_prep:
  title: "Trip to {destination} tomorrow"
  body: "Weather: {weather}\nTravel: {transitInfo}\nPacking note: {note}"

health_nudge:
  title: "Daily training reminder"
  body: "You haven't trained today. Want me to set a reminder for {suggestedTime}?"
```

## Data Model

### New Tables (in operational.db)

```sql
-- Tracks fired suggestions for cooldown and analytics
CREATE TABLE IF NOT EXISTS anticipation_history (
  id TEXT PRIMARY KEY,
  pattern_type TEXT NOT NULL,
  detector_id TEXT NOT NULL,
  entity_key TEXT,           -- dedupe key (e.g., "meeting:event-id" or "health:2026-03-07")
  confidence REAL NOT NULL,
  suggestion_title TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  dismissed_at INTEGER,      -- NULL if not dismissed
  acted_on_at INTEGER,       -- NULL if user didn't act on it
  feedback TEXT              -- "helpful" | "irrelevant" | "annoying" | NULL
);

CREATE INDEX idx_anticipation_pattern_type ON anticipation_history(pattern_type);
CREATE INDEX idx_anticipation_entity_key ON anticipation_history(entity_key);
CREATE INDEX idx_anticipation_fired_at ON anticipation_history(fired_at);

-- Learned suppression rules from repeated dismissals
CREATE TABLE IF NOT EXISTS anticipation_suppressions (
  id TEXT PRIMARY KEY,
  pattern_type TEXT NOT NULL,
  entity_key TEXT,           -- NULL means suppress pattern_type globally
  suppressed_at INTEGER NOT NULL,
  expires_at INTEGER,        -- NULL means permanent until user re-enables
  reason TEXT NOT NULL        -- "user_dismissed_3x" | "user_explicit" | "low_feedback"
);

CREATE INDEX idx_suppression_pattern ON anticipation_suppressions(pattern_type);
```

### New Event Types (in protocol/types/events.ts)

```typescript
// Add to EventType union:
| "anticipation:check"
| "anticipation:suggestion"
| "anticipation:dismissed"
| "anticipation:acted"

// Payloads:
interface AnticipationSuggestionPayload {
  readonly suggestionId: string;
  readonly patternType: PatternType;
  readonly title: string;
  readonly body: string;
  readonly channelId: string;
  readonly priority: NotificationPriority;
  readonly actionable: boolean;
  readonly suggestedAction?: string;
  readonly calendarEventId?: string;
  readonly entityKey: string;
  readonly confidence: number;
}

interface AnticipationFeedbackPayload {
  readonly suggestionId: string;
  readonly feedback: "helpful" | "irrelevant" | "annoying";
}
```

### Configuration Schema (in protocol/config.ts)

```typescript
export const AnticipationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  checkIntervalMinutes: z.number().int().positive().default(5),
  minConfidence: z.number().min(0).max(1).default(0.6),
  cooldownMinutes: z.number().int().positive().default(240),
  maxSuggestionsPerHour: z.number().int().positive().default(3),
  compositionMode: z.enum(["template", "llm"]).default("template"),
  channel: z.string().default("telegram"),
  detectors: z.object({
    meetingPrep: z.object({
      enabled: z.boolean().default(true),
      windowMinutes: z.number().int().positive().default(60),
    }),
    travelPrep: z.object({
      enabled: z.boolean().default(true),
      windowHours: z.number().int().positive().default(24),
      homeCity: z.string().default(""),
    }),
    healthNudge: z.object({
      enabled: z.boolean().default(false),
      afterHour: z.number().int().min(0).max(23).default(17),
      activityTags: z.array(z.string()).default(["training", "exercise", "workout", "gym"]),
    }),
    followUp: z.object({
      enabled: z.boolean().default(true),
      delayHours: z.number().int().positive().default(48),
    }),
    birthday: z.object({
      enabled: z.boolean().default(true),
      daysBefore: z.number().int().min(0).max(7).default(1),
    }),
  }).default({}),
});
```

Add to `EidolonConfigSchema`:

```typescript
anticipation: AnticipationConfigSchema.default({}),
```

## Files to Create

| File | Lines (est.) | Purpose |
|---|---|---|
| `packages/core/src/anticipation/engine.ts` | ~200 | AnticipationEngine: orchestrates the pipeline |
| `packages/core/src/anticipation/patterns.ts` | ~80 | IPatternDetector interface + PatternType |
| `packages/core/src/anticipation/detectors/meeting-prep.ts` | ~90 | MeetingPrepDetector |
| `packages/core/src/anticipation/detectors/travel-prep.ts` | ~80 | TravelPrepDetector |
| `packages/core/src/anticipation/detectors/health-nudge.ts` | ~70 | HealthNudgeDetector |
| `packages/core/src/anticipation/detectors/follow-up.ts` | ~90 | FollowUpDetector |
| `packages/core/src/anticipation/detectors/birthday.ts` | ~60 | BirthdayDetector |
| `packages/core/src/anticipation/detectors/index.ts` | ~20 | Barrel export |
| `packages/core/src/anticipation/enricher.ts` | ~120 | ContextEnricher: gathers supporting data |
| `packages/core/src/anticipation/trigger.ts` | ~100 | TriggerEvaluator: cooldown, throttle, suppress |
| `packages/core/src/anticipation/composer.ts` | ~120 | ActionComposer: template + optional LLM |
| `packages/core/src/anticipation/templates.ts` | ~80 | Notification templates per pattern type |
| `packages/core/src/anticipation/history.ts` | ~100 | SuggestionHistory: DB persistence for cooldown/analytics |
| `packages/core/src/anticipation/index.ts` | ~15 | Barrel export |

**Total new code: ~1,225 lines across 14 files.**

## Files to Modify

| File | Change |
|---|---|
| `packages/protocol/src/types/events.ts` | Add 4 new EventType values + payload interfaces |
| `packages/protocol/src/config.ts` | Add AnticipationConfigSchema + wire into EidolonConfigSchema |
| `packages/protocol/src/types/index.ts` | Re-export new anticipation types if needed |
| `packages/core/src/loop/priority.ts` | Add scoring rules for `anticipation:check` and `anticipation:suggestion` |
| `packages/core/src/daemon/event-handlers.ts` | Add case for `anticipation:check` and `anticipation:suggestion` |
| `packages/core/src/daemon/event-handlers-system.ts` | Add `handleAnticipationCheck()` and `handleAnticipationSuggestion()` (or new file `event-handlers-anticipation.ts`) |
| `packages/core/src/daemon/types.ts` | Add `anticipationEngine?: AnticipationEngine` to InitializedModules |
| `packages/core/src/daemon/init-services.ts` | Initialize AnticipationEngine + register scheduled task |
| `packages/core/src/daemon/shutdown.ts` | No change needed (engine has no persistent connections) |
| `packages/core/src/index.ts` | Export anticipation module |

**Total modifications: ~10 files, ~150 lines of changes.**

## Implementation Steps

### Step 1: Protocol Types (est. 30 min)

1. Add `PatternType` and `AnticipationSuggestionPayload` to protocol types.
2. Add 4 new EventType values to `events.ts`.
3. Add `AnticipationConfigSchema` to `config.ts` and wire into master config.
4. Run `pnpm -r typecheck` to verify.

### Step 2: History Store (est. 30 min)

1. Create `anticipation/history.ts` with `SuggestionHistory` class.
2. Create the `anticipation_history` and `anticipation_suppressions` tables in
   operational.db schema (in `database/schema.ts` or wherever schemas are defined).
3. Implement: `record()`, `getRecent()`, `checkCooldown()`, `recordFeedback()`,
   `getSuppressions()`.

### Step 3: Pattern Detectors (est. 1.5h)

1. Create `anticipation/patterns.ts` with `IPatternDetector` interface.
2. Implement each detector in its own file under `anticipation/detectors/`.
3. Each detector receives `DetectionContext` and returns `DetectedPattern[]`.
4. No LLM calls -- pure query + heuristic logic.

### Step 4: Context Enricher (est. 45 min)

1. Create `anticipation/enricher.ts`.
2. For each detected pattern, query MemorySearch for related memories.
3. For calendar patterns, include `buildScheduleContext()` output.
4. External data providers are a no-op interface in Phase 1.

### Step 5: Trigger Evaluator (est. 30 min)

1. Create `anticipation/trigger.ts`.
2. Apply confidence threshold, cooldown, rate limit, and suppression checks.
3. Uses SuggestionHistory for cooldown lookups.

### Step 6: Action Composer + Templates (est. 45 min)

1. Create `anticipation/templates.ts` with per-pattern-type template strings.
2. Create `anticipation/composer.ts` with template interpolation.
3. Optional LLM path: call ILLMProvider with a summary prompt (gated by config).

### Step 7: Anticipation Engine (est. 30 min)

1. Create `anticipation/engine.ts` orchestrating the full pipeline.
2. Constructor takes: MemorySearch, CalendarManager, UserProfileGenerator,
   KGEntityStore, SuggestionHistory, EventBus, config, Logger.
3. Single method: `check(): Promise<ComposedSuggestion[]>`.

### Step 8: Daemon Integration (est. 45 min)

1. Add scoring rules to `priority.ts` for the new event types.
2. Add event handler routing in `event-handlers.ts`.
3. Create `event-handlers-anticipation.ts` with the two handlers.
4. Initialize AnticipationEngine in `init-services.ts`.
5. Register the `anticipation:check` recurring scheduled task.
6. Add to `InitializedModules`.

### Step 9: Tests (est. 2h)

See Test Plan below.

### Step 10: Documentation (est. 15 min)

1. Update ROADMAP.md with the new feature.
2. Update CONFIGURATION.md with the new config section.

## Notification Routing

Proactive notifications use the existing `MessageRouter.sendNotification()` path, which
already handles:

- **DND enforcement**: non-critical notifications are suppressed during quiet hours.
- **Channel routing**: delivers to the configured channel (default: Telegram).
- **Voice synthesis**: if channel supports voice and TTS is configured, audio is
  synthesized via `routeOutboundWithVoice()`.

Anticipation suggestions use priority `"normal"` by default. Meeting prep within 15 min
uses `"high"`. This means:

- During DND: suggestions are silently dropped (logged to history as suppressed).
- During active hours: delivered immediately to the configured channel.
- If user is in conversation: the suggestion queues behind the user message (score 50 vs 95).

The user can respond to actionable suggestions (e.g., "Yes, set the reminder") which
routes through the normal `user:message` path. The LLM context includes the suggestion
via MEMORY.md injection.

## Feedback Loop

User feedback improves future suggestions:

1. **Implicit**: if user acts on a suggestion (clicks, responds), record `acted_on_at`.
2. **Explicit**: user can react with "not helpful" -> records feedback as "irrelevant"
   or "annoying".
3. **Suppression**: 3+ "annoying" feedbacks for the same pattern_type within 30 days ->
   auto-suppress that pattern type with a 30-day expiry.
4. **Re-enable**: user can explicitly re-enable via command: "Eidolon, start suggesting
   meeting prep again".

Feedback data feeds into the Trigger Evaluator's confidence adjustment.

## Energy Budget Impact

| Operation | Token Cost | Budget Category |
|---|---|---|
| anticipation:check (all detectors) | 0 tokens (pure SQL/heuristics) | tasks |
| Context enrichment | 0 tokens (memory queries) | tasks |
| Template composition | 0 tokens | tasks |
| LLM composition (optional) | ~500 tokens per suggestion | tasks |
| Notification delivery | 0 tokens | tasks |

With template mode (default), the entire pipeline costs zero LLM tokens. The only cost
is CPU time for SQL queries, which is negligible.

With LLM mode enabled and 3 suggestions/hour max, cost is ~1,500 tokens/hour from the
tasks budget (1.5% of the default 100k/hour budget).

## Test Plan

### Unit Tests (~15 test files)

| File | Tests | What it verifies |
|---|---|---|
| `anticipation/__tests__/meeting-prep.test.ts` | 5 | Detects upcoming meetings with known attendees, ignores all-day events, confidence levels |
| `anticipation/__tests__/travel-prep.test.ts` | 4 | Detects travel by location, handles missing location, home city exclusion |
| `anticipation/__tests__/health-nudge.test.ts` | 4 | Fires after threshold hour, skips if activity found, respects disabled config |
| `anticipation/__tests__/follow-up.test.ts` | 4 | Detects unresolved commitments, respects delay window, ignores resolved ones |
| `anticipation/__tests__/birthday.test.ts` | 3 | Detects upcoming birthdays from KG, handles date wrapping (Dec->Jan) |
| `anticipation/__tests__/enricher.test.ts` | 4 | Queries correct memories per pattern type, handles empty results |
| `anticipation/__tests__/trigger.test.ts` | 6 | Confidence filter, cooldown, rate limit, suppression, energy budget check |
| `anticipation/__tests__/composer.test.ts` | 4 | Template interpolation, handles missing fields, LLM mode stub |
| `anticipation/__tests__/history.test.ts` | 5 | Record, query, cooldown check, feedback recording, auto-suppression |
| `anticipation/__tests__/engine.test.ts` | 5 | Full pipeline integration, empty results, error resilience, config disabled |

**Total: ~44 tests across 10 test files.**

All tests use in-memory SQLite databases and FakeClaudeProcess (for optional LLM mode).
No real calendar providers, no real network calls. Pattern detectors receive test data
via their DetectionContext parameter.

### Integration Test

One integration test in `daemon/__tests__/anticipation-integration.test.ts` verifying:
- Scheduled task fires anticipation:check.
- Engine runs, produces suggestion.
- Suggestion event is published and handled.
- Notification reaches mock channel.

## Open Questions

1. **External data providers (weather, transit)**: should Phase 1 include a weather
   provider (Open-Meteo is free, no key needed), or defer all external data to Phase 2?

2. **User feedback UX**: how should the user dismiss/rate suggestions? Options:
   a. Telegram inline keyboard buttons (requires grammy keyboard support).
   b. Text reply ("not helpful").
   c. Both.

3. **Commute detection**: requires knowing home and work addresses. Should this come from
   explicit config, or be inferred from calendar patterns? (Deferred to Phase 2 in
   current plan.)

4. **LLM composition language**: should the LLM compose notifications in German (user's
   language) or English? The user profile indicates German conversation preference.
   Template mode can have German templates.

5. **Maximum detectors**: should the plugin system be able to register custom detectors
   via the existing `PluginRegistry`? If so, the `IPatternDetector` interface should
   be exported from `@eidolon/protocol`.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Notification fatigue | Medium | High | Rate limiting (3/hour), cooldown (4h), feedback suppression |
| False positives | Medium | Medium | Confidence thresholds, user feedback loop |
| Performance (5-min checks) | Low | Low | Pure SQL queries, no LLM, bounded result sets |
| Stale calendar data | Low | Medium | Calendar sync runs independently; anticipation reads latest |
| Memory search noise | Medium | Low | Use typed memory queries (preference, episode, decision) |
