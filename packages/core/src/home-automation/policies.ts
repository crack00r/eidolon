/**
 * Per-domain security policies for Home Automation actions.
 *
 * Determines whether an HA action (e.g. turn_on a light, lock a door)
 * is safe, needs_approval, or dangerous, based on configurable domain
 * policies with entity-level exceptions.
 */

import type { HADomainPolicy, HASecurityLevel, HomeAutomationConfig, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Default policies (applied when no config override exists)
// ---------------------------------------------------------------------------

const DEFAULT_DOMAIN_POLICIES: ReadonlyArray<HADomainPolicy> = [
  { domain: "light", level: "safe" },
  { domain: "switch", level: "safe" },
  { domain: "sensor", level: "safe" },
  { domain: "climate", level: "needs_approval" },
  { domain: "lock", level: "needs_approval" },
  { domain: "alarm_control_panel", level: "dangerous" },
  { domain: "cover", level: "safe" },
  { domain: "media_player", level: "safe" },
  { domain: "fan", level: "safe" },
  { domain: "vacuum", level: "safe" },
  { domain: "camera", level: "needs_approval" },
  { domain: "automation", level: "needs_approval" },
  { domain: "script", level: "needs_approval" },
];

// ---------------------------------------------------------------------------
// Policy check result
// ---------------------------------------------------------------------------

export interface PolicyCheckResult {
  readonly level: HASecurityLevel;
  readonly domain: string;
  readonly entityId: string | undefined;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// HAPolicyChecker
// ---------------------------------------------------------------------------

export class HAPolicyChecker {
  private readonly policies: Map<string, HADomainPolicy>;
  private readonly logger: Logger;

  constructor(config: HomeAutomationConfig, logger: Logger) {
    this.logger = logger.child("ha-policies");
    this.policies = new Map<string, HADomainPolicy>();

    // Populate from config (if provided), then fill in defaults for missing domains
    for (const policy of config.domainPolicies) {
      this.policies.set(policy.domain, policy);
    }
    for (const defaultPolicy of DEFAULT_DOMAIN_POLICIES) {
      if (!this.policies.has(defaultPolicy.domain)) {
        this.policies.set(defaultPolicy.domain, defaultPolicy);
      }
    }

    this.logger.debug("init", `Loaded ${this.policies.size} domain policies`);
  }

  /**
   * Check whether a specific action is allowed, needs approval, or is dangerous.
   *
   * Resolution order:
   *   1. Entity-level exception (if defined in the policy's exceptions map)
   *   2. Domain-level policy
   *   3. Fallback to "needs_approval" for unknown domains
   */
  checkPolicy(domain: string, entityId?: string, service?: string): Result<PolicyCheckResult, never> {
    const policy = this.policies.get(domain);

    // Unknown domain -> conservative fallback
    if (!policy) {
      this.logger.debug("checkPolicy", `Unknown domain "${domain}", defaulting to needs_approval`);
      return Ok({
        level: "needs_approval",
        domain,
        entityId,
        reason: `Unknown domain "${domain}" defaults to needs_approval`,
      });
    }

    // Entity-level exception
    if (entityId && policy.exceptions) {
      const entityLevel = policy.exceptions[entityId];
      if (entityLevel !== undefined) {
        this.logger.debug("checkPolicy", `Entity exception: ${entityId} -> ${entityLevel}`);
        return Ok({
          level: entityLevel,
          domain,
          entityId,
          reason: `Entity exception for ${entityId}: ${entityLevel}`,
        });
      }
    }

    // Domain-level policy
    return Ok({
      level: policy.level,
      domain,
      entityId,
      reason: `Domain "${domain}" policy: ${policy.level}`,
    });
  }

  /** Get the policy for a specific domain, or null if unknown. */
  getDomainPolicy(domain: string): HADomainPolicy | null {
    return this.policies.get(domain) ?? null;
  }

  /** List all configured policies. */
  listPolicies(): ReadonlyArray<HADomainPolicy> {
    return [...this.policies.values()];
  }
}
