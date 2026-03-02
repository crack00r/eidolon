/**
 * eidolon pair -- print pairing URL and connection details.
 *
 * Reads the current config and generates a pairing URL that clients
 * can use to connect to this Eidolon instance.
 */

import { loadConfig } from "@eidolon/core";
import { VERSION } from "@eidolon/protocol";
import type { Command } from "commander";
import { createLogger } from "./pair-logger.ts";

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPairCommand(program: Command): void {
  program
    .command("pair")
    .description("Show pairing URL and connection details for clients")
    .option("--json", "Output as JSON for QR code generation", false)
    .action(async (opts: { json: boolean }) => {
      const configResult = await loadConfig();
      if (!configResult.ok) {
        console.error(`Error: ${configResult.error.message}`);
        console.error("Run 'eidolon onboard' first to create a configuration.");
        process.exitCode = 1;
        return;
      }

      // Dynamic imports to avoid mock.module issues in test suite
      const { buildPairingUrl, formatConnectionDetails, getLocalIpAddresses, TailscaleDetector } = await import(
        "@eidolon/core"
      );

      const config = configResult.value;
      const logger = createLogger();

      // Quick Tailscale check
      const tailscale = new TailscaleDetector(logger);
      await tailscale.getInfo();

      if (opts.json) {
        const pairing = buildPairingUrl(config.gateway, tailscale);
        console.log(
          JSON.stringify(
            {
              host: pairing.host,
              port: pairing.port,
              token: pairing.token,
              tls: pairing.tls,
              ...(pairing.tailscaleIp ? { tailscaleIp: pairing.tailscaleIp } : {}),
              version: pairing.version,
              localAddresses: getLocalIpAddresses(),
            },
            null,
            2,
          ),
        );
      } else {
        console.log(`\n  Eidolon v${VERSION} -- Pairing Information`);
        console.log(formatConnectionDetails(config.gateway, tailscale));

        const addresses = getLocalIpAddresses();
        if (addresses.length > 1) {
          console.log("  Local addresses:");
          for (const addr of addresses) {
            console.log(`    - ${addr}`);
          }
          console.log();
        }

        console.log("  Share the Pairing URL with your client devices.");
        console.log("  Use 'eidolon pair --json' for machine-readable output.");
        console.log();
      }

      tailscale.stop();
    });
}
