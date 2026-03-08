/**
 * Tests for plugin loader security -- manifest validation and path traversal.
 */

import { describe, expect, test } from "bun:test";
import { PluginManifestSchema } from "../loader.ts";

// ---------------------------------------------------------------------------
// PluginManifestSchema validation tests
// ---------------------------------------------------------------------------

describe("PluginManifestSchema", () => {
  const validManifest = {
    name: "test-plugin",
    version: "1.0.0",
    description: "A test plugin",
    eidolonVersion: "0.1.0",
    permissions: ["events:listen", "events:emit"],
    extensionPoints: [
      { type: "event-listener", name: "my-listener" },
    ],
    main: "index.js",
  };

  test("accepts a valid manifest", () => {
    const result = PluginManifestSchema.safeParse(validManifest);
    expect(result.success).toBe(true);
  });

  test("accepts manifest with optional author", () => {
    const result = PluginManifestSchema.safeParse({
      ...validManifest,
      author: "Test Author",
    });
    expect(result.success).toBe(true);
  });

  test("rejects manifest with missing name", () => {
    const { name: _, ...noName } = validManifest;
    const result = PluginManifestSchema.safeParse(noName);
    expect(result.success).toBe(false);
  });

  test("rejects manifest with empty name", () => {
    const result = PluginManifestSchema.safeParse({ ...validManifest, name: "" });
    expect(result.success).toBe(false);
  });

  test("rejects manifest with missing version", () => {
    const { version: _, ...noVersion } = validManifest;
    const result = PluginManifestSchema.safeParse(noVersion);
    expect(result.success).toBe(false);
  });

  test("rejects manifest with missing main", () => {
    const { main: _, ...noMain } = validManifest;
    const result = PluginManifestSchema.safeParse(noMain);
    expect(result.success).toBe(false);
  });

  test("rejects manifest with invalid permission", () => {
    const result = PluginManifestSchema.safeParse({
      ...validManifest,
      permissions: ["events:listen", "hack:system"],
    });
    expect(result.success).toBe(false);
  });

  test("rejects manifest with invalid extension point type", () => {
    const result = PluginManifestSchema.safeParse({
      ...validManifest,
      extensionPoints: [{ type: "malicious-type", name: "bad" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-object input", () => {
    expect(PluginManifestSchema.safeParse("not an object").success).toBe(false);
    expect(PluginManifestSchema.safeParse(null).success).toBe(false);
    expect(PluginManifestSchema.safeParse(42).success).toBe(false);
  });

  test("rejects manifest with missing eidolonVersion", () => {
    const { eidolonVersion: _, ...noEidolonVersion } = validManifest;
    const result = PluginManifestSchema.safeParse(noEidolonVersion);
    expect(result.success).toBe(false);
  });

  test("accepts all valid permission types", () => {
    const allPermissions = [
      "events:listen", "events:emit", "memory:read", "memory:write",
      "config:read", "config:write", "gateway:register", "channel:register",
      "shell:execute", "filesystem:write",
    ];
    const result = PluginManifestSchema.safeParse({
      ...validManifest,
      permissions: allPermissions,
    });
    expect(result.success).toBe(true);
  });

  test("accepts all valid extension point types", () => {
    const allTypes = ["channel", "rpc-handler", "event-listener", "memory-extractor", "cli-command", "config-schema"];
    const result = PluginManifestSchema.safeParse({
      ...validManifest,
      extensionPoints: allTypes.map((type) => ({ type, name: `ep-${type}` })),
    });
    expect(result.success).toBe(true);
  });
});
