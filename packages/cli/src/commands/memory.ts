/**
 * eidolon memory -- memory management commands.
 * Stub: Phase 2.
 */

import type { Command } from "commander";

export function registerMemoryCommand(program: Command): void {
  program
    .command("memory")
    .description("Manage the memory engine")
    .action(() => {
      console.log("Not yet implemented -- Phase 2");
    });
}
