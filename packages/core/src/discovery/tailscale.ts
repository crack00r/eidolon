/**
 * Tailscale integration -- detect Tailscale status and IP.
 *
 * Caches results and re-polls periodically to avoid spawning
 * subprocesses on every request.
 */

import type { Result } from "@eidolon/protocol";
import { Err, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TailscaleInfo {
  readonly ip: string;
  readonly hostname: string;
  readonly active: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to re-poll Tailscale status (ms). */
const POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// TailscaleDetector
// ---------------------------------------------------------------------------

export class TailscaleDetector {
  private readonly logger: Logger;
  private cache: TailscaleInfo | null = null;
  private lastPoll = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(logger: Logger) {
    this.logger = logger.child("tailscale");
  }

  /** Start periodic polling. */
  start(): void {
    if (this.pollTimer) return;
    void this.poll();
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  /** Stop periodic polling. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Get cached Tailscale info, or poll if stale. */
  async getInfo(): Promise<Result<TailscaleInfo, Error>> {
    if (this.cache && Date.now() - this.lastPoll < POLL_INTERVAL_MS) {
      return Ok(this.cache);
    }
    return this.poll();
  }

  /** Get the cached Tailscale IP (sync, may be null). */
  getCachedIp(): string | undefined {
    return this.cache?.active ? this.cache.ip : undefined;
  }

  /** Poll Tailscale for current status. */
  private async poll(): Promise<Result<TailscaleInfo, Error>> {
    try {
      const ip = await this.runCommand(["tailscale", "ip", "-4"]);
      if (!ip) {
        const info: TailscaleInfo = { ip: "", hostname: "", active: false };
        this.cache = info;
        this.lastPoll = Date.now();
        return Ok(info);
      }

      let hostname = "";
      try {
        const statusJson = await this.runCommand(["tailscale", "status", "--json"]);
        if (statusJson) {
          const parsed: unknown = JSON.parse(statusJson);
          if (typeof parsed === "object" && parsed !== null && "Self" in parsed) {
            const self = (parsed as Record<string, unknown>).Self;
            if (typeof self === "object" && self !== null && "HostName" in self) {
              hostname = String((self as Record<string, unknown>).HostName);
            }
          }
        }
      } catch {
        // hostname lookup failed, non-critical
      }

      const info: TailscaleInfo = { ip: ip.trim(), hostname, active: true };
      this.cache = info;
      this.lastPoll = Date.now();
      this.logger.debug("poll", `Tailscale active: ${info.ip} (${info.hostname})`);
      return Ok(info);
    } catch (err) {
      const info: TailscaleInfo = { ip: "", hostname: "", active: false };
      this.cache = info;
      this.lastPoll = Date.now();
      this.logger.debug("poll", "Tailscale not available");
      return Err(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Run a command and return stdout, or null on failure. */
  private async runCommand(args: readonly string[]): Promise<string | null> {
    try {
      const proc = Bun.spawn(args as string[], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) return null;
      const stdout = await new Response(proc.stdout).text();
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
}
