/**
 * ChannelResolver -- resolves external channel user IDs to Eidolon users.
 *
 * Maps Telegram userId, Discord userId, Slack userId, etc. to internal
 * Eidolon users. Supports auto-creation of users on first contact
 * (when allowlisted) and falls back to the default user when
 * multi-user mode is disabled.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { UserManager } from "./manager.ts";
import type { User } from "./schema.ts";
import { DEFAULT_USER_ID } from "./schema.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChannelResolverOptions {
  /** Whether multi-user mode is enabled. When false, always returns default user. */
  readonly multiUserEnabled: boolean;
  /** Whether to auto-create users on first contact from an allowlisted channel ID. */
  readonly autoCreateUsers: boolean;
}

export interface ResolveContext {
  /** Channel type: "telegram", "discord", "slack", "gateway", etc. */
  readonly channelType: string;
  /** External user ID on the channel (e.g., Telegram numeric ID as string). */
  readonly externalUserId: string;
  /** Optional display name from the channel for auto-created users. */
  readonly displayName?: string;
}

// ---------------------------------------------------------------------------
// ChannelResolver
// ---------------------------------------------------------------------------

export class ChannelResolver {
  private readonly userManager: UserManager;
  private readonly logger: Logger;
  private readonly options: ChannelResolverOptions;

  constructor(userManager: UserManager, logger: Logger, options: ChannelResolverOptions) {
    this.userManager = userManager;
    this.logger = logger.child("channel-resolver");
    this.options = options;
  }

  /**
   * Resolve an external channel user to an Eidolon user.
   *
   * Resolution order:
   * 1. If multi-user is disabled, return default user
   * 2. Look up existing user by channel mapping
   * 3. If autoCreate is enabled, create a new user with the channel mapping
   * 4. Fall back to default user
   */
  resolve(context: ResolveContext): Result<User, EidolonError> {
    // Single-user mode: always return default
    if (!this.options.multiUserEnabled) {
      return this.getDefaultUser();
    }

    // Look up by channel mapping
    const lookupResult = this.userManager.findByChannel(context.channelType, context.externalUserId);
    if (!lookupResult.ok) return lookupResult;

    if (lookupResult.value !== null) {
      this.logger.debug("resolve", `Resolved ${context.channelType}:${context.externalUserId}`, {
        userId: lookupResult.value.id,
      });
      return Ok(lookupResult.value);
    }

    // Auto-create if enabled
    if (this.options.autoCreateUsers) {
      return this.autoCreate(context);
    }

    // Fall back to default user
    this.logger.debug(
      "resolve",
      `No mapping found for ${context.channelType}:${context.externalUserId}, using default`,
    );
    return this.getDefaultUser();
  }

  /**
   * Manually map a channel identity to an existing user.
   * Adds the channel mapping to the user's channel_mappings array.
   */
  mapChannelToUser(userId: string, channelType: string, externalUserId: string): Result<User, EidolonError> {
    const userResult = this.userManager.get(userId);
    if (!userResult.ok) return userResult;
    if (userResult.value === null) {
      return Err(createError(ErrorCode.INVALID_INPUT, `User ${userId} not found`));
    }

    const user = userResult.value;

    // Check for duplicate mapping
    const existing = user.channelMappings.find(
      (m) => m.channelType === channelType && m.externalUserId === externalUserId,
    );
    if (existing) {
      return Ok(user); // Already mapped
    }

    const updatedMappings = [...user.channelMappings, { channelType, externalUserId }];

    return this.userManager.update(userId, { channelMappings: updatedMappings });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getDefaultUser(): Result<User, EidolonError> {
    const result = this.userManager.get(DEFAULT_USER_ID);
    if (!result.ok) return result;
    if (result.value === null) {
      return Err(createError(ErrorCode.INVALID_STATE, "Default user not found -- was ensureDefaultUser() called?"));
    }
    return Ok(result.value);
  }

  /** Maximum number of auto-created users before falling back to default. */
  private static readonly MAX_AUTO_CREATED_USERS = 10_000;

  private autoCreate(context: ResolveContext): Result<User, EidolonError> {
    // Rate limit: prevent unbounded user creation
    const countResult = this.userManager.count();
    if (!countResult.ok) return countResult;
    if (countResult.value >= ChannelResolver.MAX_AUTO_CREATED_USERS) {
      this.logger.warn(
        "auto-create",
        `User count (${countResult.value}) exceeds maximum (${ChannelResolver.MAX_AUTO_CREATED_USERS}), ` +
          `falling back to default user for ${context.channelType}:${context.externalUserId}`,
      );
      return this.getDefaultUser();
    }

    const name = context.displayName ?? `${context.channelType}:${context.externalUserId}`;

    const createResult = this.userManager.create({
      name,
      channelMappings: [
        {
          channelType: context.channelType,
          externalUserId: context.externalUserId,
        },
      ],
      preferences: {},
    });

    if (!createResult.ok) return createResult;

    this.logger.info("auto-create", `Auto-created user for ${context.channelType}:${context.externalUserId}`, {
      userId: createResult.value.id,
      name,
    });

    return createResult;
  }
}
