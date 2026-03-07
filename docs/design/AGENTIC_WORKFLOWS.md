# Agentic Workflows

> **Status: Design** -- not yet implemented.
> This document describes the architecture for multi-step, resumable workflow execution in Eidolon.

## The Problem

Eidolon's existing scheduler and automation engine handle single-step tasks well:
"Every Monday at 9am, summarize my GitHub commits." But real-world tasks are often
multi-step pipelines with branching, error handling, and dependencies between steps:

- "Research X, summarize the findings, create a presentation, email it to Y"
- "Every Monday: collect my GitHub commits from the past week, summarize them, send via Telegram"
- "When the office temperature drops below 18C, turn on the heating and notify me"

These require a **workflow engine** -- a system that can define, persist, execute, pause,
resume, and recover multi-step task graphs.

## Design Principles

1. **Natural language first** -- users define workflows conversationally; Eidolon parses them
   into a structured DAG. No DSL to learn.
2. **Crash-safe** -- every step transition is persisted to SQLite before execution.
   After a restart, workflows resume from the last completed step.
3. **Composable** -- step types are pluggable; the engine does not know about LLMs, channels,
   or APIs. Step executors are injected.
4. **Observable** -- every step emits events on the EventBus for audit, metrics, and debugging.
5. **Budget-aware** -- workflow execution respects the energy budget and can be deferred
   when tokens are exhausted.

## Workflow Definition Format

### User-Facing: Natural Language

Users describe workflows in plain language via any channel (Telegram, CLI, web):

```
"Research the latest TypeScript 6.0 features, summarize the key changes,
 and send the summary to my Telegram"
```

Eidolon uses Claude (via ILLMProvider) to parse this into a `WorkflowDefinition`.
The parsed result is shown to the user for confirmation before execution.

### Internal: WorkflowDefinition (JSON/Zod)

```typescript
interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly trigger: WorkflowTrigger;
  readonly steps: readonly WorkflowStepDef[];
  readonly onFailure: FailureStrategy;
  readonly createdAt: number;
  readonly createdBy: string;         // "user" | "system"
  readonly maxDurationMs: number;     // global timeout, default 30 min
  readonly metadata: Record<string, unknown>;
}

type WorkflowTrigger =
  | { readonly type: "manual" }
  | { readonly type: "scheduled"; readonly cron: string }
  | { readonly type: "event"; readonly eventType: EventType; readonly filter?: Record<string, unknown> }
  | { readonly type: "webhook"; readonly endpointId: string }
  | { readonly type: "condition"; readonly expression: string; readonly pollIntervalMs: number };

interface WorkflowStepDef {
  readonly id: string;               // unique within the workflow
  readonly name: string;
  readonly type: StepType;
  readonly config: StepConfig;
  readonly dependsOn: readonly string[];  // step IDs that must complete first
  readonly retryPolicy?: RetryPolicy;
  readonly timeoutMs?: number;       // per-step timeout, default 5 min
  readonly condition?: string;       // skip this step if condition is false
}

type StepType =
  | "llm_call"       // invoke Claude via ILLMProvider
  | "api_call"       // HTTP request to external API
  | "channel_send"   // send message via MessageRouter
  | "wait"           // pause for duration or until event
  | "condition"      // evaluate condition, branch execution
  | "transform"      // transform data (jq-like expressions)
  | "sub_workflow"   // invoke another workflow
  | "ha_command"     // home automation command via HAManager
  | "memory_query"   // search Eidolon's memory

type StepConfig = Record<string, unknown>;  // validated per StepType via Zod discriminated union

interface RetryPolicy {
  readonly maxAttempts: number;      // default 3
  readonly backoffMs: number;        // initial backoff, default 1000
  readonly backoffMultiplier: number; // default 2.0
  readonly maxBackoffMs: number;     // cap, default 60000
}

type FailureStrategy =
  | { readonly type: "abort" }                          // stop workflow, mark failed
  | { readonly type: "notify"; readonly channel: string } // notify user, keep failed state
  | { readonly type: "retry_from"; readonly stepId: string }; // retry from a specific step
```

### Step Config Schemas (per StepType)

```typescript
// llm_call
interface LlmCallConfig {
  readonly prompt: string;           // may reference {{stepId.output}} placeholders
  readonly model?: string;           // model override
  readonly systemPrompt?: string;
  readonly maxTokens?: number;
  readonly outputKey: string;        // key to store result under in workflow context
}

// api_call
interface ApiCallConfig {
  readonly url: string;              // may contain {{variable}} placeholders
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly outputKey: string;
}

// channel_send
interface ChannelSendConfig {
  readonly channelId: string;        // "telegram", "discord", "email"
  readonly message: string;          // may reference {{stepId.output}}
  readonly format?: "text" | "markdown";
}

// wait
interface WaitConfig {
  readonly durationMs?: number;      // wait for fixed duration
  readonly untilEvent?: EventType;   // wait until this event fires
  readonly timeoutMs?: number;       // max wait time
}

// condition
interface ConditionConfig {
  readonly expression: string;       // evaluated against workflow context
  readonly thenSteps: readonly string[]; // step IDs to enable if true
  readonly elseSteps: readonly string[]; // step IDs to enable if false
}

// transform
interface TransformConfig {
  readonly input: string;            // reference to {{stepId.output}}
  readonly expression: string;       // transformation expression
  readonly outputKey: string;
}

// ha_command
interface HaCommandConfig {
  readonly entityId: string;
  readonly action: string;           // "turn_on", "turn_off", "set_temperature", etc.
  readonly params?: Record<string, unknown>;
  readonly outputKey?: string;
}

// memory_query
interface MemoryQueryConfig {
  readonly query: string;            // search query, may use {{placeholders}}
  readonly limit?: number;
  readonly outputKey: string;
}
```

## Workflow Engine Architecture

### Components

```
                    +-----------------------+
                    |   WorkflowParser      |  NL -> WorkflowDefinition
                    |   (uses ILLMProvider)  |  (Claude parses user input)
                    +-----------+-----------+
                                |
                    +-----------v-----------+
                    |   WorkflowStore       |  CRUD for definitions + runs
                    |   (operational.db)    |  persists to SQLite
                    +-----------+-----------+
                                |
                    +-----------v-----------+
         +--------->  WorkflowEngine       |  State machine, step dispatch
         |          |  (main orchestrator)  |
         |          +-----------+-----------+
         |                      |
    EventBus                    |  delegates to
    (events)                    |
         |          +-----------v-----------+
         +----------+  StepExecutorRegistry |  Maps StepType -> executor
                    +-----------+-----------+
                                |
              +-----------------+------------------+
              |                 |                  |
    +---------v----+  +---------v----+  +----------v---+
    | LlmExecutor  |  | ApiExecutor  |  | ChannelExec  |  ...etc
    +--------------+  +--------------+  +--------------+
```

### State Machine (WorkflowRun)

```
         +----------+
         | PENDING  |  (created, waiting for trigger)
         +----+-----+
              |
         +----v-----+
    +--->| RUNNING  |  (at least one step executing)
    |    +----+-----+
    |         |
    |    +----v-----+       +----------+
    |    | WAITING  |------>| RUNNING  |  (event/timer fired, resume)
    |    +----+-----+       +----------+
    |         |
    |    +----v-----+
    +----| RETRYING |  (step failed, retrying)
         +----+-----+
              |
     +--------+--------+
     |                  |
+----v-----+    +-------v-----+
| COMPLETED|    |   FAILED    |
+----------+    +------+------+
                       |
                +------v------+
                |  CANCELLED  |  (user cancelled)
                +-------------+
```

### Execution Model

The WorkflowEngine does NOT run its own event loop. Instead, it integrates with
the existing Cognitive Loop via the EventBus:

1. **Trigger fires** -- scheduler emits `workflow:trigger`, or user sends a message
   that the event handler recognizes as a workflow invocation.
2. **CognitiveLoop picks up** the `workflow:step_ready` event during PERCEIVE.
3. **Event handler** calls `WorkflowEngine.executeNextStep(runId)`.
4. **WorkflowEngine** finds the next ready step, invokes its executor, persists the result,
   and publishes `workflow:step_ready` for the next step (or `workflow:completed`).
5. Each step is a single PEAR cycle -- the loop processes one step per cycle,
   then re-evaluates priorities. User messages can interrupt between steps.

This approach means workflows never starve user interactions and naturally respect
the energy budget.

### Crash Recovery

On daemon restart:
1. `EventBus.replayUnprocessed()` replays any in-flight `workflow:step_ready` events.
2. `WorkflowEngine.recoverRunningWorkflows()` queries `workflow_runs` for runs in
   `RUNNING` or `WAITING` state, checks which steps completed, and re-publishes
   `workflow:step_ready` for the next pending step.
3. Steps that were `RUNNING` at crash time are re-executed (idempotency is the
   step executor's responsibility). The `step_results` table stores the last
   attempt's `started_at` -- if it was more than `timeoutMs` ago, the step is
   considered timed out and retried per its RetryPolicy.

### Variable Interpolation

Step configs can reference outputs from previous steps using `{{stepId.output}}`
syntax. Before executing a step, the engine resolves all placeholders from the
workflow context (a map of stepId -> output).

```typescript
function interpolate(template: string, context: WorkflowContext): string {
  return template.replace(/\{\{(\w+)\.output\}\}/g, (_, stepId) => {
    const value = context.stepOutputs.get(stepId);
    return typeof value === "string" ? value : JSON.stringify(value ?? "");
  });
}
```

## Database Schema

All workflow tables live in **operational.db** (the existing operational database).

```sql
-- Workflow definitions (templates)
CREATE TABLE workflow_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('manual','scheduled','event','webhook','condition')),
  trigger_config TEXT NOT NULL DEFAULT '{}',
  steps TEXT NOT NULL,            -- JSON array of WorkflowStepDef
  on_failure TEXT NOT NULL DEFAULT '{"type":"notify","channel":"telegram"}',
  max_duration_ms INTEGER NOT NULL DEFAULT 1800000,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_workflow_defs_enabled ON workflow_definitions(enabled);
CREATE INDEX idx_workflow_defs_trigger ON workflow_definitions(trigger_type);

-- Workflow runs (instances)
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL REFERENCES workflow_definitions(id),
  status TEXT NOT NULL CHECK(status IN ('pending','running','waiting','retrying','completed','failed','cancelled')),
  context TEXT NOT NULL DEFAULT '{}',   -- JSON: step outputs, variables
  current_step_id TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  error TEXT,
  trigger_payload TEXT DEFAULT '{}',    -- what triggered this run
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX idx_workflow_runs_def ON workflow_runs(definition_id);

-- Step results (per step per run)
CREATE TABLE workflow_step_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_id TEXT NOT NULL,               -- references step.id within the definition
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','skipped')),
  output TEXT,                         -- JSON: step output
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER,
  completed_at INTEGER,
  tokens_used INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_step_results_run ON workflow_step_results(run_id);
CREATE INDEX idx_step_results_status ON workflow_step_results(run_id, status);
```

## Integration with Existing Systems

### Event Bus -- New Event Types

Add to `EventType` in `packages/protocol/src/types/events.ts`:

```typescript
| "workflow:trigger"       // a workflow trigger fired
| "workflow:step_ready"    // next step is ready to execute
| "workflow:step_completed" // a step finished
| "workflow:step_failed"   // a step failed
| "workflow:completed"     // entire workflow completed
| "workflow:failed"        // entire workflow failed
| "workflow:cancelled"     // workflow was cancelled by user
```

### Scheduler Integration

Workflows with `trigger.type === "scheduled"` register a scheduled task via
the existing `TaskScheduler` with `action: "workflow:trigger"`. When the scheduler
fires, the task-executor publishes a `workflow:trigger` event, which the
WorkflowEngine picks up to start a new run.

### Event Handler Integration

Add a new case in `event-handlers.ts`:

```typescript
case "workflow:trigger":
case "workflow:step_ready":
  return handleWorkflowEvent(modules, event, logger);
```

The `handleWorkflowEvent` function delegates to `WorkflowEngine.processEvent()`.

### Home Automation Integration

The `ha_command` step type uses the existing `HAManager` from
`packages/core/src/home-automation/manager.ts`. The `condition` trigger type
can poll HA entity states via `HAManager.getEntityState()`.

### Session Supervisor

Workflow LLM steps register as `task` sessions with the SessionSupervisor.
Since `task` has `maxConcurrent: 3`, up to 3 workflow steps can run in parallel
(from different workflows). Workflows are interruptible by higher-priority
events (user messages, voice).

### Channel Router

The `channel_send` step type uses the existing `MessageRouter.sendNotification()`
method, respecting DND schedules.

## Files to Create

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `packages/core/src/workflow/engine.ts` | WorkflowEngine: orchestration, state transitions, crash recovery | ~280 |
| `packages/core/src/workflow/store.ts` | WorkflowStore: CRUD for definitions and runs in SQLite | ~250 |
| `packages/core/src/workflow/parser.ts` | WorkflowParser: NL -> WorkflowDefinition using ILLMProvider | ~200 |
| `packages/core/src/workflow/executor-registry.ts` | StepExecutorRegistry: maps StepType -> executor | ~80 |
| `packages/core/src/workflow/executors/llm.ts` | LLM call step executor | ~120 |
| `packages/core/src/workflow/executors/api.ts` | HTTP API call step executor | ~100 |
| `packages/core/src/workflow/executors/channel.ts` | Channel send step executor | ~60 |
| `packages/core/src/workflow/executors/wait.ts` | Wait/delay step executor | ~80 |
| `packages/core/src/workflow/executors/condition.ts` | Condition evaluation step executor | ~70 |
| `packages/core/src/workflow/executors/transform.ts` | Data transformation step executor | ~60 |
| `packages/core/src/workflow/executors/ha.ts` | Home automation step executor | ~70 |
| `packages/core/src/workflow/executors/memory.ts` | Memory query step executor | ~60 |
| `packages/core/src/workflow/interpolation.ts` | Variable interpolation for step configs | ~50 |
| `packages/core/src/workflow/types.ts` | Zod schemas and TypeScript types | ~200 |
| `packages/core/src/workflow/index.ts` | Module barrel export | ~15 |
| `packages/core/src/workflow/__tests__/engine.test.ts` | Engine tests | ~300 |
| `packages/core/src/workflow/__tests__/store.test.ts` | Store CRUD tests | ~200 |
| `packages/core/src/workflow/__tests__/parser.test.ts` | Parser tests | ~150 |
| `packages/core/src/workflow/__tests__/executors.test.ts` | Step executor tests | ~250 |
| `packages/core/src/workflow/__tests__/interpolation.test.ts` | Interpolation tests | ~80 |
| `packages/core/src/workflow/__tests__/integration.test.ts` | End-to-end workflow tests | ~200 |

**Total: ~2,875 lines** (21 files)

## Files to Modify

| File | Change |
|------|--------|
| `packages/protocol/src/types/events.ts` | Add 7 new `workflow:*` event types |
| `packages/protocol/src/types/sessions.ts` | Add `"workflow"` to `SessionType` (optional -- can reuse `"task"`) |
| `packages/core/src/daemon/types.ts` | Add `workflowEngine?: WorkflowEngine` to `InitializedModules` |
| `packages/core/src/daemon/event-handlers.ts` | Add workflow event handler routing |
| `packages/core/src/daemon/init-services.ts` | Initialize WorkflowEngine, WorkflowStore, executors |
| `packages/core/src/daemon/shutdown.ts` | Cancel running workflows on shutdown |
| `packages/core/src/database/schemas/operational.ts` | Add migration for workflow tables |
| `packages/core/src/loop/state-machine.ts` | Add `"execute_workflow"` to `ActionType` (optional) |

## Key Interfaces

```typescript
// Step executor interface -- one per StepType
interface IStepExecutor {
  readonly type: StepType;
  execute(
    config: StepConfig,
    context: WorkflowContext,
    signal: AbortSignal,
  ): Promise<Result<StepOutput, EidolonError>>;
}

interface StepOutput {
  readonly data: unknown;           // stored as step output
  readonly tokensUsed: number;
}

interface WorkflowContext {
  readonly runId: string;
  readonly definitionId: string;
  readonly stepOutputs: ReadonlyMap<string, unknown>;
  readonly triggerPayload: unknown;
  readonly variables: Record<string, unknown>;
}

// The main engine interface
interface IWorkflowEngine {
  createDefinition(def: WorkflowDefinition): Result<WorkflowDefinition, EidolonError>;
  startRun(definitionId: string, triggerPayload?: unknown): Result<WorkflowRun, EidolonError>;
  processEvent(event: BusEvent): Promise<EventHandlerResult>;
  cancelRun(runId: string): Result<void, EidolonError>;
  recoverRunningWorkflows(): Result<number, EidolonError>;
  getRunStatus(runId: string): Result<WorkflowRunStatus, EidolonError>;
}
```

## Implementation Steps (Ordered)

### Phase 1: Foundation (~1,000 lines)

1. **Types and Zod schemas** (`types.ts`) -- define all interfaces, Zod validation
   for WorkflowDefinition, StepConfig discriminated union, WorkflowRun, etc.
2. **DB migration** -- add `workflow_definitions`, `workflow_runs`,
   `workflow_step_results` tables to operational schema.
3. **WorkflowStore** (`store.ts`) -- CRUD for definitions and runs. Uses
   parameterized SQL, Result pattern.
4. **Interpolation** (`interpolation.ts`) -- `{{stepId.output}}` resolution.
5. **Tests for store and interpolation**.

### Phase 2: Engine Core (~800 lines)

6. **StepExecutorRegistry** (`executor-registry.ts`) -- register/lookup executors.
7. **WorkflowEngine** (`engine.ts`) -- state machine, step dispatch, crash recovery,
   DAG traversal (topological sort on `dependsOn`).
8. **Event types** -- add `workflow:*` events to protocol.
9. **Event handler wiring** -- integrate into `event-handlers.ts`.
10. **Tests for engine** (with mock executors).

### Phase 3: Step Executors (~620 lines)

11. **LLM executor** -- uses `ClaudeCodeManager` or `ILLMProvider`.
12. **API executor** -- uses `fetch()` with circuit breaker.
13. **Channel executor** -- uses `MessageRouter`.
14. **Wait executor** -- timer + event-based waiting.
15. **Condition executor** -- simple expression evaluator.
16. **Transform executor** -- basic JSON path / template transforms.
17. **HA executor** -- uses `HAManager`.
18. **Memory executor** -- uses `MemorySearch`.
19. **Tests for all executors**.

### Phase 4: Parser and Integration (~450 lines)

20. **WorkflowParser** (`parser.ts`) -- NL -> WorkflowDefinition via Claude.
    Uses a structured output prompt that returns Zod-validated JSON.
21. **Daemon wiring** -- init in `init-services.ts`, shutdown in `shutdown.ts`.
22. **Scheduler integration** -- scheduled workflows register as tasks.
23. **Integration tests** -- end-to-end workflow execution with FakeClaudeProcess.

## Test Strategy

### Unit Tests

| Test File | What It Tests |
|-----------|---------------|
| `store.test.ts` | CRUD operations, concurrency, invalid data rejection |
| `engine.test.ts` | State transitions, DAG traversal, crash recovery, timeout handling |
| `interpolation.test.ts` | Variable substitution, missing variables, nested output |
| `executors.test.ts` | Each executor in isolation with mocked dependencies |
| `parser.test.ts` | NL parsing with FakeClaudeProcess, edge cases |

### Integration Tests

| Test File | What It Tests |
|-----------|---------------|
| `integration.test.ts` | Full workflow execution: define -> trigger -> execute all steps -> verify outputs |
| | Crash recovery: start workflow, simulate crash, verify resume |
| | Timeout handling: step exceeds timeout, verify retry/failure |
| | Condition branching: if/else step routing |
| | Concurrent workflows: two workflows running, verify no interference |
| | Energy budget: workflow deferred when budget exhausted |

### Test Helpers

- **FakeStepExecutor** -- returns configurable results, tracks invocations.
- **In-memory SQLite** -- each test gets a fresh database with migrations applied.
- **FakeClaudeProcess** -- for LLM executor and parser tests.

## Worked Example: "Research + Summarize + Email"

User says: "Research the latest Rust features, summarize them, and email the summary to alice@example.com"

### Parsed WorkflowDefinition

```json
{
  "id": "wf-001",
  "name": "Rust Features Research and Email",
  "trigger": { "type": "manual" },
  "steps": [
    {
      "id": "research",
      "name": "Research Rust features",
      "type": "llm_call",
      "config": {
        "prompt": "Research the latest Rust programming language features. Focus on what was added in the most recent stable releases. Provide detailed findings.",
        "outputKey": "research_results"
      },
      "dependsOn": []
    },
    {
      "id": "summarize",
      "name": "Summarize findings",
      "type": "llm_call",
      "config": {
        "prompt": "Summarize the following research findings into a concise, well-structured email body:\n\n{{research.output}}",
        "outputKey": "summary"
      },
      "dependsOn": ["research"]
    },
    {
      "id": "send_email",
      "name": "Send email to Alice",
      "type": "channel_send",
      "config": {
        "channelId": "email",
        "message": "Subject: Latest Rust Features Summary\n\n{{summarize.output}}",
        "recipientOverride": "alice@example.com"
      },
      "dependsOn": ["summarize"]
    }
  ],
  "onFailure": { "type": "notify", "channel": "telegram" }
}
```

### Execution Flow

```
EventBus:  workflow:trigger {definitionId: "wf-001"}
  |
  v  PEAR cycle 1
Engine:    Create run, find "research" step (no deps), publish workflow:step_ready
  |
  v  PEAR cycle 2
Engine:    Execute "research" (LlmExecutor), store output, find "summarize" ready
  |
  v  PEAR cycle 3
Engine:    Execute "summarize" (LlmExecutor with interpolated prompt), store output
  |
  v  PEAR cycle 4
Engine:    Execute "send_email" (ChannelExecutor), all steps done -> workflow:completed
```

Between each cycle, the Cognitive Loop can process higher-priority events
(user messages, alerts). The workflow advances one step per cycle.

## Worked Example: "Conditional -- Temperature Alert"

User says: "When the office temperature drops below 18 degrees, turn on the heating and notify me"

### Parsed WorkflowDefinition

```json
{
  "id": "wf-002",
  "name": "Office Temperature Alert",
  "trigger": {
    "type": "event",
    "eventType": "ha:state_changed",
    "filter": { "entity_id": "sensor.office_temperature" }
  },
  "steps": [
    {
      "id": "check_temp",
      "name": "Check temperature threshold",
      "type": "condition",
      "config": {
        "expression": "trigger.state < 18",
        "thenSteps": ["heat_on", "notify"],
        "elseSteps": []
      },
      "dependsOn": []
    },
    {
      "id": "heat_on",
      "name": "Turn on heating",
      "type": "ha_command",
      "config": {
        "entityId": "climate.office",
        "action": "turn_on",
        "params": { "temperature": 21 }
      },
      "dependsOn": ["check_temp"]
    },
    {
      "id": "notify",
      "name": "Notify user",
      "type": "channel_send",
      "config": {
        "channelId": "telegram",
        "message": "Office temperature dropped below 18C. Heating turned on (target: 21C)."
      },
      "dependsOn": ["check_temp"]
    }
  ],
  "onFailure": { "type": "notify", "channel": "telegram" }
}
```

Note: `heat_on` and `notify` have no dependency on each other, only on `check_temp`.
The engine can execute them in the same PEAR cycle (both are ready simultaneously)
or in successive cycles -- either approach works because step execution is idempotent.

## Open Questions

1. **Parallel step execution within one cycle** -- should the engine execute
   multiple independent steps in a single PEAR cycle, or strictly one step per cycle?
   Recommendation: one per cycle for simplicity; parallel execution is a v2 optimization.

2. **Workflow versioning** -- when a user updates a workflow definition, should
   running instances use the old or new definition? Recommendation: running instances
   keep the old definition (snapshot at run creation).

3. **Sub-workflow depth limit** -- `sub_workflow` steps can invoke other workflows.
   Recommendation: max depth of 3 to prevent infinite recursion.

4. **Condition expression language** -- how complex should condition expressions be?
   Recommendation: start with simple comparisons (`>`, `<`, `==`, `!=`, `&&`, `||`)
   evaluated against the workflow context. No full JavaScript eval.

5. **Maximum concurrent workflow runs** -- should there be a global limit?
   Recommendation: 10 concurrent runs, configurable. Enforced at `startRun()` time.

6. **Workflow definition storage limit** -- maximum number of saved definitions?
   Recommendation: 100, with user notification when approaching the limit.
