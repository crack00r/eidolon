/**
 * HAManager -- central coordinator for Home Automation integration.
 *
 * Responsibilities:
 *   - Sync entity state from Home Assistant into the local cache (ha_entities)
 *   - Monitor state changes and publish events
 *   - Run anomaly detection rules against current entity states
 *   - Generate HA context for MEMORY.md injection
 *   - Provide entity listing / state queries for the gateway RPC layer
 *
 * The actual HA service execution is delegated to the MCP server
 * (mcp-server-home-assistant). This module only handles entity caching,
 * monitoring, policy checks, and context injection.
 */

import type { Database } from "bun:sqlite";
import type {
  EidolonError,
  HAAnomaly,
  HAEntity,
  HAServiceResult,
  HAStateChange,
  HomeAutomationConfig,
  Result,
} from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import type { EmbeddingModel } from "../memory/embeddings.ts";
import type { HAEntityRow } from "./manager-utils.ts";
import {
  capitalizeFirst,
  evaluateCondition,
  interpolateMessage,
  matchesPattern,
  rowToEntity,
  sanitize,
} from "./manager-utils.ts";
import { HAPolicyChecker } from "./policies.ts";
import { HAEntityResolver } from "./resolver.ts";
import { HASceneEngine } from "./scenes.ts";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Safe pattern for HA identifiers (entity_id, domain, service). */
const HA_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface HAManagerDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly config: HomeAutomationConfig;
  readonly embeddingModel?: EmbeddingModel;
}

// ---------------------------------------------------------------------------
// HAManager
// ---------------------------------------------------------------------------

export class HAManager {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly config: HomeAutomationConfig;

  readonly policyChecker: HAPolicyChecker;
  readonly resolver: HAEntityResolver;
  readonly sceneEngine: HASceneEngine;

  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private previousStates: Map<string, string> = new Map();

  constructor(deps: HAManagerDeps) {
    this.db = deps.db;
    this.logger = deps.logger.child("ha-manager");
    this.eventBus = deps.eventBus;
    this.config = deps.config;

    this.policyChecker = new HAPolicyChecker(deps.config, deps.logger);
    this.resolver = new HAEntityResolver(deps.db, deps.logger, deps.embeddingModel);
    this.sceneEngine = new HASceneEngine(deps.db, deps.logger, deps.eventBus);
  }

  /** Start periodic entity sync and load initial state. */
  async initialize(): Promise<Result<void, EidolonError>> {
    if (!this.config.enabled) {
      this.logger.info("initialize", "Home automation integration disabled");
      return Ok(undefined);
    }

    // Load existing entities into previousStates map
    const entitiesResult = this.listEntities();
    if (entitiesResult.ok) {
      for (const entity of entitiesResult.value) {
        this.previousStates.set(entity.entityId, entity.state);
      }
    }

    // Start periodic sync
    const intervalMs = this.config.syncIntervalMinutes * 60_000;
    this.syncInterval = setInterval(() => {
      const result = this.checkAnomalies();
      if (!result.ok) {
        this.logger.error("checkAnomalies", "Anomaly detection failed", result.error);
      } else if (result.value.length > 0) {
        this.logger.warn("checkAnomalies", `Detected ${result.value.length} anomalie(s)`, {
          entities: result.value.map((a) => a.entityId),
        });
      }
    }, intervalMs);
    this.syncInterval.unref();

    this.logger.info("initialize", `HA manager initialized (sync every ${this.config.syncIntervalMinutes}m)`);
    return Ok(undefined);
  }

  // -----------------------------------------------------------------------
  // Entity cache
  // -----------------------------------------------------------------------

  /** List all cached entities, optionally filtered by domain. */
  listEntities(domain?: string): Result<HAEntity[], EidolonError> {
    try {
      const query = domain
        ? "SELECT * FROM ha_entities WHERE domain = ? ORDER BY friendly_name ASC"
        : "SELECT * FROM ha_entities ORDER BY friendly_name ASC";

      const rows = domain
        ? (this.db.query(query).all(domain) as HAEntityRow[])
        : (this.db.query(query).all() as HAEntityRow[]);

      return Ok(rows.map(rowToEntity));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list HA entities", cause));
    }
  }

  /** Get a single entity by ID from the cache. */
  getEntity(entityId: string): Result<HAEntity | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM ha_entities WHERE entity_id = ?").get(entityId) as HAEntityRow | null;

      if (!row) return Ok(null);
      return Ok(rowToEntity(row));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get entity: ${entityId}`, cause));
    }
  }

  /**
   * Upsert entities from an external sync (e.g. MCP tool result).
   * Detects state changes and publishes events.
   */
  syncEntities(entities: readonly HAEntity[]): Result<number, EidolonError> {
    try {
      const now = Date.now();
      const changes: HAStateChange[] = [];

      const upsertStmt = this.db.query(
        `INSERT INTO ha_entities (entity_id, domain, friendly_name, state, attributes, last_changed, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET
           domain = excluded.domain,
           friendly_name = excluded.friendly_name,
           state = excluded.state,
           attributes = excluded.attributes,
           last_changed = excluded.last_changed,
           synced_at = excluded.synced_at`,
      );

      const upsertAll = this.db.transaction(() => {
        for (const entity of entities) {
          upsertStmt.run(
            entity.entityId,
            entity.domain,
            entity.friendlyName,
            entity.state,
            JSON.stringify(entity.attributes),
            entity.lastChanged,
            now,
          );
        }
      });
      upsertAll();

      for (const entity of entities) {
        const previousState = this.previousStates.get(entity.entityId);

        if (previousState !== undefined && previousState !== entity.state) {
          changes.push({
            entityId: entity.entityId,
            oldState: previousState,
            newState: entity.state,
            timestamp: now,
          });
        }

        this.previousStates.set(entity.entityId, entity.state);
      }

      // Publish state change events
      for (const change of changes) {
        this.eventBus.publish("ha:state_changed", change, {
          source: "ha-manager",
          priority: "normal",
        });
      }

      if (changes.length > 0) {
        this.logger.info("syncEntities", `Synced ${entities.length} entities, ${changes.length} state changes`);
      } else {
        this.logger.debug("syncEntities", `Synced ${entities.length} entities, no state changes`);
      }

      return Ok(entities.length);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to sync HA entities", cause));
    }
  }

  // -----------------------------------------------------------------------
  // Service execution (delegates to MCP / mock)
  // -----------------------------------------------------------------------

  /**
   * Execute a service call on an entity.
   * Checks the policy first, then delegates to the provided executor function.
   */
  async executeService(
    entityId: string,
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    executorFn?: (
      entityId: string,
      domain: string,
      service: string,
      data?: Record<string, unknown>,
    ) => Promise<Result<HAServiceResult, EidolonError>>,
  ): Promise<Result<HAServiceResult, EidolonError>> {
    // Input validation: entity_id, domain, and service must match safe patterns
    if (!HA_IDENTIFIER_PATTERN.test(entityId)) {
      return Err(createError(ErrorCode.INVALID_INPUT, `Invalid entity ID format: ${entityId.slice(0, 100)}`));
    }
    if (!HA_IDENTIFIER_PATTERN.test(domain)) {
      return Err(createError(ErrorCode.INVALID_INPUT, `Invalid domain format: ${domain.slice(0, 100)}`));
    }
    if (!HA_IDENTIFIER_PATTERN.test(service)) {
      return Err(createError(ErrorCode.INVALID_INPUT, `Invalid service format: ${service.slice(0, 100)}`));
    }

    // Policy check
    const policyResult = this.policyChecker.checkPolicy(domain, entityId, service);
    if (!policyResult.ok) return policyResult;

    const policy = policyResult.value;
    if (policy.level === "dangerous") {
      return Err(createError(ErrorCode.HA_POLICY_DENIED, `Action denied by policy: ${policy.reason}`));
    }
    if (policy.level === "needs_approval") {
      return Err(createError(ErrorCode.HA_POLICY_DENIED, `Action requires approval: ${policy.reason}`));
    }

    if (!executorFn) {
      // No executor provided -- return a success stub
      // In production, the MCP server handles actual execution
      const result: HAServiceResult = {
        entityId,
        domain,
        service,
        success: true,
      };
      return Ok(result);
    }

    return executorFn(entityId, domain, service, data);
  }

  // -----------------------------------------------------------------------
  // Anomaly detection
  // -----------------------------------------------------------------------

  /** Run anomaly detection rules against current entity states. */
  checkAnomalies(): Result<HAAnomaly[], EidolonError> {
    if (!this.config.anomalyDetection.enabled) {
      return Ok([]);
    }

    const rules = this.config.anomalyDetection.rules;
    if (rules.length === 0) return Ok([]);

    const entitiesResult = this.listEntities();
    if (!entitiesResult.ok) return entitiesResult;

    const entities = entitiesResult.value;
    const anomalies: HAAnomaly[] = [];

    for (const rule of rules) {
      const matchingEntities = entities.filter((e) => matchesPattern(e.entityId, rule.entityPattern));

      for (const entity of matchingEntities) {
        if (evaluateCondition(entity, rule.condition)) {
          const anomaly: HAAnomaly = {
            entityId: entity.entityId,
            friendlyName: entity.friendlyName,
            rule,
            detectedAt: Date.now(),
            currentState: entity.state,
            detail: interpolateMessage(rule.message, entity),
          };
          anomalies.push(anomaly);
        }
      }
    }

    // Publish anomaly events
    for (const anomaly of anomalies) {
      this.eventBus.publish("ha:anomaly_detected", anomaly, {
        source: "ha-manager",
        priority: "high",
      });
    }

    if (anomalies.length > 0) {
      this.logger.warn("checkAnomalies", `Detected ${anomalies.length} anomalies`);
    }

    return Ok(anomalies);
  }

  // -----------------------------------------------------------------------
  // Context injection
  // -----------------------------------------------------------------------

  /**
   * Generate HA state context for MEMORY.md injection.
   * Returns a formatted markdown section with current entity states.
   */
  injectStateContext(): Result<string, EidolonError> {
    const entitiesResult = this.listEntities();
    if (!entitiesResult.ok) return entitiesResult;

    const entities = entitiesResult.value;
    if (entities.length === 0) return Ok("");

    const lines: string[] = ["## Home Automation"];

    // Group by domain
    const byDomain = new Map<string, HAEntity[]>();
    for (const entity of entities) {
      const list = byDomain.get(entity.domain) ?? [];
      list.push(entity);
      byDomain.set(entity.domain, list);
    }

    // Sort domains alphabetically
    const sortedDomains = [...byDomain.keys()].sort();
    for (const domain of sortedDomains) {
      const domainEntities = byDomain.get(domain);
      if (!domainEntities || domainEntities.length === 0) continue;

      lines.push(`### ${capitalizeFirst(domain)}`);
      for (const entity of domainEntities) {
        const name = sanitize(entity.friendlyName);
        const state = sanitize(entity.state);
        lines.push(`- ${name}: ${state}`);
      }
    }

    return Ok(lines.join("\n"));
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.previousStates.clear();
    this.logger.info("dispose", "HA manager disposed");
  }
}
