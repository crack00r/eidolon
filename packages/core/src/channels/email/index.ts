export type { EmailChannelConfig } from "./channel.ts";
export { EmailChannel } from "./channel.ts";
export { buildEmailHtml, buildReplySubject, formatEmailResponse, markdownToEmailHtml } from "./formatter.ts";
export type { IImapClient, ImapAttachment, ImapConfig, ImapMessage } from "./imap.ts";
export { BunImapClient } from "./imap.ts";
export type { ThreadInfo } from "./parser.ts";
export {
  extractThreadInfo,
  isValidEmail,
  parseEmailBody,
  sanitizeEmailContent,
  stripQuotedReply,
  stripSignature,
} from "./parser.ts";
export type { ISmtpClient, SmtpAttachment, SmtpConfig, SmtpMessage } from "./smtp.ts";
export { BunSmtpClient, buildMimeMessage } from "./smtp.ts";
