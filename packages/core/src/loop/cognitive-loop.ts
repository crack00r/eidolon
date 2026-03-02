/**
 * CognitiveLoop — main PEAR (Perceive-Evaluate-Act-Reflect) orchestration cycle.
 *
 * Continuously dequeues events from the EventBus, evaluates their priority,
 * routes them to the appropriate handler, and tracks energy consumption.
 * Rests adaptively when the queue is empty.
 */

import type { BusEvent, EidolonError, Result } from "@eidolon/protocol";
import { Err, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { BudgetCategory, EnergyBudget } from "./energy-budget.ts";
import type { EventBus } from "./event-bus.ts";
import type { PriorityEvaluator, PriorityScore } from "./priority.ts";
import type { RestCalculator } from "./rest.ts";
import type { SessionSupervisor } from "./session-supervisor.ts";
import type { ActionType, CognitiveStateMachine } from "./state-machine.ts";

/** Handler function for processing events. Injected dependency. */
export type EventHandler = (event: BusEvent, priority: PriorityScore) => Promise<EventHandlerResult>;

export interface EventHandlerResult {
  readonly success: boolean;
  readonly tokensUsed: number;
  readonly error?: string;
}

/** Map action types to budget categories. */
export type ActionCategoryMap = Partial<Record<ActionType, BudgetCategory>>;

export interface CognitiveLoopOptions {
  /** Map from action type to budget category. Defaults provided. */
  readonly actionCategories?: ActionCategoryMap;
  /** Handler for processing events. Required for actual operation. */
  readonly handler?: EventHandler;
  /** Estimated tokens per action when handler doesn't report. */
  readonly defaultTokenEstimate?: number;
}

export interface CycleResult {
  readonly hadEvent: boolean;
  readonly action: ActionType | null;
  readonly tokensUsed: number;
  readonly restMs: number;
  readonly deferred: boolean;
}

export interface LoopStats {
  readonly totalCycles: number;
  readonly eventsProcessed: number;
  readonly eventsFailed: number;
  readonly eventsDeferred: number;
  readonly totalTokensUsed: number;
  readonly totalRestMs: number;
  readonly startedAt: number | null;
  readonly lastCycleAt: number | null;
}

const DEFAULT_ACTION_CATEGORIES: Record<ActionType, BudgetCategory> = {
  respond: "user",
  execute_task: "tasks",
  learn: "learning",
  dream: "dreaming",
  self_improve: "learning",
  alert: "alert",
  rest: "user",
};

const DEFAULT_TOKEN_ESTIMATE = 1000;
const ERROR_RETRY_DELAY_MS = 5000;

/** Business hours start (inclusive). */
const BUSINESS_HOURS_START = 8;
/** Business hours end (exclusive). */
const BUSINESS_HOURS_END = 18;
/** Polling interval (ms) to check if loop was stopped during sleep. */
const SLEEP_POLL_INTERVAL_MS = 50;

export class CognitiveLoop {
  private readonly eventBus: EventBus;
  private readonly stateMachine: CognitiveStateMachine;
  private readonly evaluator: PriorityEvaluator;
  private readonly energyBudget: EnergyBudget;
  private readonly restCalculator: RestCalculator;
  private readonly logger: Logger;
  private readonly handler: EventHandler | undefined;
  private readonly actionCategories: Record<ActionType, BudgetCategory>;
  private readonly defaultTokenEstimate: number;

  /** Session supervisor for future concurrency management. */
  readonly supervisor: SessionSupervisor;

  private _running: boolean;
  private lastUserActivityAt: number;
  private stats: {
    totalCycles: number;
    eventsProcessed: number;
    eventsFailed: number;
    eventsDeferred: number;
    totalTokensUsed: number;
    totalRestMs: number;
    startedAt: number | null;
    lastCycleAt: number | null;
  };

  constructor(
    eventBus: EventBus,
    stateMachine: CognitiveStateMachine,
    evaluator: PriorityEvaluator,
    energyBudget: EnergyBudget,
    restCalculator: RestCalculator,
    supervisor: SessionSupervisor,
    logger: Logger,
    options?: CognitiveLoopOptions,
  ) {
    this.eventBus = eventBus;
    this.stateMachine = stateMachine;
    this.evaluator = evaluator;
    this.energyBudget = energyBudget;
    this.restCalculator = restCalculator;
    this.supervisor = supervisor;
    this.logger = logger;
    this.handler = options?.handler;
    this.actionCategories = {
      ...DEFAULT_ACTION_CATEGORIES,
      ...options?.actionCategories,
    };
    this.defaultTokenEstimate = options?.defaultTokenEstimate ?? DEFAULT_TOKEN_ESTIMATE;

    this._running = false;
    this.lastUserActivityAt = Date.now();
    this.stats = {
      totalCycles: 0,
      eventsProcessed: 0,
      eventsFailed: 0,
      eventsDeferred: 0,
      totalTokensUsed: 0,
      totalRestMs: 0,
      startedAt: null,
      lastCycleAt: null,
    };
  }

  /** Start the loop. Runs until stop() is called. */
  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this.stats.startedAt = Date.now();
    this.logger.info("loop", "Cognitive loop started");

    while (this._running) {
      const result = await this.runOneCycle();
      if (!result.ok) {
        this.logger.error("loop", `Cycle error: ${result.error.message}`);
        await this.sleep(ERROR_RETRY_DELAY_MS);
      }
    }

    const stopTransition = this.stateMachine.transition("stopping");
    if (!stopTransition.ok) {
      this.logger.warn("loop", `State transition to 'stopping' failed: ${stopTransition.error.message}`);
    }
    this.logger.info("loop", "Cognitive loop stopped");
  }

  /** Stop the loop gracefully. */
  stop(): void {
    this._running = false;
  }

  /** Run a single PEAR cycle. Exposed for testing. */
  async runOneCycle(): Promise<Result<CycleResult, EidolonError>> {
    // Reset hourly budget if needed
    this.energyBudget.resetIfNewHour();

    // 1. PERCEIVE
    if (this.stateMachine.state.phase !== "perceiving") {
      const perceiveTransition = this.stateMachine.transition("perceiving");
      if (!perceiveTransition.ok) {
        this.logger.warn("loop", `State transition to 'perceiving' failed: ${perceiveTransition.error.message}`);
      }
    }
    const dequeueResult = this.eventBus.dequeue();
    if (!dequeueResult.ok) {
      return Err(dequeueResult.error);
    }

    const event = dequeueResult.value;

    if (!event) {
      // Nothing to do — rest
      const restTransition = this.stateMachine.transition("resting");
      if (!restTransition.ok) {
        this.logger.warn("loop", `State transition to 'resting' failed: ${restTransition.error.message}`);
      }
      const restMs = this.restCalculator.calculate({
        lastUserActivityAt: this.lastUserActivityAt,
        hasPendingEvents: false,
        hasPendingLearning: false,
        isBusinessHours: this.isBusinessHours(),
      });
      await this.sleep(restMs);
      this.stats.totalRestMs += restMs;
      this.stats.totalCycles++;
      this.stats.lastCycleAt = Date.now();
      return Ok({
        hadEvent: false,
        action: null,
        tokensUsed: 0,
        restMs,
        deferred: false,
      });
    }

    // Update last user activity if it's a user event
    if (event.type.startsWith("user:")) {
      this.lastUserActivityAt = Date.now();
    }

    // 2. EVALUATE
    const evalTransition = this.stateMachine.transition("evaluating");
    if (!evalTransition.ok) {
      this.logger.warn("loop", `State transition to 'evaluating' failed: ${evalTransition.error.message}`);
    }
    const priority = this.evaluator.evaluate(event);
    const category = this.actionCategories[priority.suggestedAction] ?? "user";

    // Check energy budget (actual user interaction events always proceed)
    const isUserInteraction = event.type.startsWith("user:");
    if (!isUserInteraction && !this.energyBudget.canAfford(category)) {
      this.eventBus.defer(event.id);
      this.stats.eventsDeferred++;
      this.stats.totalCycles++;
      this.stats.lastCycleAt = Date.now();
      const deferActResult = this.stateMachine.transition("acting");
      if (!deferActResult.ok) {
        this.logger.warn("loop", `State transition to 'acting' (defer) failed: ${deferActResult.error.message}`);
      }
      const deferReflectResult = this.stateMachine.transition("reflecting");
      if (!deferReflectResult.ok) {
        this.logger.warn(
          "loop",
          `State transition to 'reflecting' (defer) failed: ${deferReflectResult.error.message}`,
        );
      }
      const deferClearResult = this.stateMachine.clearAction();
      if (!deferClearResult.ok) {
        this.logger.warn("loop", `clearAction (defer) failed: ${deferClearResult.error.message}`);
      }
      this.stateMachine.completeCycle();
      return Ok({
        hadEvent: true,
        action: null,
        tokensUsed: 0,
        restMs: 0,
        deferred: true,
      });
    }

    // 3. ACT
    const actTransition = this.stateMachine.transition("acting");
    if (!actTransition.ok) {
      this.logger.warn("loop", `State transition to 'acting' failed: ${actTransition.error.message}`);
    }
    const setActionResult = this.stateMachine.setAction(priority.suggestedAction);
    if (!setActionResult.ok) {
      this.logger.warn("loop", `setAction failed: ${setActionResult.error.message}`);
    }

    let tokensUsed = this.defaultTokenEstimate;
    let handlerSucceeded = true;
    if (this.handler) {
      try {
        const result = await this.handler(event, priority);
        tokensUsed = result.tokensUsed || this.defaultTokenEstimate;
        if (!result.success) {
          handlerSucceeded = false;
          this.logger.warn("loop", `Handler failed for ${event.type}: ${result.error}`);
        }
      } catch (err: unknown) {
        handlerSucceeded = false;
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.error("loop", `Handler threw for ${event.type}: ${errorMessage}`);
      }
    }

    // Only mark as processed on success; defer on failure
    if (handlerSucceeded) {
      this.eventBus.markProcessed(event.id);
    } else {
      this.eventBus.defer(event.id);
    }

    // 4. REFLECT
    const reflectTransition = this.stateMachine.transition("reflecting");
    if (!reflectTransition.ok) {
      this.logger.warn("loop", `State transition to 'reflecting' failed: ${reflectTransition.error.message}`);
    }
    const clearResult = this.stateMachine.clearAction();
    if (!clearResult.ok) {
      this.logger.warn("loop", `clearAction failed: ${clearResult.error.message}`);
    }
    if (handlerSucceeded) {
      this.energyBudget.consume(category, tokensUsed);
      this.stats.eventsProcessed++;
      this.stats.totalTokensUsed += tokensUsed;
    } else {
      this.stats.eventsFailed++;
    }
    this.stats.totalCycles++;
    this.stats.lastCycleAt = Date.now();
    this.stateMachine.completeCycle();

    return Ok({
      hadEvent: true,
      action: priority.suggestedAction,
      tokensUsed,
      restMs: 0,
      deferred: false,
    });
  }

  /** Get whether the loop is running. */
  get running(): boolean {
    return this._running;
  }

  /** Get cycle statistics. */
  getStats(): LoopStats {
    return { ...this.stats };
  }

  /** Check if current time is business hours (8-18). */
  private isBusinessHours(): boolean {
    const hour = new Date().getHours();
    return hour >= BUSINESS_HOURS_START && hour < BUSINESS_HOURS_END;
  }

  /** Sleep for the specified duration. Resolves early if stopped. Always yields at least one tick.
   *  Uses AbortController to cleanly cancel the timer when the loop stops. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (ms <= 0) {
        // Yield to the event loop even for zero-ms sleep
        setTimeout(resolve, 0);
        return;
      }

      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(mainTimer);
        clearInterval(checkInterval);
        resolve();
      };

      const mainTimer = setTimeout(finish, ms);
      // Poll for early exit if loop is stopped during sleep
      const checkInterval = setInterval(() => {
        if (!this._running) {
          finish();
        }
      }, SLEEP_POLL_INTERVAL_MS);
    });
  }
}
