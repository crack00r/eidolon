/**
 * Production implementation of IClaudeProcess.
 *
 * Spawns Claude Code CLI as a subprocess and streams parsed events.
 * Uses Bun.spawn() for subprocess management.
 */

import { randomUUID } from "node:crypto";
import type { ClaudeSessionOptions, EidolonError, IClaudeProcess, Result, StreamEvent } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Subprocess } from "bun";
import type { Logger } from "../logging/logger.ts";
import type { ITracer } from "../telemetry/tracer.ts";
import { NoopTracer } from "../telemetry/tracer.ts";
import { buildClaudeArgs } from "./args.ts";
import { parseStreamLine } from "./parser.ts";

/**
 * Manages Claude Code CLI subprocesses.
 * Each call to `run()` spawns a new `claude --print --output-format stream-json` process.
 */
export class ClaudeCodeManager implements IClaudeProcess {
  private readonly activeSessions = new Map<string, Subprocess>();
  private readonly logger: Logger;
  private readonly tracer: ITracer;

  constructor(logger: Logger, tracer?: ITracer) {
    this.logger = logger.child("claude");
    this.tracer = tracer ?? new NoopTracer();
  }

  /**
   * Run a Claude Code session.
   * Spawns the CLI, streams parsed events, and cleans up on completion.
   */
  async *run(prompt: string, options: ClaudeSessionOptions): AsyncGenerator<StreamEvent> {
    const args = buildClaudeArgs(prompt, options);
    const sessionId = options.sessionId ?? `session-${randomUUID()}`;
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

    const proc = Bun.spawn(["claude", ...args], {
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
    const stderrPromise: Promise<string> = proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("");

    // Set up timeout if configured
    const timeoutId =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
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
                const event = parseStreamLine(completeLine);
                if (event) yield event;
              }
            }
          }

          // Process remaining buffer
          const remaining = buffer[0] ?? "";
          if (remaining.trim()) {
            const event = parseStreamLine(remaining);
            if (event) yield event;
          }
        } finally {
          reader.releaseLock();
        }
      }

      // Wait for process to exit
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
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
      this.activeSessions.delete(sessionId);
      // Ensure stderr is consumed even if generator is abandoned early
      stderrPromise.catch(() => {});
      span.end();
    }
  }

  /**
   * Check whether the Claude Code CLI is installed and reachable.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const result = Bun.spawnSync(["claude", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Return the installed Claude Code CLI version string.
   */
  async getVersion(): Promise<Result<string, EidolonError>> {
    try {
      const result = Bun.spawnSync(["claude", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
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
