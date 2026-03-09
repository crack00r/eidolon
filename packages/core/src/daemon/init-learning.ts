/**
 * Learning module initialization and scheduler wiring.
 *
 * When learning is enabled in config, initializes the CrawlerRegistry,
 * DiscoveryEngine, RelevanceFilter, and SafetyClassifier, then schedules
 * periodic crawl runs via the TaskScheduler.
 *
 * Step 17d in the daemon initialization sequence (after AnticipationEngine).
 */

import type { CrawledItem } from "../learning/crawlers/index.ts";
import { CrawlerRegistry } from "../learning/crawlers/index.ts";
import { DiscoveryEngine } from "../learning/discovery.ts";
import { RelevanceFilter } from "../learning/relevance.ts";
import { SafetyClassifier } from "../learning/safety.ts";
import type { InitializedModules } from "./types.ts";

type InitStep = { name: string; fn: () => Promise<void> | void };

/** Maximum number of items to crawl per source per run. */
const MAX_ITEMS_PER_SOURCE = 20;

/** Default crawl interval in minutes when not specified per-source. */
const DEFAULT_CRAWL_INTERVAL_MINUTES = 360;

/**
 * Build the init step for the learning module scheduler.
 */
export function buildLearningSteps(modules: InitializedModules): InitStep[] {
  const steps: InitStep[] = [];

  steps.push({
    name: "LearningScheduler",
    fn: () => {
      const logger = modules.logger;
      const config = modules.config;
      const dbManager = modules.dbManager;
      const eventBus = modules.eventBus;
      const taskScheduler = modules.taskScheduler;

      if (!logger || !config || !dbManager || !eventBus) {
        logger?.warn("daemon", "LearningScheduler skipped: missing dependencies");
        return;
      }

      if (!config.learning.enabled) {
        logger.info("daemon", "LearningScheduler skipped: learning not enabled in config");
        return;
      }

      const sources = config.learning.sources;
      if (sources.length === 0) {
        logger.info("daemon", "LearningScheduler skipped: no learning sources configured");
        return;
      }

      // Initialize learning sub-modules
      const crawlerRegistry = new CrawlerRegistry(logger);
      const discoveryEngine = new DiscoveryEngine(dbManager.operational, logger);
      const relevanceFilter = new RelevanceFilter(config.learning.relevance, logger);
      const safetyClassifier = new SafetyClassifier(logger);

      logger.info("daemon", `Learning module initialized (${sources.length} source(s))`, {
        sources: sources.map((s) => s.type),
      });

      // Wire EventBus handler for learning:crawl events
      eventBus.subscribe("learning:crawl", () => {
        runLearningCrawl(modules, crawlerRegistry, discoveryEngine, relevanceFilter, safetyClassifier).catch(
          (err: unknown) => {
            logger.error("learning", `Learning crawl failed: ${err instanceof Error ? err.message : String(err)}`);
          },
        );
      });

      // Schedule periodic crawl runs via TaskScheduler
      if (taskScheduler) {
        const listResult = taskScheduler.list();
        const alreadyExists = listResult.ok && listResult.value.some((t) => t.action === "learning:crawl");

        if (!alreadyExists) {
          // Use the shortest source schedule, or default interval
          const intervalMinutes = DEFAULT_CRAWL_INTERVAL_MINUTES;
          const createResult = taskScheduler.create({
            name: "Learning Crawl",
            type: "recurring",
            cron: `*/${intervalMinutes} * * * *`,
            action: "learning:crawl",
            payload: {},
          });
          if (createResult.ok) {
            logger.info("daemon", `Learning crawl scheduled every ${intervalMinutes} minutes`);
          } else {
            logger.error("daemon", `Failed to schedule learning crawl: ${createResult.error.message}`);
          }
        } else {
          logger.debug("daemon", "Learning crawl task already exists");
        }
      }
    },
  });

  return steps;
}

/**
 * Execute a single learning crawl run: crawl all sources, filter by relevance
 * and safety, then store discoveries.
 */
async function runLearningCrawl(
  modules: InitializedModules,
  crawlerRegistry: CrawlerRegistry,
  discoveryEngine: DiscoveryEngine,
  relevanceFilter: RelevanceFilter,
  safetyClassifier: SafetyClassifier,
): Promise<void> {
  const logger = modules.logger;
  const config = modules.config;
  if (!logger || !config) return;

  const sources = config.learning.sources;
  logger.info("learning", `Starting learning crawl (${sources.length} source(s))`);

  // Check daily budget
  const budgetResult = discoveryEngine.countToday();
  if (budgetResult.ok && budgetResult.value >= config.learning.budget.maxDiscoveriesPerDay) {
    logger.info("learning", "Daily discovery budget reached, skipping crawl", {
      count: budgetResult.value,
      max: config.learning.budget.maxDiscoveriesPerDay,
    });
    return;
  }

  const crawlConfigs = sources.map((s) => ({
    type: s.type,
    config: s.config,
  }));

  const crawlResult = await crawlerRegistry.crawlAll(crawlConfigs, {
    maxItems: MAX_ITEMS_PER_SOURCE,
  });

  if (!crawlResult.ok) {
    logger.error("learning", `Crawl failed: ${crawlResult.error.message}`);
    return;
  }

  const items = crawlResult.value;
  logger.info("learning", `Crawled ${items.length} items, filtering...`);

  let stored = 0;
  for (const item of items) {
    // Dedup: skip already-known URLs
    const knownResult = discoveryEngine.isKnown(item.url);
    if (knownResult.ok && knownResult.value) continue;

    // Relevance filter
    const relevanceResult = filterByRelevance(relevanceFilter, item);
    if (!relevanceResult.ok) continue;
    if (relevanceResult.value.score < config.learning.relevance.minScore) continue;

    // Safety classification
    const safetyResult = safetyClassifier.classify(item.title, item.content, item.sourceType);

    // Store discovery
    const createResult = discoveryEngine.create({
      sourceType: item.sourceType,
      url: item.url,
      title: item.title,
      content: item.content,
      relevanceScore: relevanceResult.value.score,
      safetyLevel: safetyResult.level,
    });

    if (createResult.ok) {
      stored++;
      // Notify via EventBus
      modules.eventBus?.publish(
        "learning:discovery",
        {
          discoveryId: createResult.value.id,
          sourceType: item.sourceType,
          title: item.title,
          url: item.url,
          relevanceScore: relevanceResult.value.score,
          safetyLevel: safetyResult.level,
        },
        { priority: "low", source: "learning" },
      );
    }

    // Re-check budget after each store
    const updatedBudget = discoveryEngine.countToday();
    if (updatedBudget.ok && updatedBudget.value >= config.learning.budget.maxDiscoveriesPerDay) {
      logger.info("learning", "Daily budget reached mid-crawl, stopping");
      break;
    }
  }

  logger.info("learning", `Learning crawl complete: ${stored} new discoveries from ${items.length} crawled items`);
}

/**
 * Run keyword-based relevance filter on a crawled item (sync, free).
 */
function filterByRelevance(
  filter: RelevanceFilter,
  item: CrawledItem,
): { ok: true; value: { score: number } } | { ok: false } {
  try {
    const result = filter.scoreKeywords(item.title, item.content);
    return { ok: true, value: { score: result.score } };
  } catch {
    return { ok: false };
  }
}
