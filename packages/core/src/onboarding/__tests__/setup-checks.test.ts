import { describe, expect, test } from "bun:test";
import { runPreflightChecks } from "../setup-checks.ts";

describe("runPreflightChecks", () => {
  test("returns ok result with bun version and directories", () => {
    const result = runPreflightChecks();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.bunVersion).toBeTruthy();
    expect(result.value.bunVersion).not.toBe("unknown");
    expect(result.value.dataDir).toBeTruthy();
    expect(result.value.configDir).toBeTruthy();
    expect(typeof result.value.diskSpaceMb).toBe("number");
  });

  test("dataDir and configDir are absolute paths", () => {
    const result = runPreflightChecks();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.dataDir.startsWith("/")).toBe(true);
    expect(result.value.configDir.startsWith("/")).toBe(true);
  });

  test("diskSpaceMb is non-negative", () => {
    const result = runPreflightChecks();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.diskSpaceMb).toBeGreaterThanOrEqual(0);
  });
});
