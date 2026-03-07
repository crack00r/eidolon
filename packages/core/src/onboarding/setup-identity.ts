/**
 * Identity setup helpers for onboarding.
 *
 * Provides default owner name detection and master key generation.
 */

import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";

export function getDefaultOwnerName(): string {
  try {
    return userInfo().username;
  } catch {
    return "User";
  }
}

export function generateMasterKey(): string {
  return randomBytes(32).toString("hex");
}
