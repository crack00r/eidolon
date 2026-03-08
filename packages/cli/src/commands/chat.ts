/**
 * eidolon chat -- interactive chat with the AI assistant.
 *
 * Supports single-message mode (-m) and interactive REPL mode.
 * Uses ClaudeCodeManager to stream responses from Claude Code CLI.
 */

import { createInterface } from "node:readline";
import type { Logger } from "@eidolon/core";
import {
  AccountRotation,
  ClaudeCodeManager,
  createLogger,
  DatabaseManager,
  generateMcpConfig,
  loadConfig,
  SessionManager,
  WorkspacePreparer,
} from "@eidolon/core";
import type { ClaudeAccount, EidolonConfig, StreamEvent } from "@eidolon/protocol";
import type { Command } from "commander";

interface ChatOptions {
  readonly message?: string;
  readonly model?: string;
  readonly session?: string;
}

/** Resolve a credential value, handling plain strings and $secret refs. */
function resolveCredential(credential: ClaudeAccount["credential"]): string | null {
  if (typeof credential === "string") return credential;
  // SecretRef objects require the SecretStore -- not available in simple CLI chat
  return null;
}

/** Print a stream event to the terminal. */
function printEvent(event: StreamEvent): void {
  switch (event.type) {
    case "text":
      if (event.content) process.stdout.write(event.content);
      break;
    case "tool_use":
      if (event.toolName) {
        process.stderr.write(`\n[tool: ${event.toolName}]\n`);
      }
      break;
    case "error":
      process.stderr.write(`\nError: ${event.error ?? "unknown error"}\n`);
      break;
    case "done":
      process.stdout.write("\n");
      break;
    default:
      break;
  }
}

/** Send a prompt to Claude and stream the response. */
async function sendMessage(
  manager: ClaudeCodeManager,
  prompt: string,
  config: EidolonConfig,
  account: ClaudeAccount,
  workspaceDir: string,
  mcpConfigPath: string | null,
  model: string | undefined,
  sessionId: string | undefined,
): Promise<void> {
  const apiKey = resolveCredential(account.credential);
  if (!apiKey) {
    process.stderr.write("Error: Account credential uses $secret ref. Set a plain API key or resolve secrets first.\n");
    return;
  }

  const events = manager.run(prompt, {
    sessionId,
    workspaceDir,
    model: model ?? config.brain.model.default,
    mcpConfig: mcpConfigPath ?? undefined,
    maxTurns: config.brain.session.maxTurns,
    timeoutMs: config.brain.session.timeoutMs,
    env: account.type === "api-key" ? { ANTHROPIC_API_KEY: apiKey } : {},
  });

  for await (const event of events) {
    printEvent(event);
  }
}

/** Run the interactive REPL loop. */
async function runInteractive(
  manager: ClaudeCodeManager,
  config: EidolonConfig,
  accountRotation: AccountRotation,
  workspaceDir: string,
  mcpConfigPath: string | null,
  sessionManager: SessionManager,
  model: string | undefined,
  logger: Logger,
): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "you> ",
  });

  const sessionResult = sessionManager.create("main");
  if (!sessionResult.ok) {
    process.stderr.write(`Failed to create session: ${sessionResult.error.message}\n`);
    rl.close();
    return;
  }
  const session = sessionResult.value;
  logger.info("chat", "Interactive session started", { sessionId: session.id });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    if (trimmed === "/quit" || trimmed === "/exit") {
      rl.close();
      return;
    }

    const accountResult = accountRotation.selectAccount();
    if (!accountResult.ok) {
      process.stderr.write(`Error: ${accountResult.error.message}\n`);
      rl.prompt();
      return;
    }

    await sendMessage(
      manager,
      trimmed,
      config,
      accountResult.value,
      workspaceDir,
      mcpConfigPath,
      model,
      session.claudeSessionId,
    );

    rl.prompt();
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      sessionManager.updateStatus(session.id, "completed");
      logger.info("chat", "Interactive session ended", { sessionId: session.id });
      resolve();
    });
  });
}

export function registerChatCommand(program: Command): void {
  program
    .command("chat")
    .description("Start an interactive chat session")
    .option("-m, --message <text>", "Send a single message (non-interactive)")
    .option("--model <model>", "Override model")
    .option("--session <id>", "Resume an existing session")
    .action(async (options: ChatOptions) => {
      // Load config
      const configResult = await loadConfig();
      if (!configResult.ok) {
        process.stderr.write(`Error loading config: ${configResult.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      const config = configResult.value;

      // Create logger
      const logger = createLogger(config.logging);

      // Create Claude Code manager with API key from config
      const apiKeyAccount = config.brain.accounts.find(
        (a: { type: string; enabled?: boolean }) => a.type === "api-key" && a.enabled !== false,
      );
      const apiKey =
        apiKeyAccount && typeof apiKeyAccount.credential === "string" ? apiKeyAccount.credential : undefined;
      const manager = new ClaudeCodeManager(logger, { apiKey });

      // Verify Claude CLI is available
      const available = await manager.isAvailable();
      if (!available) {
        process.stderr.write("Error: Claude Code CLI is not installed or not in PATH.\n");
        process.exitCode = 1;
        return;
      }

      // Create account rotation
      const accountRotation = new AccountRotation(config.brain.accounts, logger);

      // Initialize database for session tracking
      const dbManager = new DatabaseManager(config.database, logger);
      const dbResult = dbManager.initialize();
      if (!dbResult.ok) {
        process.stderr.write(`Error initializing database: ${dbResult.error.message}\n`);
        process.exitCode = 1;
        return;
      }

      const sessionManager = new SessionManager(dbManager.operational, logger);

      // Prepare workspace
      const workspacePreparer = new WorkspacePreparer(logger);
      const workspaceSessionId = options.session ?? `chat-${Date.now()}`;
      const workspaceResult = await workspacePreparer.prepare(workspaceSessionId, {
        claudeMd: `# ${config.identity.name}\n\nYou are ${config.identity.name}, a personal AI assistant for ${config.identity.ownerName}.\nRespond helpfully, concisely, and accurately.\n`,
      });

      if (!workspaceResult.ok) {
        process.stderr.write(`Error preparing workspace: ${workspaceResult.error.message}\n`);
        dbManager.close();
        process.exitCode = 1;
        return;
      }
      const workspaceDir = workspaceResult.value;

      // Generate MCP config if servers are configured
      const mcpResult = await generateMcpConfig(workspaceDir, config.brain);
      const mcpConfigResult = mcpResult.ok ? mcpResult.value : null;
      const mcpConfigPath = mcpConfigResult?.path ?? null;

      // Graceful shutdown handler
      const cleanup = (): void => {
        mcpConfigResult?.cleanup();
        workspacePreparer.cleanup(workspaceSessionId);
        dbManager.close();
      };

      // Track whether SIGINT triggered cleanup so the finally block doesn't double-clean
      let sigintHandled = false;
      process.on("SIGINT", () => {
        process.stdout.write("\n");
        sigintHandled = true;
        cleanup();
        // Set exit code and let the event loop drain naturally
        // instead of calling process.exit() which bypasses the finally block
        process.exitCode = 0;
      });

      try {
        if (options.message) {
          // Single-message mode
          const accountResult = accountRotation.selectAccount();
          if (!accountResult.ok) {
            process.stderr.write(`Error: ${accountResult.error.message}\n`);
            process.exitCode = 1;
            return;
          }

          const sessionResult = sessionManager.create("main");
          if (!sessionResult.ok) {
            process.stderr.write(`Failed to create session: ${sessionResult.error.message}\n`);
            process.exitCode = 1;
            return;
          }
          const session = sessionResult.value;

          await sendMessage(
            manager,
            options.message,
            config,
            accountResult.value,
            workspaceDir,
            mcpConfigPath,
            options.model,
            options.session ?? session.claudeSessionId,
          );

          sessionManager.updateStatus(session.id, "completed");
        } else {
          // Interactive REPL mode
          await runInteractive(
            manager,
            config,
            accountRotation,
            workspaceDir,
            mcpConfigPath,
            sessionManager,
            options.model,
            logger,
          );
        }
      } finally {
        if (!sigintHandled) {
          cleanup();
        }
      }
    });
}
