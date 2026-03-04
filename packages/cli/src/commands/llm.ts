/**
 * eidolon llm -- local LLM provider management commands.
 */

import type { Command } from "commander";

export function registerLlmCommand(program: Command): void {
  const cmd = program.command("llm").description("Manage local LLM providers");

  cmd
    .command("providers")
    .description("List registered LLM providers and their status")
    .action(() => {
      console.log("Not yet implemented -- connect to running daemon via gateway RPC");
    });

  cmd
    .command("models")
    .description("List available models across all providers")
    .action(() => {
      console.log("Not yet implemented -- connect to running daemon via gateway RPC");
    });

  cmd
    .command("status")
    .description("Show routing table and provider availability")
    .action(() => {
      console.log("Not yet implemented -- connect to running daemon via gateway RPC");
    });
}
