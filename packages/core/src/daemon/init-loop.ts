/**
 * Cognitive loop init steps: SessionSupervisor, CognitiveLoop (with all PEAR
 * pipeline sub-components), DigestBuilder.
 * Steps 15-17b from the daemon initialization sequence.
 */

import { Ok } from "@eidolon/protocol";
import { AnticipationEngine } from "../anticipation/engine.ts";
import { SuggestionHistory } from "../anticipation/history.ts";
import { WorkspacePreparer } from "../claude/workspace.ts";
import { DigestBuilder } from "../digest/builder.ts";
import { CognitiveLoop } from "../loop/cognitive-loop.ts";
import { EnergyBudget } from "../loop/energy-budget.ts";
import { PriorityEvaluator } from "../loop/priority.ts";
import { RestCalculator } from "../loop/rest.ts";
import { SessionSupervisor } from "../loop/session-supervisor.ts";
import { CognitiveStateMachine } from "../loop/state-machine.ts";
import { MemoryExtractor } from "../memory/extractor.ts";
import { type ContextProvider, MemoryInjector } from "../memory/injector.ts";
import { CommunityDetector } from "../memory/knowledge-graph/communities.ts";
import { KGEntityStore } from "../memory/knowledge-graph/entities.ts";
import { KGRelationStore } from "../memory/knowledge-graph/relations.ts";
import { AutomationEngine } from "../scheduler/automation.ts";
import { TaskScheduler } from "../scheduler/scheduler.ts";
import { buildEventHandler } from "./event-handlers.ts";
import type { InitializedModules } from "./types.ts";

type InitStep = { name: string; fn: () => Promise<void> | void };

export function buildLoopSteps(modules: InitializedModules): InitStep[] {
  const steps: InitStep[] = [];

  // 15. SessionSupervisor (needs Logger)
  steps.push({
    name: "SessionSupervisor",
    fn: () => {
      const logger = modules.logger;
      if (!logger) return;

      try {
        modules.sessionSupervisor = new SessionSupervisor(logger);
        logger.info("daemon", "SessionSupervisor initialized");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("daemon", `SessionSupervisor skipped: ${message}`);
      }
    },
  });

  // 16. CognitiveLoop and PEAR pipeline dependencies
  steps.push({
    name: "CognitiveLoop",
    fn: () => {
      const logger = modules.logger;
      const config = modules.config;
      const eventBus = modules.eventBus;
      const supervisor = modules.sessionSupervisor;
      const dbManager = modules.dbManager;

      if (!logger || !config || !eventBus || !supervisor) {
        logger?.warn(
          "daemon",
          "CognitiveLoop skipped: missing required dependencies (Logger, Config, EventBus, or SessionSupervisor)",
        );
        return;
      }

      // 16a. CognitiveStateMachine
      modules.cognitiveStateMachine = new CognitiveStateMachine(logger);

      // 16b. PriorityEvaluator
      modules.priorityEvaluator = new PriorityEvaluator(logger);

      // 16c. EnergyBudget
      modules.energyBudget = new EnergyBudget(config.loop.energyBudget, logger);

      // 16d. RestCalculator
      modules.restCalculator = new RestCalculator(config.loop.rest, logger);

      // 16e. TaskScheduler + AutomationEngine
      if (dbManager) {
        modules.taskScheduler = new TaskScheduler(dbManager.operational, logger);
        modules.automationEngine = new AutomationEngine(modules.taskScheduler, dbManager.operational, logger);
        logger.info("daemon", "TaskScheduler and AutomationEngine initialized");

        const SCHEDULER_POLL_INTERVAL_MS = 30_000;
        modules.schedulerInterval = setInterval(() => {
          if (!modules.taskScheduler || !modules.eventBus) return;
          const dueResult = modules.taskScheduler.getDueTasks();
          if (!dueResult.ok) {
            logger.error("daemon", `Scheduler poll error: ${dueResult.error.message}`);
            return;
          }
          for (const task of dueResult.value) {
            if (task.action === "automation") {
              const payload = task.payload as Record<string, unknown>;
              const publishResult = modules.eventBus.publish(
                "scheduler:automation_due",
                {
                  automationId: task.id,
                  name: task.name,
                  prompt: String(payload.prompt ?? ""),
                  deliverTo: String(payload.deliverTo ?? "telegram"),
                },
                {
                  priority: "normal",
                  source: "scheduler",
                },
              );
              if (publishResult.ok) {
                logger.debug("daemon", `Scheduler emitted automation_due: ${task.name}`, { taskId: task.id });
                modules.taskScheduler.markExecuted(task.id);
              }
            } else {
              const publishResult = modules.eventBus.publish(
                "scheduler:task_due",
                {
                  taskId: task.id,
                  taskName: task.name,
                  action: task.action,
                  payload: task.payload,
                },
                {
                  priority: "normal",
                  source: "scheduler",
                },
              );
              if (publishResult.ok) {
                logger.debug("daemon", `Scheduler emitted task_due for: ${task.name}`, { taskId: task.id });
                modules.taskScheduler.markExecuted(task.id);
              }
            }
          }
        }, SCHEDULER_POLL_INTERVAL_MS);
      } else {
        logger.warn("daemon", "TaskScheduler skipped: database not available");
      }

      // 16f. MemoryExtractor (optionally wired to MemoryConsolidator)
      const extractionStrategy = config.memory.extraction.strategy;
      modules.memoryExtractor = new MemoryExtractor(logger, {
        strategy: extractionStrategy,
        consolidator: modules.memoryConsolidator,
      });
      logger.info(
        "daemon",
        `MemoryExtractor initialized (strategy: ${extractionStrategy}, consolidator: ${modules.memoryConsolidator ? "yes" : "no"})`,
      );

      // 16f-ii. WorkspacePreparer (needs Logger)
      modules.workspacePreparer = new WorkspacePreparer(logger);
      logger.info("daemon", "WorkspacePreparer initialized");

      // 16f-iii-a. Knowledge Graph stores (need memory DB)
      if (modules.dbManager) {
        modules.kgEntityStore = new KGEntityStore(modules.dbManager.memory, logger);
        modules.kgRelationStore = new KGRelationStore(modules.dbManager.memory, logger);
        modules.communityDetector = new CommunityDetector(modules.dbManager.memory, logger);
        logger.info("daemon", "Knowledge Graph stores initialized (entities, relations, communities)");
      }

      // 16f-iii. MemoryInjector (needs MemoryStore, MemorySearch, Logger)
      if (modules.memoryStore && modules.memorySearch) {
        const contextProviders: ContextProvider[] = [];

        if (modules.profileGenerator) {
          const profileGen = modules.profileGenerator;
          contextProviders.push(() => {
            try {
              const section = profileGen.getProfileSection();
              return Ok(section);
            } catch {
              return Ok(""); // Gracefully degrade if profile generation fails
            }
          });
          logger.info("daemon", "UserProfileGenerator wired as MemoryInjector context provider");
        }

        modules.memoryInjector = new MemoryInjector(
          modules.memoryStore,
          modules.memorySearch,
          modules.kgEntityStore ?? null,
          modules.kgRelationStore ?? null,
          logger,
          { contextProviders },
          modules.communityDetector ?? null,
        );
        logger.info("daemon", "MemoryInjector initialized (KG: entities=%s, relations=%s, communities=%s)", {
          entities: !!modules.kgEntityStore,
          relations: !!modules.kgRelationStore,
          communities: !!modules.communityDetector,
        });
      } else {
        logger.warn("daemon", "MemoryInjector skipped: MemoryStore or MemorySearch not available");
      }

      // 16g. CognitiveLoop -- build the event handler
      const handler = buildEventHandler(modules);

      modules.cognitiveLoop = new CognitiveLoop(
        eventBus,
        modules.cognitiveStateMachine,
        modules.priorityEvaluator,
        modules.energyBudget,
        modules.restCalculator,
        supervisor,
        logger,
        { handler },
      );

      logger.info("daemon", "CognitiveLoop instantiated (not started -- call start() to begin PEAR cycle)");
    },
  });

  // 17b. DigestBuilder (needs Config, Logger, DatabaseManager, TaskScheduler)
  steps.push({
    name: "DigestBuilder",
    fn: () => {
      const logger = modules.logger;
      const config = modules.config;
      const dbManager = modules.dbManager;
      const taskScheduler = modules.taskScheduler;

      if (!config || !logger || !dbManager) {
        logger?.warn("daemon", "DigestBuilder skipped: missing dependencies");
        return;
      }

      if (!config.digest.enabled) {
        logger.info("daemon", "DigestBuilder skipped: digest not enabled in config");
        return;
      }

      modules.digestBuilder = new DigestBuilder({
        operationalDb: dbManager.operational,
        memoryDb: dbManager.memory,
        logger,
        config: config.digest,
      });
      logger.info("daemon", "DigestBuilder initialized");

      if (taskScheduler) {
        const listResult = taskScheduler.list();
        const alreadyExists = listResult.ok && listResult.value.some((t) => t.action === "digest:generate");
        if (!alreadyExists) {
          const createResult = taskScheduler.create({
            name: "Daily Digest",
            type: "recurring",
            cron: config.digest.time,
            action: "digest:generate",
            payload: {},
          });
          if (createResult.ok) {
            logger.info("daemon", `Digest scheduled daily at ${config.digest.time} (${config.digest.timezone})`);
          } else {
            logger.error("daemon", `Failed to schedule digest: ${createResult.error.message}`);
          }
        } else {
          logger.debug("daemon", "Digest scheduled task already exists");
        }
      }
    },
  });

  // 17c. AnticipationEngine (needs Config, Logger, MemorySearch, ProfileGenerator, EventBus, DB)
  steps.push({
    name: "AnticipationEngine",
    fn: () => {
      const logger = modules.logger;
      const config = modules.config;
      const dbManager = modules.dbManager;
      const eventBus = modules.eventBus;
      const memorySearch = modules.memorySearch;
      const profileGenerator = modules.profileGenerator;
      const taskScheduler = modules.taskScheduler;

      if (!config || !logger || !dbManager || !eventBus || !memorySearch || !profileGenerator) {
        logger?.warn("daemon", "AnticipationEngine skipped: missing dependencies");
        return;
      }

      if (!config.anticipation.enabled) {
        logger.info("daemon", "AnticipationEngine skipped: anticipation not enabled in config");
        return;
      }

      // Initialize SuggestionHistory
      modules.suggestionHistory = new SuggestionHistory(dbManager.operational, logger);

      // Initialize engine
      modules.anticipationEngine = new AnticipationEngine({
        memorySearch,
        calendarManager: modules.calendarManager ?? null,
        profileGenerator,
        kgEntityStore: modules.kgEntityStore ?? null,
        kgRelationStore: modules.kgRelationStore ?? null,
        history: modules.suggestionHistory,
        eventBus,
        config: config.anticipation,
        logger,
      });

      logger.info("daemon", "AnticipationEngine initialized");

      // Register recurring scheduled task for anticipation checks
      if (taskScheduler) {
        const listResult = taskScheduler.list();
        const alreadyExists = listResult.ok && listResult.value.some((t) => t.action === "anticipation:check");
        if (!alreadyExists) {
          const intervalMinutes = config.anticipation.checkIntervalMinutes;
          const createResult = taskScheduler.create({
            name: "Anticipation Check",
            type: "recurring",
            cron: `*/${intervalMinutes}`,
            action: "anticipation:check",
            payload: {},
          });
          if (createResult.ok) {
            logger.info("daemon", `Anticipation check scheduled every ${intervalMinutes} minutes`);
          } else {
            logger.error("daemon", `Failed to schedule anticipation check: ${createResult.error.message}`);
          }
        } else {
          logger.debug("daemon", "Anticipation check task already exists");
        }
      }
    },
  });

  return steps;
}
