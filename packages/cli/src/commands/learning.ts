/**
 * eidolon learning -- self-learning management commands.
 * Stub: Phase 5.
 */

import type { Command } from "commander";

export function registerLearningCommand(program: Command): void {
  program
    .command("learning")
    .description("Manage self-learning capabilities")
    .action(() => {
      console.log("Not yet implemented -- Phase 5");
    });
}
