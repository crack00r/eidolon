/**
 * Task executor -- handles scheduler:task_due and scheduler:automation_due events.
 *
 * Routes scheduled tasks to their appropriate execution path:
 * - "automation" tasks: spawn a Claude Code session with the prompt, deliver result
 * - "digest:generate" tasks: delegate to the digest handler
 * - Generic tasks: emit the action as an event on the EventBus for extensibility
 *
 * Records audit entries and token usage for all executed tasks.
 */

import { randomUUID } from "node:crypto";
import { loadWorkspaceTemplates } from "../claude/templates.ts";
import type { EventHandlerResult } from "../loop/cognitive-loop.ts";
import type { Logger } from "../logging/logger.ts";
import type { InitializedModules } from "./types.ts";

// ---------------------------------------------------------------------------
// Payload validation helpers
// ---------------------------------------------------------------------------

interface TaskDuePayload {
  readonly taskId: string;
  readonly taskName: string;
  readonly action: string;
  readonly payload: Record<string, unknown>;
}

interface AutomationDuePayload {
  readonly automationId: string;
  readonly name: string;
  readonly prompt: string;
  readonly deliverTo: string;
}

function parseTaskDuePayload(raw: unknown): TaskDuePayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const taskId = typeof obj.taskId === "string" ? obj.taskId : "";
  const taskName = typeof obj.taskName === "string" ? obj.taskName : "unknown";
  const action = typeof obj.action === "string" ? obj.action : "";
  const payload =
    typeof obj.payload === "object" && obj.payload !== null
      ? (obj.payload as Record<string, unknown>)
      : {};
  if (!action) return null;
  return { taskId, taskName, action, payload };
}

function parseAutomationDuePayload(raw: unknown): AutomationDuePayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const automationId = typeof obj.automationId === "string" ? obj.automationId : "";
  const name = typeof obj.name === "string" ? obj.name : "unknown";
  const prompt = typeof obj.prompt === "string" ? obj.prompt : "";
  const deliverTo = typeof obj.deliverTo === "string" ? obj.deliverTo : "telegram";
  if (!prompt) return null;
  return { automationId, name, prompt, deliverTo };
}

// ---------------------------------------------------------------------------
// Handler: scheduler:task_due
// ---------------------------------------------------------------------------

export async function handleScheduledTask(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): Promise<EventHandlerResult> {
  const parsed = parseTaskDuePayload(event.payload);
  if (!parsed) {
    logger.warn("task-executor", "Invalid scheduler:task_due payload", { eventId: event.id });
    return { success: false, tokensUsed: 0, error: "Invalid task_due payload: missing action" };
  }

  const { taskId, taskName, action, payload } = parsed;
  logger.info("task-executor", `Executing scheduled task: "${taskName}" (action: ${action})`, {
    taskId,
    action,
  });

  // Audit the task execution start
  modules.auditLogger?.log({
    actor: "scheduler",
    action: "task_execute",
    target: taskId || taskName,
    result: "success",
    details: { action, taskName },
  });

  try {
    // Route by action type
    switch (action) {
      case "digest:generate": {
        // Delegate to EventBus -- the digest:generate handler will pick it up
        if (modules.eventBus) {
          modules.eventBus.publish(
            "digest:generate",
            { triggeredByTask: taskId },
            { priority: "normal", source: "scheduler" },
          );
          logger.info("task-executor", `Digest generation triggered by task "${taskName}"`);
        }
        return { success: true, tokensUsed: 0 };
      }

      case "automation": {
        // Automation tasks carry a prompt in their payload
        const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
        const deliverTo = typeof payload.deliverTo === "string" ? payload.deliverTo : "telegram";
        if (!prompt) {
          logger.warn("task-executor", "Automation task has empty prompt", { taskId });
          return { success: false, tokensUsed: 0, error: "Automation task has empty prompt" };
        }
        return executeClaudeTask(modules, {
          sessionLabel: `task-${taskId || randomUUID()}`,
          prompt,
          deliverTo,
          taskName,
          taskId,
          logger,
        });
      }

      default: {
        // Generic action: emit as an event on the EventBus.
        // This enables extensibility -- plugins or other handlers can subscribe.
        if (modules.eventBus) {
          const publishResult = modules.eventBus.publish(
            action as Parameters<typeof modules.eventBus.publish>[0],
            { triggeredByTask: taskId, taskName, ...payload },
            { priority: "normal", source: "scheduler" },
          );
          if (publishResult.ok) {
            logger.info("task-executor", `Task "${taskName}" emitted event: ${action}`, { taskId });
          } else {
            logger.warn("task-executor", `Failed to emit event for task "${taskName}": ${publishResult.error.message}`);
          }
        } else {
          logger.warn("task-executor", `EventBus not available to emit action: ${action}`, { taskId });
        }
        return { success: true, tokensUsed: 0 };
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("task-executor", `Task "${taskName}" execution failed: ${errMsg}`);
    modules.auditLogger?.log({
      actor: "scheduler",
      action: "task_execute",
      target: taskId || taskName,
      result: "failure",
      details: { action, taskName, error: errMsg },
    });
    return { success: false, tokensUsed: 0, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Handler: scheduler:automation_due
// ---------------------------------------------------------------------------

export async function handleAutomationDue(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): Promise<EventHandlerResult> {
  const parsed = parseAutomationDuePayload(event.payload);
  if (!parsed) {
    logger.warn("task-executor", "Invalid scheduler:automation_due payload", { eventId: event.id });
    return { success: false, tokensUsed: 0, error: "Invalid automation_due payload: missing prompt" };
  }

  const { automationId, name, prompt, deliverTo } = parsed;
  logger.info("task-executor", `Executing automation: "${name}"`, {
    automationId,
    deliverTo,
    promptLength: prompt.length,
  });

  return executeClaudeTask(modules, {
    sessionLabel: `automation-${automationId || randomUUID()}`,
    prompt,
    deliverTo,
    taskName: name,
    taskId: automationId,
    logger,
  });
}

// ---------------------------------------------------------------------------
// Shared: spawn Claude Code session for a task/automation prompt
// ---------------------------------------------------------------------------

interface ClaudeTaskParams {
  readonly sessionLabel: string;
  readonly prompt: string;
  readonly deliverTo: string;
  readonly taskName: string;
  readonly taskId: string;
  readonly logger: Logger;
}

async function executeClaudeTask(
  modules: InitializedModules,
  params: ClaudeTaskParams,
): Promise<EventHandlerResult> {
  const { sessionLabel, prompt, deliverTo, taskName, taskId, logger } = params;
  const config = modules.config;
  const claudeManager = modules.claudeManager;
  const workspacePreparer = modules.workspacePreparer;
  const messageRouter = modules.messageRouter;

  if (!config || !claudeManager || !workspacePreparer) {
    logger.warn("task-executor", "Cannot execute task: missing modules (config, claudeManager, or workspacePreparer)");
    return { success: false, tokensUsed: 0, error: "Required modules not initialized" };
  }

  const sessionId = `${sessionLabel}-${randomUUID().slice(0, 8)}`;

  // Audit task start
  modules.auditLogger?.log({
    actor: "scheduler",
    action: "task_claude_start",
    target: taskId || taskName,
    result: "success",
    details: { taskName, promptLength: prompt.length, deliverTo },
  });

  // 1. Load workspace templates for a "task" session
  const templateResult = await loadWorkspaceTemplates({
    ownerName: config.identity.ownerName,
    currentTime: new Date().toISOString(),
    channelId: deliverTo,
    sessionType: "task",
  });

  let claudeMd: string;
  let soulMd: string | undefined;
  if (templateResult.ok) {
    claudeMd = templateResult.value.claudeMd;
    soulMd = templateResult.value.soulMd || undefined;
  } else {
    claudeMd = [
      "# Eidolon Task Session",
      "",
      `You are Eidolon, executing a scheduled task for ${config.identity.ownerName}.`,
      `Current time: ${new Date().toISOString()}`,
      "",
      "## Instructions",
      "- Complete the task described in the prompt.",
      "- Provide a clear, concise result.",
      "- Do not ask follow-up questions.",
      "",
    ].join("\n");
  }

  // 2. Generate MEMORY.md if available
  let memoryMdContent = "# Memory Context\n\nScheduled task session.\n";
  if (modules.memoryInjector) {
    const memResult = await modules.memoryInjector.generateMemoryMd({
      query: prompt,
      staticContext: `User: ${config.identity.ownerName}\nTime: ${new Date().toISOString()}\nTask: ${taskName}`,
    });
    if (memResult.ok) {
      memoryMdContent = memResult.value;
    }
  }

  // 3. Prepare workspace
  const prepareResult = await workspacePreparer.prepare(sessionId, {
    claudeMd,
    soulMd,
    additionalFiles: { "MEMORY.md": memoryMdContent },
  });

  if (!prepareResult.ok) {
    logger.error("task-executor", `Workspace preparation failed for task "${taskName}": ${prepareResult.error.message}`);
    return { success: false, tokensUsed: 0, error: prepareResult.error.message };
  }

  const workspaceDir = prepareResult.value;

  try {
    // 4. Invoke Claude Code
    const responseChunks: string[] = [];

    for await (const streamEvent of claudeManager.run(prompt, {
      sessionId,
      workspaceDir,
      model: config.brain.model.default,
      timeoutMs: config.brain.session.timeoutMs,
    })) {
      if (streamEvent.type === "text" && streamEvent.content) {
        responseChunks.push(streamEvent.content);
      } else if (streamEvent.type === "error") {
        logger.error("task-executor", `Claude stream error in task "${taskName}": ${streamEvent.error ?? "unknown"}`);
      }
    }

    const responseText = responseChunks.join("");

    if (responseText.length === 0) {
      logger.warn("task-executor", `Claude returned empty response for task "${taskName}"`);
      return { success: true, tokensUsed: 0 };
    }

    // 5. Deliver result to the target channel
    if (messageRouter) {
      const formattedMessage = `**Scheduled Task: ${taskName}**\n\n${responseText}`;
      const sendResult = await messageRouter.sendNotification(
        {
          id: `task-result-${randomUUID()}`,
          channelId: deliverTo,
          text: formattedMessage,
          format: "markdown",
        },
        "normal",
      );
      if (!sendResult.ok) {
        logger.error("task-executor", `Failed to deliver task result to ${deliverTo}: ${sendResult.error.message}`);
      }
    } else {
      logger.warn("task-executor", "MessageRouter not available -- task result not delivered", {
        taskName,
        responseLength: responseText.length,
      });
    }

    // 6. Record token usage
    const estimatedInput = Math.ceil(prompt.length / 4);
    const estimatedOutput = Math.ceil(responseText.length / 4);
    const totalTokens = estimatedInput + estimatedOutput;

    if (modules.tokenTracker) {
      modules.tokenTracker.record({
        sessionId,
        sessionType: "task",
        model: config.brain.model.default,
        inputTokens: estimatedInput,
        outputTokens: estimatedOutput,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        timestamp: Date.now(),
      });
    }

    // 7. Audit completion
    modules.auditLogger?.log({
      actor: "scheduler",
      action: "task_claude_complete",
      target: taskId || taskName,
      result: "success",
      details: { taskName, responseLength: responseText.length, tokensUsed: totalTokens },
    });

    logger.info("task-executor", `Task "${taskName}" completed`, {
      taskId,
      responseLength: responseText.length,
      tokensUsed: totalTokens,
    });

    return { success: true, tokensUsed: totalTokens };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("task-executor", `Claude execution failed for task "${taskName}": ${errMsg}`);
    modules.auditLogger?.log({
      actor: "scheduler",
      action: "task_claude_complete",
      target: taskId || taskName,
      result: "failure",
      details: { taskName, error: errMsg },
    });
    return { success: false, tokensUsed: 0, error: errMsg };
  } finally {
    workspacePreparer.cleanup(sessionId);
  }
}
