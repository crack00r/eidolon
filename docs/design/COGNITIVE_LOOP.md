# Cognitive Loop

## The Problem with Timers

Every existing personal AI assistant uses timers for proactive behavior:

- **OpenClaw Heartbeat:** Every 30 minutes, read HEARTBEAT.md, check if anything needs attention, reply HEARTBEAT_OK if not.
- **OpenClaw Cron:** Standard cron expressions for scheduled tasks.
- **nanobot:** Same heartbeat + cron pattern, copied from OpenClaw.
- **nanoclaw:** Polling loop with fixed intervals.

This approach has fundamental flaws:

1. **Wasteful:** The agent runs a full LLM turn every 30 minutes even when nothing is happening. At ~$0.02 per turn with Opus, that's ~$30/month just for heartbeats.
2. **Inflexible:** Fixed intervals don't adapt to context. A 30-minute delay is too slow when the user is actively chatting and wasteful at 3 AM.
3. **No initiative:** The agent only reacts to timer events. It can't decide on its own that now is a good time to learn something or consolidate memory.
4. **No prioritization:** A heartbeat check has the same urgency as a user message. There's no concept of what deserves attention NOW vs. later.

## The Cognitive Loop

Eidolon replaces timers with a continuous loop inspired by cognitive science:

```
┌──────────────────────────────────────────────────────────┐
│                   COGNITIVE LOOP                          │
│                                                           │
│   ┌──────────┐     ┌───────────┐     ┌────────────┐     │
│   │ PERCEIVE │────>│  EVALUATE │────>│    ACT     │     │
│   │          │     │           │     │            │     │
│   │ Events   │     │ Priority  │     │ Respond    │     │
│   │ Messages │     │ Urgency   │     │ Learn      │     │
│   │ Triggers │     │ Interest  │     │ Develop    │     │
│   │ Time     │     │ Energy    │     │ Dream      │     │
│   └──────────┘     └───────────┘     │ Rest       │     │
│        ^                              └─────┬──────┘     │
│        │           ┌───────────┐            │            │
│        └───────────│  REFLECT  │<───────────┘            │
│                    │           │                          │
│                    │ Memory    │                          │
│                    │ Journal   │                          │
│                    │ State     │                          │
│                    └───────────┘                          │
└──────────────────────────────────────────────────────────┘
```

### Phase 1: PERCEIVE

Collects all pending events from the Event Bus. Non-blocking. Returns immediately if nothing is waiting.

**Event types:**
- `message.inbound` -- User sent a message (Telegram, Desktop, CLI)
- `message.outbound` -- Response needs to be sent
- `schedule.trigger` -- A planned task is due
- `learning.discovery` -- Discovery pipeline found something
- `memory.consolidation_due` -- Time for dreaming
- `node.connected` / `node.disconnected` -- Client/GPU node status change
- `system.alert` -- Health check failure, disk space, etc.

### Phase 2: EVALUATE

Assigns priority scores to pending events and decides what to do based on:

**Priority factors:**
| Factor | Weight | Example |
|---|---|---|
| User message | Highest | Always processed immediately |
| Scheduled task (due) | High | Reminders, planned actions |
| System alert | High | Health issues, auth expiry |
| Learning discovery | Medium | Interesting finding from Reddit |
| Memory consolidation | Low | Dreaming can wait |
| Self-improvement | Lowest | Code improvements during deep idle |

**Energy Budget:**
The evaluator maintains a token budget per time window to prevent runaway API costs.

```
Configuration:
  energyBudget:
    tokensPerHour: 50000         # Max tokens per hour
    learningAllocation: 0.3      # 30% reserved for learning
    dreamingAllocation: 0.1      # 10% reserved for dreaming
    responseAllocation: 0.6      # 60% for user responses
```

If the budget for a category is exhausted, those actions are deferred until the next window. User messages always have priority and can exceed the budget.

**Context-aware rest calculation:**

```
if (userIsActivelyTyping)       → rest 2 seconds
if (userSentMessageRecently)    → rest 5 seconds
if (businessHours)              → rest 30 seconds
if (hasLearningTasks)           → rest 1 minute
if (nightTime)                  → rest 5 minutes
if (nothingPendingAtAll)        → rest 5 minutes
```

### Phase 3: ACT

Executes the chosen action. One action at a time to maintain coherence.

**Action types:**
| Action | Trigger | Execution |
|---|---|---|
| `respond` | User message | Spawn Claude Code, process message, stream response |
| `execute_task` | Scheduled task | Spawn Claude Code with task-specific context |
| `learn` | Discovery finding | Evaluate relevance, store or implement |
| `dream` | Consolidation due | Run dreaming pipeline (see Memory Engine) |
| `self_improve` | Deep idle | Run implementation pipeline on own codebase |
| `rest` | Nothing pending | Sleep for calculated duration |
| `alert` | System issue | Notify user via preferred channel |

### Phase 4: REFLECT

After every action, automatically:

1. **Memory extraction** -- Analyze the interaction, extract facts and decisions
2. **Journal entry** -- Log what happened and why (for the learning journal)
3. **State update** -- Update energy budget, session state, metrics
4. **Error handling** -- If action failed, decide on retry strategy

This phase runs cheaply (local processing, no LLM call needed for most operations). Only memory extraction may use a lightweight LLM call.

## State Machine

```
            ┌─────────────┐
            │   STARTING   │
            └──────┬───────┘
                   │
            ┌──────▼───────┐
    ┌──────>│  PERCEIVING   │<──────────┐
    │       └──────┬───────┘           │
    │              │                    │
    │       ┌──────▼───────┐           │
    │       │  EVALUATING   │           │
    │       └──────┬───────┘           │
    │              │                    │
    │       ┌──────▼───────┐           │
    │       │   ACTING      │───────────┤
    │       │               │           │
    │       │ ┌───────────┐ │    ┌──────┴───────┐
    │       │ │ responding│ │    │  REFLECTING   │
    │       │ │ learning  │ │    └──────────────┘
    │       │ │ dreaming  │ │
    │       │ │ improving │ │
    │       │ │ resting   │ │
    │       │ └───────────┘ │
    │       └───────────────┘
    │              │
    │       ┌──────▼───────┐
    └───────│  REFLECTING   │
            └──────────────┘
```

## Implementation Sketch

```typescript
interface CognitiveState {
  phase: 'perceiving' | 'evaluating' | 'acting' | 'reflecting';
  energyBudget: EnergyBudget;
  lastUserActivity: Date;
  lastDream: Date;
  lastLearningCycle: Date;
  pendingEvents: Event[];
  currentAction: Action | null;
}

class CognitiveLoop {
  private state: CognitiveState;
  private eventBus: EventBus;
  private brain: ClaudeCodeManager;
  private memory: MemoryEngine;
  private learning: LearningEngine;

  async run(): Promise<never> {
    while (true) {
      // PERCEIVE
      const events = await this.eventBus.drain();
      this.state.pendingEvents.push(...events);
      this.state.phase = 'perceiving';

      // EVALUATE
      this.state.phase = 'evaluating';
      const action = this.evaluate(this.state.pendingEvents);

      // ACT
      this.state.phase = 'acting';
      this.state.currentAction = action;
      const result = await this.execute(action);

      // REFLECT
      this.state.phase = 'reflecting';
      await this.reflect(action, result);
      this.state.currentAction = null;

      // Rest if needed (calculated duration)
      if (action.type === 'rest') {
        await sleep(this.calculateRestDuration());
      }
    }
  }

  private evaluate(events: Event[]): Action {
    // User messages always win
    const userMessage = events.find(e => e.type === 'message.inbound');
    if (userMessage) {
      return { type: 'respond', event: userMessage };
    }

    // Check scheduled tasks
    const dueTask = this.scheduler.getNextDue();
    if (dueTask) {
      return { type: 'execute_task', task: dueTask };
    }

    // System alerts
    const alert = events.find(e => e.type === 'system.alert');
    if (alert) {
      return { type: 'alert', event: alert };
    }

    // Learning (if budget allows)
    if (this.state.energyBudget.allowsLearning()) {
      const discovery = events.find(e => e.type === 'learning.discovery');
      if (discovery) {
        return { type: 'learn', event: discovery };
      }
    }

    // Dreaming (if due and budget allows)
    if (this.shouldDream() && this.state.energyBudget.allowsDreaming()) {
      return { type: 'dream' };
    }

    // Self-improvement (deep idle only)
    if (this.isDeepIdle() && this.state.energyBudget.allowsImprovement()) {
      return { type: 'self_improve' };
    }

    // Nothing to do
    return { type: 'rest' };
  }

  private calculateRestDuration(): number {
    const sinceLastUser = Date.now() - this.state.lastUserActivity.getTime();

    if (sinceLastUser < 10_000) return 2_000;        // User just active: 2s
    if (sinceLastUser < 60_000) return 5_000;         // Recent activity: 5s
    if (isBusinessHours()) return 30_000;              // Business hours: 30s
    if (this.hasPendingLearning()) return 60_000;      // Has learning: 1m
    return 300_000;                                    // Night/deep idle: 5m
  }
}
```

## Comparison with OpenClaw Heartbeat

| Aspect | OpenClaw Heartbeat | Eidolon Cognitive Loop |
|---|---|---|
| Trigger | Fixed timer (30min) | Continuous, event-driven |
| Cost when idle | ~$30/month (heartbeats) | Near zero (rest state) |
| User message latency | Up to 30min delay | < 2 seconds |
| Learning capability | None | Idle time used for learning |
| Memory consolidation | None (pre-compaction panic) | Scheduled dreaming phases |
| Priority management | None (everything equal) | Multi-factor priority scoring |
| Energy management | None (runs regardless) | Token budget per category |
| Context awareness | None | Time-of-day, user presence, system load |

## Concurrency and Multi-Session

The Cognitive Loop is the single decision-maker, but it can manage multiple concurrent sessions. It does NOT process everything sequentially -- it delegates to parallel sessions and maintains oversight.

### How It Works

```
Cognitive Loop (single thread, fast):
  PERCEIVE: Collect events from ALL sessions + external sources
  EVALUATE: Decide what needs attention NOW
  ACT:      Dispatch to appropriate session (may run in parallel)
  REFLECT:  Process results from completed actions

Session Pool (parallel):
  main-session:    [processing user message]     ← Claude Code #1
  learning-001:    [crawling Reddit]             ← Claude Code #2
  voice-pipeline:  [waiting for audio]           ← GPU Worker
  dream-session:   [paused, resumes at 02:00]
```

The Cognitive Loop runs fast (milliseconds per cycle) because it only makes decisions. The actual work (LLM calls, web scraping, TTS generation) happens in parallel sessions managed by the Session Supervisor.

### Interruption Protocol

When a high-priority event arrives while lower-priority sessions are running:

```typescript
// In the evaluate phase:
if (event.type === 'message.inbound' && this.isUserMessage(event)) {
  // User messages always get immediate attention
  
  // If learning session is using the last available Claude process:
  if (this.sessionPool.availableSlots() === 0) {
    // Pause lowest-priority session
    const pausable = this.sessionPool.getLowestPriority();
    await this.supervisor.pause(pausable, 'user_message_priority');
    // Resume it later when Claude process becomes available
  }
  
  // Process user message immediately
  return { type: 'respond', event, priority: 'immediate' };
}
```

### Session Lifecycle in the Loop

```
PERCEIVE
  ├── Check Event Bus for new events
  ├── Check Session Supervisor for completed/failed sessions
  ├── Check scheduled tasks
  └── Collect inter-session messages

EVALUATE
  ├── Score all pending events
  ├── Check resource availability (Claude processes, GPU, energy)
  ├── Decide: respond / dispatch-task / learn / dream / rest
  └── If multiple actions possible: run highest priority, queue rest

ACT
  ├── If new session needed: request from Session Supervisor
  ├── If existing session: forward event via Inter-Session Bus
  ├── If resource conflict: pause lower priority, allocate to higher
  └── If nothing to do: rest (adaptive duration)

REFLECT
  ├── Process results from ANY completed session
  ├── Memory extraction from completed conversations
  ├── Update energy budget (deduct from acting session's allocation)
  ├── Log to audit trail
  └── Check if paused sessions can resume
```

## Scheduler (Replacing Cron)

Instead of a separate cron system, Eidolon has a built-in scheduler that feeds into the Event Bus:

```typescript
interface ScheduledTask {
  id: string;
  name: string;
  schedule: {
    type: 'once' | 'recurring' | 'conditional';
    at?: Date;                    // For 'once'
    interval?: string;            // For 'recurring': '1h', '30m', '1d'
    cron?: string;                // For 'recurring': standard cron expression
    condition?: () => boolean;    // For 'conditional'
  };
  payload: {
    message: string;              // What to tell Claude
    model?: string;               // Model override
    channel?: string;             // Where to deliver result
    classification: 'safe' | 'needs_approval';
  };
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
}
```

The scheduler emits `schedule.trigger` events that the Cognitive Loop evaluates alongside other events. This means scheduled tasks compete fairly with other priorities rather than running in isolation.
