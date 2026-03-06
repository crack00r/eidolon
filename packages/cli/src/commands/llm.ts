/**
 * eidolon llm -- LLM provider management commands.
 *
 * Subcommands:
 *   list            -- list configured LLM providers with name, type, status
 *   status          -- show current LLM routing status
 *   test <provider> -- test connectivity to a specific provider
 */

import { loadConfig } from "@eidolon/core";
import type { LLMConfig } from "@eidolon/protocol";
import type { Command } from "commander";
import { formatTable } from "../utils/formatter.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderRow {
  readonly Provider: string;
  readonly Type: string;
  readonly Status: string;
  readonly Details: string;
}

interface RoutingRow {
  readonly Task: string;
  readonly Chain: string;
}

// ---------------------------------------------------------------------------
// Provider status helpers
// ---------------------------------------------------------------------------

const VALID_PROVIDER_TYPES: readonly string[] = ["claude", "ollama", "llamacpp"];

function buildProviderList(config: LLMConfig): readonly ProviderRow[] {
  const rows: ProviderRow[] = [];

  // Claude is always configured (it's the primary brain)
  rows.push({
    Provider: "claude",
    Type: "claude",
    Status: "configured",
    Details: "Primary provider (Claude Code CLI)",
  });

  // Ollama
  const ollama = config.providers.ollama;
  if (ollama) {
    rows.push({
      Provider: "ollama",
      Type: "ollama",
      Status: ollama.enabled ? "configured" : "disabled",
      Details: ollama.enabled
        ? `${ollama.host}, models: ${Object.keys(ollama.models).join(", ") || "(auto-detect)"}`
        : "disabled in config",
    });
  } else {
    rows.push({
      Provider: "ollama",
      Type: "ollama",
      Status: "not configured",
      Details: "add llm.providers.ollama in eidolon.json",
    });
  }

  // llama.cpp
  const llamacpp = config.providers.llamacpp;
  if (llamacpp) {
    rows.push({
      Provider: "llamacpp",
      Type: "llamacpp",
      Status: llamacpp.enabled ? "configured" : "disabled",
      Details: llamacpp.enabled
        ? `model: ${llamacpp.modelPath || "(not set)"}, port: ${llamacpp.port}`
        : "disabled in config",
    });
  } else {
    rows.push({
      Provider: "llamacpp",
      Type: "llamacpp",
      Status: "not configured",
      Details: "add llm.providers.llamacpp in eidolon.json",
    });
  }

  return rows;
}

/** Build the default routing table showing which providers handle which tasks. */
function buildRoutingTable(config: LLMConfig): readonly RoutingRow[] {
  const defaultRouting: Record<string, readonly string[]> = {
    conversation: ["claude"],
    "code-generation": ["claude"],
    extraction: ["ollama", "llamacpp", "claude"],
    filtering: ["ollama", "llamacpp", "claude"],
    dreaming: ["ollama", "llamacpp", "claude"],
    summarization: ["ollama", "llamacpp", "claude"],
    embedding: ["ollama", "llamacpp"],
  };

  const routing = { ...defaultRouting, ...config.routing };

  return Object.entries(routing).map(([task, chain]) => ({
    Task: task,
    Chain: (chain as readonly string[]).join(" -> "),
  }));
}

/**
 * Test connectivity to an LLM provider.
 * For ollama: tries to reach the /api/tags endpoint.
 * For llamacpp: tries to reach the /health endpoint.
 * For claude: reports that it's managed via Claude Code CLI.
 */
async function testProvider(
  providerType: string,
  config: LLMConfig,
): Promise<{ ok: boolean; message: string }> {
  if (providerType === "claude") {
    return {
      ok: true,
      message: "Claude provider uses Claude Code CLI. Use 'eidolon doctor' to check CLI availability.",
    };
  }

  if (providerType === "ollama") {
    const ollama = config.providers.ollama;
    if (!ollama) {
      return { ok: false, message: "Ollama is not configured. Add llm.providers.ollama to eidolon.json." };
    }
    if (!ollama.enabled) {
      return { ok: false, message: "Ollama is disabled in config." };
    }

    const url = `${ollama.host}/api/tags`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const body = (await response.json()) as { models?: readonly { name: string }[] };
        const modelCount = Array.isArray(body.models) ? body.models.length : 0;
        return { ok: true, message: `Connected. ${modelCount} model${modelCount !== 1 ? "s" : ""} available.` };
      }
      return { ok: false, message: `Server responded with status ${response.status}.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Connection failed: ${message}` };
    }
  }

  if (providerType === "llamacpp") {
    const llamacpp = config.providers.llamacpp;
    if (!llamacpp) {
      return { ok: false, message: "llama.cpp is not configured. Add llm.providers.llamacpp to eidolon.json." };
    }
    if (!llamacpp.enabled) {
      return { ok: false, message: "llama.cpp is disabled in config." };
    }

    const url = `http://127.0.0.1:${llamacpp.port}/health`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        return { ok: true, message: "Connected. Server is healthy." };
      }
      return { ok: false, message: `Server responded with status ${response.status}.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Connection failed: ${message}` };
    }
  }

  return { ok: false, message: `Unknown provider type: ${providerType}` };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerLlmCommand(program: Command): void {
  const cmd = program.command("llm").description("Manage LLM providers");

  // -- list ---------------------------------------------------------------
  cmd
    .command("list")
    .description("List configured LLM providers")
    .action(async () => {
      const configResult = await loadConfig();
      if (!configResult.ok) {
        console.error(`Error: ${configResult.error.message}`);
        process.exitCode = 1;
        return;
      }

      const providers = buildProviderList(configResult.value.llm);
      const configuredCount = providers.filter((p) => p.Status === "configured").length;

      console.log(`LLM Providers: ${configuredCount} configured`);
      console.log("");
      console.log(formatTable(providers.map((p) => ({ ...p })), ["Provider", "Type", "Status", "Details"]));
    });

  // -- status -------------------------------------------------------------
  cmd
    .command("status")
    .description("Show LLM routing status and provider availability")
    .action(async () => {
      const configResult = await loadConfig();
      if (!configResult.ok) {
        console.error(`Error: ${configResult.error.message}`);
        process.exitCode = 1;
        return;
      }

      const config = configResult.value;

      // Show providers
      const providers = buildProviderList(config.llm);
      console.log("Providers:");
      console.log(formatTable(providers.map((p) => ({ ...p })), ["Provider", "Type", "Status", "Details"]));
      console.log("");

      // Show routing table
      const routing = buildRoutingTable(config.llm);
      console.log("Routing Table (task -> provider chain):");
      console.log(formatTable(routing.map((r) => ({ ...r })), ["Task", "Chain"]));

      // Show model preferences
      console.log("");
      console.log("Claude Model Preferences:");
      console.log(`  Default:  ${config.brain.model.default}`);
      console.log(`  Complex:  ${config.brain.model.complex}`);
      console.log(`  Fast:     ${config.brain.model.fast}`);
    });

  // -- test <provider> ----------------------------------------------------
  cmd
    .command("test <provider>")
    .description("Test connectivity to a specific provider (claude, ollama, llamacpp)")
    .action(async (provider: string) => {
      if (!VALID_PROVIDER_TYPES.includes(provider)) {
        console.error(`Error: Unknown provider "${provider}".`);
        console.error(`Valid providers: ${VALID_PROVIDER_TYPES.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      const configResult = await loadConfig();
      if (!configResult.ok) {
        console.error(`Error: ${configResult.error.message}`);
        process.exitCode = 1;
        return;
      }

      console.log(`Testing ${provider}...`);
      const result = await testProvider(provider, configResult.value.llm);

      if (result.ok) {
        console.log(`[PASS] ${result.message}`);
      } else {
        console.log(`[FAIL] ${result.message}`);
        process.exitCode = 1;
      }
    });
}

// Export for testing
export { buildProviderList, buildRoutingTable, testProvider };
