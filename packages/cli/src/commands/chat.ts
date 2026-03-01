/**
 * eidolon chat -- interactive chat with the AI assistant.
 * Stub: Phase 1.
 */

import type { Command } from "commander";

export function registerChatCommand(program: Command): void {
  program
    .command("chat")
    .description("Start an interactive chat session")
    .action(() => {
      console.log("Not yet implemented -- Phase 1");
    });
}
