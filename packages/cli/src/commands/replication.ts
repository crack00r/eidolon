/**
 * eidolon replication status|promote|demote -- replication management.
 *
 * Communicates with the running daemon's health endpoint to query
 * and control replication state.
 */

import type { Command } from "commander";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchHealthEndpoint(path: string, port: number): Promise<unknown> {
  const url = `http://127.0.0.1:${port}${path}`;
  const response = await fetch(url, {
    headers: { Host: "127.0.0.1" },
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  return response.json();
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerReplicationCommand(program: Command): void {
  const cmd = program.command("replication").description("Manage node replication (disaster recovery)");

  // -- status ---------------------------------------------------------------

  cmd
    .command("status")
    .description("Show replication status")
    .option("--port <port>", "Health server port", "9820")
    .action(async (opts: { port: string }) => {
      const port = Number.parseInt(opts.port, 10);
      try {
        const data = (await fetchHealthEndpoint("/health", port)) as Record<string, unknown>;
        const checks = data.checks as ReadonlyArray<Record<string, unknown>> | undefined;
        const replCheck = checks?.find((c) => c.name === "replication");

        if (replCheck) {
          console.log("Replication Status:");
          console.log(`  Status:  ${String(replCheck.status)}`);
          console.log(`  Message: ${String(replCheck.message ?? "n/a")}`);
        } else {
          console.log("Replication is not enabled or daemon is not running.");
          console.log("Enable replication in your config: replication.enabled = true");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to connect to daemon: ${message}`);
        console.log("Is the daemon running? Try: eidolon daemon status");
        process.exitCode = 1;
      }
    });

  // -- promote --------------------------------------------------------------

  cmd
    .command("promote")
    .description("Promote this node to primary")
    .option("--port <port>", "Health server port", "9820")
    .action(async (opts: { port: string }) => {
      const port = Number.parseInt(opts.port, 10);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/replication/promote`, {
          method: "POST",
          headers: { Host: "127.0.0.1" },
          signal: AbortSignal.timeout(5_000),
          redirect: "error",
        });

        if (response.ok) {
          console.log("Node promoted to primary.");
        } else {
          const body = await response.text();
          console.error(`Promote failed: ${body}`);
          process.exitCode = 1;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to promote: ${message}`);
        process.exitCode = 1;
      }
    });

  // -- demote ---------------------------------------------------------------

  cmd
    .command("demote")
    .description("Demote this node to secondary")
    .option("--port <port>", "Health server port", "9820")
    .action(async (opts: { port: string }) => {
      const port = Number.parseInt(opts.port, 10);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/replication/demote`, {
          method: "POST",
          headers: { Host: "127.0.0.1" },
          signal: AbortSignal.timeout(5_000),
          redirect: "error",
        });

        if (response.ok) {
          console.log("Node demoted to secondary.");
        } else {
          const body = await response.text();
          console.error(`Demote failed: ${body}`);
          process.exitCode = 1;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to demote: ${message}`);
        process.exitCode = 1;
      }
    });
}
