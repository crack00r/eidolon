/**
 * eidolon doctor -- system diagnostics.
 * Fully implemented in Phase 0.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigPath, getDataDir, getLogDir, loadConfig } from "@eidolon/core";
import type { Command } from "commander";
import { formatCheck } from "../utils/formatter.ts";

interface CheckResult {
  readonly status: "pass" | "fail" | "warn";
  readonly message: string;
}

function checkBunVersion(): CheckResult {
  const version = Bun.version;
  const [major] = version.split(".");
  const majorNum = Number.parseInt(major ?? "0", 10);
  if (majorNum >= 1) {
    return { status: "pass", message: `Bun runtime v${version}` };
  }
  return { status: "fail", message: `Bun runtime v${version} (>= 1.0 required)` };
}

function checkClaudeCli(): CheckResult {
  try {
    const result = Bun.spawnSync(["claude", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString().trim();
    if (result.exitCode === 0 && output) {
      return { status: "pass", message: `Claude Code CLI ${output}` };
    }
    return { status: "fail", message: "Claude Code CLI not responding" };
  } catch {
    return { status: "fail", message: "Claude Code CLI not installed" };
  }
}

async function checkConfig(): Promise<CheckResult> {
  const configPath = getConfigPath();
  const result = await loadConfig();
  if (result.ok) {
    return { status: "pass", message: `Config file valid (${configPath})` };
  }
  if (result.error.code === "CONFIG_NOT_FOUND") {
    return { status: "warn", message: `Config file not found (${configPath})` };
  }
  return { status: "fail", message: `Config invalid: ${result.error.message}` };
}

function checkMasterKey(): CheckResult {
  if (process.env.EIDOLON_MASTER_KEY) {
    return { status: "pass", message: "Master key set (EIDOLON_MASTER_KEY)" };
  }
  return { status: "warn", message: "Master key not set (EIDOLON_MASTER_KEY)" };
}

function checkDirectory(label: string, dirPath: string): CheckResult {
  try {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
    // Test writability by creating and removing a temp file
    const testFile = join(dirPath, `.eidolon-doctor-test-${Date.now()}`);
    writeFileSync(testFile, "test");
    unlinkSync(testFile);
    return { status: "pass", message: `${label} writable (${dirPath})` };
  } catch {
    return { status: "fail", message: `${label} not writable (${dirPath})` };
  }
}

function checkDatabases(dataDir: string): CheckResult {
  try {
    // Test that we can create a temp SQLite database in the data dir
    const testPath = join(dataDir, `.eidolon-doctor-db-test-${Date.now()}.db`);
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(testPath, { create: true });
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
    db.close();
    unlinkSync(testPath);
    return { status: "pass", message: "Database connections OK" };
  } catch {
    return { status: "fail", message: "Database connections failed" };
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Run system diagnostics")
    .action(async () => {
      console.log("Eidolon System Check");
      console.log("====================");

      const dataDir = getDataDir();
      const logDir = getLogDir();

      const results: CheckResult[] = [
        checkBunVersion(),
        checkClaudeCli(),
        await checkConfig(),
        checkMasterKey(),
        checkDirectory("Data directory", dataDir),
        checkDirectory("Log directory", logDir),
        checkDatabases(dataDir),
      ];

      for (const result of results) {
        console.log(formatCheck(result.status, result.message));
      }

      const passed = results.filter((r) => r.status === "pass").length;
      const warnings = results.filter((r) => r.status === "warn").length;
      const failed = results.filter((r) => r.status === "fail").length;
      const total = results.length;

      console.log();
      const parts: string[] = [`${passed}/${total} checks passed`];
      if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? "s" : ""}`);
      if (failed > 0) parts.push(`${failed} failure${failed > 1 ? "s" : ""}`);
      console.log(parts.join(", "));

      if (failed > 0) {
        process.exitCode = 1;
      }
    });
}
