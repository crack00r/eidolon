/**
 * Channel setup and wiring for the daemon.
 *
 * Initializes Telegram, Discord, WhatsApp, and Email channels,
 * wires their inbound messages to the MessageRouter -> EventBus pipeline,
 * and registers them for outbound routing.
 */

import type { EidolonConfig } from "@eidolon/protocol";
import { BunImapClient } from "../channels/email/imap.ts";
import { BunSmtpClient } from "../channels/email/smtp.ts";
import { MessageRouter } from "../channels/router.ts";
import type { TelegramConfig } from "../channels/telegram/channel.ts";
import { TelegramChannel } from "../channels/telegram/channel.ts";
import type { WhatsAppApiConfig } from "../channels/whatsapp/api.ts";
import { WhatsAppCloudApi } from "../channels/whatsapp/api.ts";
import type { WhatsAppChannelConfig } from "../channels/whatsapp/channel.ts";
import { WhatsAppChannel } from "../channels/whatsapp/channel.ts";
import type { EmailChannelConfig } from "../channels/email/channel.ts";
import { EmailChannel } from "../channels/email/channel.ts";
import type { Logger } from "../logging/logger.ts";
import type { InitializedModules } from "./types.ts";

// ---------------------------------------------------------------------------
// Public: wire all configured channels
// ---------------------------------------------------------------------------

export async function wireChannels(modules: InitializedModules): Promise<void> {
  const logger = modules.logger;
  const config = modules.config;
  const eventBus = modules.eventBus;

  if (!eventBus || !logger) {
    logger?.warn("daemon", "MessageRouter skipped: EventBus not available");
    return;
  }

  try {
    const dndSchedule = config?.channels.telegram?.dndSchedule;
    modules.messageRouter = new MessageRouter(eventBus, logger, {
      dndSchedule: dndSchedule ? { start: dndSchedule.start, end: dndSchedule.end } : undefined,
    });

    await wireTelegram(modules, config, logger);
    wireDiscord(modules, config, logger);
    await wireWhatsApp(modules, config, logger);
    await wireEmail(modules, config, logger);

    if (
      !config?.channels.telegram?.enabled &&
      !config?.channels.discord?.enabled &&
      !config?.channels.whatsapp?.enabled &&
      !config?.channels.email?.enabled
    ) {
      logger.info("daemon", "No channel adapters configured");
    }

    logger.info("daemon", "MessageRouter initialized");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("daemon", `MessageRouter skipped: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function wireTelegram(modules: InitializedModules, config: EidolonConfig | undefined, logger: Logger): Promise<void> {
  if (!config?.channels.telegram?.enabled) return;

  const tgConfig = config.channels.telegram;
  const botToken = tgConfig.botToken;

  if (typeof botToken !== "string") {
    logger.warn(
      "daemon",
      "Telegram channel skipped: botToken is an unresolved secret reference. " +
        "Ensure the master key is set and the secret exists.",
    );
    return;
  }

  const telegramConfig: TelegramConfig = {
    botToken,
    allowedUserIds: tgConfig.allowedUserIds,
    typingIndicator: true,
  };

  const channel = new TelegramChannel(telegramConfig, logger);

  // Wire inbound messages from Telegram -> MessageRouter -> EventBus
  channel.onMessage(async (message) => {
    const result = modules.messageRouter?.routeInbound(message);
    if (result && !result.ok) {
      logger.error("daemon", "Failed to route Telegram inbound message", undefined, {
        messageId: message.id,
        error: result.error.message,
      });
    }
  });

  // Register channel with the router for outbound routing
  modules.messageRouter?.registerChannel(channel);

  // Connect (start long polling)
  const connectResult = await channel.connect();
  if (connectResult.ok) {
    modules.telegramChannel = channel;
    logger.info("daemon", "Telegram channel connected");
  } else {
    logger.error("daemon", `Telegram channel failed to connect: ${connectResult.error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

function wireDiscord(_modules: InitializedModules, config: EidolonConfig | undefined, logger: Logger): void {
  if (!config?.channels.discord?.enabled) return;

  const dcConfig = config.channels.discord;
  const botToken = dcConfig.botToken;

  if (typeof botToken !== "string") {
    logger.warn(
      "daemon",
      "Discord channel skipped: botToken is an unresolved secret reference. " +
        "Ensure the master key is set and the secret exists.",
    );
    return;
  }

  // Discord requires a real discord.js client in production.
  // The daemon expects an IDiscordClient to be provided externally
  // or uses a default stub that logs a warning.
  logger.warn(
    "daemon",
    "Discord channel configured but no IDiscordClient implementation provided. " +
      "Discord integration requires discord.js to be installed and a client adapter to be wired.",
  );
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

async function wireWhatsApp(modules: InitializedModules, config: EidolonConfig | undefined, logger: Logger): Promise<void> {
  if (!config?.channels.whatsapp?.enabled) return;

  const waConfig = config.channels.whatsapp;
  const accessToken = waConfig.accessToken;
  const verifyToken = waConfig.verifyToken;
  const appSecret = waConfig.appSecret;

  if (typeof accessToken !== "string" || typeof verifyToken !== "string" || typeof appSecret !== "string") {
    logger.warn(
      "daemon",
      "WhatsApp channel skipped: one or more secrets (accessToken, verifyToken, appSecret) " +
        "are unresolved secret references. Ensure the master key is set and secrets exist.",
    );
    return;
  }

  const apiConfig: WhatsAppApiConfig = {
    phoneNumberId: waConfig.phoneNumberId,
    accessToken,
  };
  const api = new WhatsAppCloudApi(apiConfig, logger);

  const channelConfig: WhatsAppChannelConfig = {
    phoneNumberId: waConfig.phoneNumberId,
    accessToken,
    verifyToken,
    appSecret,
    allowedPhoneNumbers: waConfig.allowedPhoneNumbers,
  };
  const channel = new WhatsAppChannel(channelConfig, api, logger);

  // Wire inbound messages from WhatsApp -> MessageRouter -> EventBus
  channel.onMessage(async (message) => {
    const result = modules.messageRouter?.routeInbound(message);
    if (result && !result.ok) {
      logger.error("daemon", "Failed to route WhatsApp inbound message", undefined, {
        messageId: message.id,
        error: result.error.message,
      });
    }
  });

  // Register channel with the router for outbound routing
  modules.messageRouter?.registerChannel(channel);

  // Connect (webhook mode -- just marks as ready)
  const connectResult = await channel.connect();
  if (connectResult.ok) {
    modules.whatsappChannel = channel;
    logger.info("daemon", "WhatsApp channel connected");
  } else {
    logger.error("daemon", `WhatsApp channel failed to connect: ${connectResult.error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

async function wireEmail(modules: InitializedModules, config: EidolonConfig | undefined, logger: Logger): Promise<void> {
  if (!config?.channels.email?.enabled) return;

  const emailConfig = config.channels.email;
  const imapPassword = emailConfig.imap.password;
  const smtpPassword = emailConfig.smtp.password;

  if (typeof imapPassword !== "string" || typeof smtpPassword !== "string") {
    logger.warn(
      "daemon",
      "Email channel skipped: one or more secrets (imap.password, smtp.password) " +
        "are unresolved secret references. Ensure the master key is set and secrets exist.",
    );
    return;
  }

  const imapClient = new BunImapClient({
    host: emailConfig.imap.host,
    port: emailConfig.imap.port,
    tls: emailConfig.imap.tls,
    user: emailConfig.imap.user,
    password: imapPassword,
    folder: emailConfig.imap.folder,
  });

  const smtpClient = new BunSmtpClient({
    host: emailConfig.smtp.host,
    port: emailConfig.smtp.port,
    tls: emailConfig.smtp.tls,
    user: emailConfig.smtp.user,
    password: smtpPassword,
    from: emailConfig.smtp.from,
  });

  const channelConfig: EmailChannelConfig = {
    imap: {
      host: emailConfig.imap.host,
      port: emailConfig.imap.port,
      tls: emailConfig.imap.tls,
      user: emailConfig.imap.user,
      password: imapPassword,
      pollIntervalMs: emailConfig.imap.pollIntervalMs,
      folder: emailConfig.imap.folder,
    },
    smtp: {
      host: emailConfig.smtp.host,
      port: emailConfig.smtp.port,
      tls: emailConfig.smtp.tls,
      user: emailConfig.smtp.user,
      password: smtpPassword,
      from: emailConfig.smtp.from,
    },
    allowedSenders: emailConfig.allowedSenders,
    subjectPrefix: emailConfig.subjectPrefix,
    maxAttachmentSizeMb: emailConfig.maxAttachmentSizeMb,
    threadingEnabled: emailConfig.threadingEnabled,
  };

  const channel = new EmailChannel(channelConfig, imapClient, smtpClient, logger);

  // Wire inbound messages from Email -> MessageRouter -> EventBus
  channel.onMessage(async (message) => {
    const result = modules.messageRouter?.routeInbound(message);
    if (result && !result.ok) {
      logger.error("daemon", "Failed to route Email inbound message", undefined, {
        messageId: message.id,
        error: result.error.message,
      });
    }
  });

  // Register channel with the router for outbound routing
  modules.messageRouter?.registerChannel(channel);

  // Connect (IMAP + SMTP)
  const connectResult = await channel.connect();
  if (connectResult.ok) {
    modules.emailChannel = channel;
    logger.info("daemon", "Email channel connected");
  } else {
    logger.error("daemon", `Email channel failed to connect: ${connectResult.error.message}`);
  }
}
