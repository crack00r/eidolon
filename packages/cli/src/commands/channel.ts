/**
 * eidolon channel -- communication channel management.
 *
 * Subcommands:
 *   status -- show status of all configured channels
 */

import { loadConfig } from "@eidolon/core";
import type { EidolonConfig } from "@eidolon/protocol";
import type { Command } from "commander";
import { formatTable } from "../utils/formatter.ts";

// ---------------------------------------------------------------------------
// Channel status data
// ---------------------------------------------------------------------------

interface ChannelStatusRow {
  [key: string]: string;
  Channel: string;
  Enabled: string;
  Status: string;
  Details: string;
}

/**
 * Inspect the config and build a status row for each known channel type.
 * Since we don't have a running daemon connection, we report based on config
 * (enabled/disabled and configuration completeness).
 */
function buildChannelStatuses(config: EidolonConfig): readonly ChannelStatusRow[] {
  const rows: ChannelStatusRow[] = [];

  // Telegram
  const telegram = config.channels.telegram;
  if (telegram) {
    const hasToken = Boolean(
      telegram.botToken &&
        (typeof telegram.botToken === "string" || ("$secret" in telegram.botToken && telegram.botToken.$secret)),
    );
    const userCount = telegram.allowedUserIds.length;
    rows.push({
      Channel: "telegram",
      Enabled: telegram.enabled ? "yes" : "no",
      Status: telegram.enabled && hasToken ? "configured" : "not configured",
      Details: telegram.enabled
        ? `${userCount} allowed user${userCount !== 1 ? "s" : ""}${telegram.dndSchedule ? `, DND ${telegram.dndSchedule.start}-${telegram.dndSchedule.end}` : ""}`
        : "disabled in config",
    });
  } else {
    rows.push({
      Channel: "telegram",
      Enabled: "no",
      Status: "not configured",
      Details: "no telegram section in config",
    });
  }

  // Discord
  const discord = config.channels.discord;
  if (discord) {
    const hasToken = Boolean(
      discord.botToken &&
        (typeof discord.botToken === "string" || ("$secret" in discord.botToken && discord.botToken.$secret)),
    );
    rows.push({
      Channel: "discord",
      Enabled: discord.enabled ? "yes" : "no",
      Status: discord.enabled && hasToken ? "configured" : "not configured",
      Details: discord.enabled ? `guild: ${discord.guildId ?? "(not set)"}` : "disabled in config",
    });
  } else {
    rows.push({
      Channel: "discord",
      Enabled: "no",
      Status: "not configured",
      Details: "no discord section in config",
    });
  }

  // WhatsApp
  const whatsapp = config.channels.whatsapp;
  if (whatsapp) {
    const hasToken = Boolean(
      whatsapp.accessToken &&
        (typeof whatsapp.accessToken === "string" ||
          ("$secret" in whatsapp.accessToken && whatsapp.accessToken.$secret)),
    );
    rows.push({
      Channel: "whatsapp",
      Enabled: whatsapp.enabled ? "yes" : "no",
      Status: whatsapp.enabled && hasToken ? "configured" : "not configured",
      Details: whatsapp.enabled ? `phone: ${whatsapp.phoneNumberId ?? "(not set)"}` : "disabled in config",
    });
  } else {
    rows.push({
      Channel: "whatsapp",
      Enabled: "no",
      Status: "not configured",
      Details: "no whatsapp section in config",
    });
  }

  // Email
  const email = config.channels.email;
  if (email) {
    rows.push({
      Channel: "email",
      Enabled: email.enabled ? "yes" : "no",
      Status: email.enabled ? "configured" : "not configured",
      Details: email.enabled
        ? `IMAP: ${email.imap?.host ?? "(not set)"}, SMTP: ${email.smtp?.host ?? "(not set)"}`
        : "disabled in config",
    });
  } else {
    rows.push({
      Channel: "email",
      Enabled: "no",
      Status: "not configured",
      Details: "no email section in config",
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerChannelCommand(program: Command): void {
  const cmd = program.command("channel").description("Manage communication channels");

  cmd
    .command("status")
    .description("Show status of all configured channels")
    .action(async () => {
      const configResult = await loadConfig();
      if (!configResult.ok) {
        console.error(`Error: ${configResult.error.message}`);
        process.exitCode = 1;
        return;
      }

      const config = configResult.value;
      const statuses = buildChannelStatuses(config);

      const enabledCount = statuses.filter((s) => s.Enabled === "yes").length;
      const configuredCount = statuses.filter((s) => s.Status === "configured").length;

      console.log(`Channels: ${enabledCount} enabled, ${configuredCount} configured`);
      console.log("");
      console.log(formatTable([...statuses], ["Channel", "Enabled", "Status", "Details"]));
      console.log("");
      console.log("Note: live connection status requires a running daemon.");
      console.log("Use 'eidolon daemon status' to check if the daemon is running.");
    });
}

// Export for testing
export { buildChannelStatuses };
