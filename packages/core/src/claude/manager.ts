/**
 * Production implementation of IClaudeProcess.
 *
 * Spawns Claude Code CLI as a subprocess and streams parsed events.
 * Uses Bun.spawn() for subprocess management.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ClaudeSessionOptions, EidolonError, IClaudeProcess, Result, StreamEvent } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Subprocess } from "bun";
import { getEidolonClaudeConfigDir } from "../config/paths.ts";
import type { Logger } from "../logging/logger.ts";
import type { ITracer } from "../telemetry/tracer.ts";
import { NoopTracer } from "../telemetry/tracer.ts";
import { buildClaudeArgs } from "./args.ts";
import { parseStreamLine } from "./parser.ts";

/** Build a PATH string that includes common Claude CLI install locations. */
function buildExtendedPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const pathSep = process.platform === "win32" ? ";" : ":";
  const extraPaths = [
    `${home}/.local/bin`,
    `${home}/.claude/local`,
    `${home}/.nvm/current/bin`,
    `${home}/.volta/bin`,
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ].join(pathSep);
  const currentPath = process.env.PATH ?? "";
  return currentPath ? `${extraPaths}${pathSep}${currentPath}` : extraPaths;
}

/** Find the Claude CLI binary, searching common install locations. */
function findClaudeBinary(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates = [
    `${home}/.local/bin/claude`,
    `${home}/.claude/local/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // skip
    }
  }
  return "claude";
}

/**
 * Manages Claude Code CLI subprocesses.
 * Each call to `run()` spawns a new `claude --print --output-format stream-json` process.
 */
export class ClaudeCodeManager implements IClaudeProcess {
  private readonly activeSessions = new Map<string, Subprocess>();
  private readonly logger: Logger;
  private readonly tracer: ITracer;
  private readonly apiKey: string | undefined;
  private readonly maxConcurrentSessions: number;

  constructor(logger: Logger, options?: { tracer?: ITracer; apiKey?: string; maxConcurrentSessions?: number }) {
    this.logger = logger.child("claude");
    this.tracer = options?.tracer ?? new NoopTracer();
    this.apiKey = options?.apiKey;
    this.maxConcurrentSessions = options?.maxConcurrentSessions ?? 5;
  }

  /**
   * Run a Claude Code session.
   * Spawns the CLI, streams parsed events, and cleans up on completion.
   */
  async *run(prompt: string, options: ClaudeSessionOptions): AsyncGenerator<StreamEvent> {
    const sessionId = options.sessionId ?? `session-${randomUUID()}`;

    // Enforce concurrency limit before spawning a new subprocess
    if (this.activeSessions.size >= this.maxConcurrentSessions) {
      this.logger.warn("manager", "Concurrency limit reached, rejecting session", {
        sessionId,
        active: this.activeSessions.size,
        limit: this.maxConcurrentSessions,
      });
      yield {
        type: "error",
        error: `Concurrency limit reached (${String(this.maxConcurrentSessions)} active sessions). Try again later.`,
        timestamp: Date.now(),
      };
      return;
    }

    const args = buildClaudeArgs(prompt, options);
    const span = this.tracer.startSpan("claude.session", {
      "session.id": sessionId,
      ...(options.model ? { model: options.model } : {}),
    });

    this.logger.info("manager", "Starting Claude Code session", {
      sessionId,
      model: options.model,
    });

    // ERR-003: Whitelist only safe env vars to avoid leaking secrets to subprocesses
    const SAFE_ENV_KEYS = [
      "PATH",
      "HOME",
      "USER",
      "LANG",
      "TERM",
      "SHELL",
      "TMPDIR",
      "TZ",
      "NODE_ENV",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ];
    /** Prefixes of env vars safe to pass through (non-secret EIDOLON_ config, ANTHROPIC_ API keys). */
    const SAFE_ENV_PREFIXES = ["ANTHROPIC_", "EIDOLON_"];
    /** Secret env vars within safe prefixes that must NOT leak to subprocesses. */
    const SECRET_ENV_KEYS = new Set(["EIDOLON_MASTER_KEY", "EIDOLON_GPU_API_KEY"]);

    const safeEnv: Record<string, string> = {};
    for (const key of SAFE_ENV_KEYS) {
      const val = process.env[key];
      if (val) safeEnv[key] = val;
    }
    // Pass safe-prefix vars, excluding known secrets
    for (const [key, val] of Object.entries(process.env)) {
      if (val && SAFE_ENV_PREFIXES.some((p) => key.startsWith(p)) && !SECRET_ENV_KEYS.has(key)) {
        safeEnv[key] = val;
      }
    }

    // Ensure PATH includes common Claude CLI install locations
    safeEnv.PATH = buildExtendedPath();

    // Filter options.env to reject dangerous keys that could hijack the subprocess
    const DANGEROUS_ENV_KEYS = new Set([
      "PATH",
      "HOME",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      // macOS dynamic linker injection vectors
      "DYLD_INSERT_LIBRARIES",
      "DYLD_FRAMEWORK_PATH",
      "DYLD_LIBRARY_PATH",
      "EIDOLON_MASTER_KEY",
      "EIDOLON_GPU_API_KEY",
      "NODE_OPTIONS",
      // Anthropic API keys -- prevent callers from overriding/stealing API credentials
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      // Claude CLI config -- prevent hijacking Claude's config/auth directory
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_API_KEY",
    ]);
    const filteredEnv: Record<string, string> = {};
    if (options.env) {
      for (const [key, val] of Object.entries(options.env)) {
        if (!DANGEROUS_ENV_KEYS.has(key)) {
          filteredEnv[key] = val;
        } else {
          this.logger.warn("manager", `Rejected dangerous env override: ${key}`, { sessionId });
        }
      }
    }

    // Inject API key from config if provided and not already set in environment
    if (this.apiKey && !safeEnv.ANTHROPIC_API_KEY) {
      safeEnv.ANTHROPIC_API_KEY = this.apiKey;
    }

    // Give Eidolon its own Claude CLI auth session (separate from user's global Claude)
    safeEnv.CLAUDE_CONFIG_DIR = getEidolonClaudeConfigDir();

    // For OAuth auth: Claude CLI uses its own stored authentication.
    // No env var injection needed -- the subprocess finds its auth via HOME.

    const claudeBin = findClaudeBinary();
    const proc = Bun.spawn([claudeBin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...filteredEnv,
        ...safeEnv,
      },
      cwd: options.workspaceDir,
    });

    this.activeSessions.set(sessionId, proc);

    // Drain stderr unconditionally in the background to prevent pipe deadlocks
    const stderrPromise: Promise<string> = (proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("")).catch(
      () => "",
    );

    // Set up timeout if configured
    let timedOut = false;
    const timeoutId =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            this.logger.warn("manager", `Session timed out after ${String(options.timeoutMs)}ms`, { sessionId });
            timedOut = true;
            try {
              proc.kill();
            } catch {
              // Process may have already exited; ignore ESRCH / similar errors
            }
          }, options.timeoutMs)
        : null;

    try {
      // Stream stdout line by line
      if (proc.stdout) {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        const buffer: string[] = [""];

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const parts = chunk.split("\n");

            // Append first part to the current incomplete line
            buffer[0] += parts[0] ?? "";

            // Process all complete lines
            for (const part of parts.slice(1)) {
              const completeLine = buffer.shift();
              buffer.unshift(part);
              if (completeLine !== undefined) {
                const extra: StreamEvent[] = [];
                const event = parseStreamLine(completeLine, undefined, extra);
                for (const e of extra) yield e;
                if (event) yield event;
              }
            }
          }

          // Process remaining buffer
          const remaining = buffer[0] ?? "";
          if (remaining.trim()) {
            const extra: StreamEvent[] = [];
            const event = parseStreamLine(remaining, undefined, extra);
            for (const e of extra) yield e;
            if (event) yield event;
          }
        } finally {
          reader.releaseLock();
        }
      }

      // Wait for process to exit
      const exitCode = await proc.exited;

      if (timedOut) {
        span.setStatus("error", `Claude Code session timed out after ${String(options.timeoutMs)}ms`);
        yield {
          type: "error",
          error: `Claude Code session timed out after ${String(options.timeoutMs)}ms`,
          timestamp: Date.now(),
        };
      } else if (exitCode !== 0) {
        const stderr = await stderrPromise;
        span.setStatus("error", `Claude Code exited with code ${String(exitCode)}`);
        yield {
          type: "error",
          error: `Claude Code exited with code ${String(exitCode)}`,
          timestamp: Date.now(),
        };
        this.logger.error("manager", `Claude stderr: ${stderr}`, { sessionId: options.sessionId });
      } else {
        span.setStatus("ok");
      }

      yield { type: "done", timestamp: Date.now() };
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      // Kill the subprocess to prevent leaks when the generator is abandoned early
      try {
        proc.kill();
      } catch {
        // Process may have already exited; ignore ESRCH / similar errors
      }
      this.activeSessions.delete(sessionId);
      // Ensure stderr is consumed even if generator is abandoned early
      stderrPromise.catch((e: unknown) =>
        this.logger.debug("claude", "stderr consumption failed", { error: String(e) }),
      );
      span.end();
    }
  }

  /**
   * Check whether the Claude Code CLI is installed and reachable.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const result = Bun.spawnSync([findClaudeBinary(), "--version"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: buildExtendedPath(), HOME: process.env.HOME ?? "", LANG: process.env.LANG ?? "" },
      });
      return result.exitCode === 0;
    } catch {
      // Intentional: spawn failure means Claude CLI is not available
      return false;
    }
  }

  /**
   * Return the installed Claude Code CLI version string.
   */
  async getVersion(): Promise<Result<string, EidolonError>> {
    try {
      const result = Bun.spawnSync([findClaudeBinary(), "--version"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: buildExtendedPath(), HOME: process.env.HOME ?? "", LANG: process.env.LANG ?? "" },
      });
      if (result.exitCode !== 0) {
        return Err(createError(ErrorCode.CLAUDE_NOT_INSTALLED, "Claude Code CLI not found or not working"));
      }
      return Ok(result.stdout.toString().trim());
    } catch (cause) {
      return Err(createError(ErrorCode.CLAUDE_NOT_INSTALLED, "Claude Code CLI not found", cause));
    }
  }

  /**
   * Abort a running session by killing its subprocess.
   */
  async abort(sessionId: string): Promise<void> {
    const proc = this.activeSessions.get(sessionId);
    if (proc) {
      proc.kill();
      this.activeSessions.delete(sessionId);
      this.logger.info("manager", "Session aborted", { sessionId });
    }
  }
}
