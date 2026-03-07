/**
 * Workflow types and Zod schemas.
 *
 * All external data passes through Zod validation before entering the engine.
 * Step configs use a discriminated union keyed on StepType.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_WORKFLOW_DEFINITIONS = 1000;
export const MAX_WORKFLOW_RUNS = 10000;
export const MAX_CONCURRENT_WORKFLOWS = 5;
export const MAX_PARALLEL_STEPS = 3;
export const MAX_SUB_WORKFLOW_DEPTH = 3;
export const DEFAULT_MAX_DURATION_MS = 1_800_000; // 30 min
export const DEFAULT_STEP_TIMEOUT_MS = 300_000; // 5 min

// ---------------------------------------------------------------------------
// Step Types
// ---------------------------------------------------------------------------

export const STEP_TYPES = [
  "llm_call",
  "api_call",
  "channel_send",
  "wait",
  "condition",
  "transform",
  "sub_workflow",
  "ha_command",
  "memory_query",
] as const;

export type StepType = (typeof STEP_TYPES)[number];

// ---------------------------------------------------------------------------
// Retry Policy
// ---------------------------------------------------------------------------

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  backoffMs: z.number().int().min(100).default(1000),
  backoffMultiplier: z.number().min(1).max(10).default(2.0),
  maxBackoffMs: z.number().int().min(1000).default(60000),
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

// ---------------------------------------------------------------------------
// Step Config Schemas (per StepType)
// ---------------------------------------------------------------------------

export const LlmCallConfigSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  outputKey: z.string().min(1),
});
export type LlmCallConfig = z.infer<typeof LlmCallConfigSchema>;

export const ApiCallConfigSchema = z.object({
  url: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  outputKey: z.string().min(1),
});
export type ApiCallConfig = z.infer<typeof ApiCallConfigSchema>;

export const ChannelSendConfigSchema = z.object({
  channelId: z.string().min(1),
  message: z.string().min(1),
  format: z.enum(["text", "markdown"]).optional(),
});
export type ChannelSendConfig = z.infer<typeof ChannelSendConfigSchema>;

export const WaitConfigSchema = z.object({
  durationMs: z.number().int().positive().optional(),
  untilEvent: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type WaitConfig = z.infer<typeof WaitConfigSchema>;

export const ConditionConfigSchema = z.object({
  expression: z.string().min(1),
  thenSteps: z.array(z.string()),
  elseSteps: z.array(z.string()),
});
export type ConditionConfig = z.infer<typeof ConditionConfigSchema>;

export const TransformConfigSchema = z.object({
  input: z.string().min(1),
  expression: z.string().min(1),
  outputKey: z.string().min(1),
});
export type TransformConfig = z.infer<typeof TransformConfigSchema>;

export const SubWorkflowConfigSchema = z.object({
  workflowId: z.string().min(1),
  inputMapping: z.record(z.string()).optional(),
  outputKey: z.string().min(1),
});
export type SubWorkflowConfig = z.infer<typeof SubWorkflowConfigSchema>;

export const HaCommandConfigSchema = z.object({
  entityId: z.string().min(1),
  action: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  outputKey: z.string().optional(),
});
export type HaCommandConfig = z.infer<typeof HaCommandConfigSchema>;

export const MemoryQueryConfigSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
  outputKey: z.string().min(1),
});
export type MemoryQueryConfig = z.infer<typeof MemoryQueryConfigSchema>;

export type StepConfig = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Workflow Trigger
// ---------------------------------------------------------------------------

export const WorkflowTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("scheduled"), cron: z.string().min(1) }),
  z.object({
    type: z.literal("event"),
    eventType: z.string().min(1),
    filter: z.record(z.unknown()).optional(),
  }),
  z.object({ type: z.literal("webhook"), endpointId: z.string().min(1) }),
  z.object({
    type: z.literal("condition"),
    expression: z.string().min(1),
    pollIntervalMs: z.number().int().positive(),
  }),
]);

export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;

// ---------------------------------------------------------------------------
// Failure Strategy
// ---------------------------------------------------------------------------

export const FailureStrategySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("abort") }),
  z.object({ type: z.literal("notify"), channel: z.string().min(1) }),
  z.object({ type: z.literal("retry_from"), stepId: z.string().min(1) }),
]);

export type FailureStrategy = z.infer<typeof FailureStrategySchema>;

// ---------------------------------------------------------------------------
// Workflow Step Definition
// ---------------------------------------------------------------------------

export const WorkflowStepDefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(STEP_TYPES),
  config: z.record(z.unknown()),
  dependsOn: z.array(z.string()).default([]),
  retryPolicy: RetryPolicySchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  condition: z.string().optional(),
});

export type WorkflowStepDef = z.infer<typeof WorkflowStepDefSchema>;

// ---------------------------------------------------------------------------
// Workflow Definition
// ---------------------------------------------------------------------------

export const WorkflowDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  trigger: WorkflowTriggerSchema,
  steps: z.array(WorkflowStepDefSchema).min(1),
  onFailure: FailureStrategySchema.default({ type: "abort" }),
  createdAt: z.number(),
  createdBy: z.string().default("user"),
  maxDurationMs: z.number().int().positive().default(DEFAULT_MAX_DURATION_MS),
  metadata: z.record(z.unknown()).default({}),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// ---------------------------------------------------------------------------
// Workflow Run (runtime state)
// ---------------------------------------------------------------------------

export const WORKFLOW_STATUSES = [
  "pending",
  "running",
  "waiting",
  "retrying",
  "completed",
  "failed",
  "cancelled",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const STEP_STATUSES = ["pending", "running", "completed", "failed", "skipped"] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

export interface WorkflowRun {
  readonly id: string;
  readonly definitionId: string;
  readonly status: WorkflowStatus;
  readonly context: WorkflowContext;
  readonly currentStepId: string | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly error: string | null;
  readonly triggerPayload: unknown;
  readonly createdAt: number;
}

export interface WorkflowContext {
  readonly runId: string;
  readonly definitionId: string;
  readonly stepOutputs: ReadonlyMap<string, unknown>;
  readonly triggerPayload: unknown;
  readonly variables: Record<string, unknown>;
}

export interface StepResult {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly status: StepStatus;
  readonly output: unknown;
  readonly error: string | null;
  readonly attempt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly tokensUsed: number;
}

export interface StepOutput {
  readonly data: unknown;
  readonly tokensUsed: number;
}

export interface WorkflowRunStatus {
  readonly run: WorkflowRun;
  readonly steps: readonly StepResult[];
  readonly definition: WorkflowDefinition;
}

// ---------------------------------------------------------------------------
// Step Executor Interface
// ---------------------------------------------------------------------------

import type { EidolonError, Result } from "@eidolon/protocol";

export interface IStepExecutor {
  readonly type: StepType;
  execute(config: StepConfig, context: WorkflowContext, signal: AbortSignal): Promise<Result<StepOutput, EidolonError>>;
}

// ---------------------------------------------------------------------------
// Workflow Engine Interface
// ---------------------------------------------------------------------------

import type { BusEvent } from "@eidolon/protocol";
import type { EventHandlerResult } from "../loop/cognitive-loop.ts";

export interface IWorkflowEngine {
  createDefinition(def: WorkflowDefinition): Result<WorkflowDefinition, EidolonError>;
  startRun(definitionId: string, triggerPayload?: unknown): Result<WorkflowRun, EidolonError>;
  processEvent(event: BusEvent): Promise<EventHandlerResult>;
  cancelRun(runId: string): Result<void, EidolonError>;
  recoverRunningWorkflows(): Result<number, EidolonError>;
  getRunStatus(runId: string): Result<WorkflowRunStatus, EidolonError>;
}

// ---------------------------------------------------------------------------
// Workflow event payloads
// ---------------------------------------------------------------------------

export interface WorkflowTriggerPayload {
  readonly definitionId: string;
  readonly triggerPayload?: unknown;
}

export interface WorkflowStepReadyPayload {
  readonly runId: string;
  readonly stepId: string;
}

export interface WorkflowStepCompletedPayload {
  readonly runId: string;
  readonly stepId: string;
  readonly tokensUsed: number;
}

export interface WorkflowStepFailedPayload {
  readonly runId: string;
  readonly stepId: string;
  readonly error: string;
}

export interface WorkflowCompletedPayload {
  readonly runId: string;
  readonly definitionId: string;
}

export interface WorkflowFailedPayload {
  readonly runId: string;
  readonly definitionId: string;
  readonly error: string;
}

export interface WorkflowCancelledPayload {
  readonly runId: string;
  readonly definitionId: string;
}
