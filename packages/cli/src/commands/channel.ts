/**
 * eidolon channel -- communication channel management.
 * Stub: Phase 4.
 */

import type { Command } from "commander";

export function registerChannelCommand(program: Command): void {
  program
    .command("channel")
    .description("Manage communication channels")
    .action(() => {
      console.log("Not yet implemented -- Phase 4");
    });
}
