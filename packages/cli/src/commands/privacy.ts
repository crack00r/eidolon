/**
 * eidolon privacy -- GDPR and privacy management commands.
 * Stub: Phase 9.
 */

import type { Command } from "commander";

export function registerPrivacyCommand(program: Command): void {
  program
    .command("privacy")
    .description("Privacy and GDPR management")
    .action(() => {
      console.log("Not yet implemented -- Phase 9");
    });
}
