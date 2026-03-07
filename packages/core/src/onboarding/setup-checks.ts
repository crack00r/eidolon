/**
 * System prerequisite checks for onboarding.
 *
 * Validates Bun runtime, disk space, and ensures data/config directories exist.
 */

import { mkdirSync, statfsSync } from "node:fs";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { getConfigDir, getDataDir } from "../config/paths.ts";

const MIN_DISK_SPACE_MB = 500;

export interface PreflightResult {
  readonly bunVersion: string;
  readonly diskSpaceMb: number;
  readonly dataDir: string;
  readonly configDir: string;
}

export function runPreflightChecks(): Result<PreflightResult, EidolonError> {
  const bunVersion = typeof Bun !== "undefined" ? Bun.version : "unknown";
  const dataDir = getDataDir();
  const configDir = getConfigDir();

  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  } catch (cause) {
    return Err(createError(ErrorCode.INVALID_STATE, `Failed to create directories: ${cause}`, cause));
  }

  let diskSpaceMb = 0;
  try {
    const stats = statfsSync(dataDir);
    diskSpaceMb = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
  } catch {
    // Non-fatal -- disk space check is best-effort
  }

  if (diskSpaceMb > 0 && diskSpaceMb < MIN_DISK_SPACE_MB) {
    return Err(
      createError(ErrorCode.INVALID_INPUT, `Insufficient disk space: ${diskSpaceMb}MB (need ${MIN_DISK_SPACE_MB}MB)`),
    );
  }

  return Ok({ bunVersion, diskSpaceMb, dataDir, configDir });
}
