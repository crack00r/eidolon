/**
 * Server-side APNs (Apple Push Notification service) client.
 *
 * Uses HTTP/2 to communicate with Apple's APNs gateway.
 * JWT-based authentication with automatic token refresh.
 * Manages device token registration in operational.db.
 */

import type { Database } from "bun:sqlite";
import { createSign } from "node:crypto";
import * as http2 from "node:http2";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApnsPayload {
  readonly alert: {
    readonly title: string;
    readonly body: string;
  };
  readonly badge?: number;
  readonly sound?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface ApnsConfig {
  /** Apple Developer Team ID (10 characters). */
  readonly teamId: string;
  /** APNs Key ID (10 characters, from the .p8 key in Developer Portal). */
  readonly keyId: string;
  /** PEM-encoded private key contents (from the .p8 file). */
  readonly privateKey: string;
  /** APNs topic — typically the app bundle identifier. */
  readonly bundleId: string;
  /** Use sandbox (api.sandbox.push.apple.com) instead of production. */
  readonly sandbox?: boolean;
  /** Override retry delay in milliseconds (default 5000). Useful for testing. */
  readonly retryDelayMs?: number;
}

interface ApnsJwt {
  readonly token: string;
  readonly issuedAt: number;
}

/** Minimum interval between retry attempts on 429 (milliseconds). */
const RATE_LIMIT_RETRY_DELAY_MS = 5_000;
/** Maximum retry attempts for transient errors (429, 5xx). */
const MAX_RETRIES = 3;
/** JWT tokens are valid for up to 60 minutes; we refresh at 50 min. */
const JWT_REFRESH_INTERVAL_MS = 50 * 60 * 1_000;

/**
 * APNs device token format: 64-character hex string (production).
 * Sandbox tokens can also be 64 hex chars; we enforce hex-only with length 64.
 */
const DEVICE_TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;

const APNS_PRODUCTION_HOST = "api.push.apple.com";
const APNS_SANDBOX_HOST = "api.sandbox.push.apple.com";

// ---------------------------------------------------------------------------
// APNs Client
// ---------------------------------------------------------------------------

/** Timeout for individual APNs HTTP/2 requests (30 seconds). */
const REQUEST_TIMEOUT_MS = 30_000;

export class ApnsClient {
  private readonly config: ApnsConfig;
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly host: string;
  private cachedJwt: ApnsJwt | null = null;
  private http2Session: http2.ClientHttp2Session | null = null;

  constructor(config: ApnsConfig, db: Database, logger: Logger) {
    this.config = config;
    this.db = db;
    this.logger = logger.child("apns");
    this.host = config.sandbox ? APNS_SANDBOX_HOST : APNS_PRODUCTION_HOST;
  }

  /** Get or create a reusable HTTP/2 session. Reconnects on error or if closed. */
  private getHttp2Session(): http2.ClientHttp2Session {
    if (this.http2Session && !this.http2Session.closed && !this.http2Session.destroyed) {
      return this.http2Session;
    }

    const session = http2.connect(`https://${this.host}`);
    session.on("error", (err) => {
      this.logger.error("http2", "Session error, will reconnect on next request", err);
      this.closeHttp2Session();
    });
    session.on("close", () => {
      this.http2Session = null;
    });
    this.http2Session = session;
    return session;
  }

  /** Close the cached HTTP/2 session. */
  private closeHttp2Session(): void {
    if (this.http2Session) {
      try {
        this.http2Session.close();
      } catch {
        // Already closed
      }
      this.http2Session = null;
    }
  }

  /** Close the HTTP/2 session. Call when shutting down the client. */
  close(): void {
    this.closeHttp2Session();
  }

  // -----------------------------------------------------------------------
  // Device Token Management
  // -----------------------------------------------------------------------

  /** Register a device token for push notifications. */
  registerDeviceToken(token: string, platform: string): Result<void, EidolonError> {
    if (!DEVICE_TOKEN_PATTERN.test(token)) {
      return Err(createError(ErrorCode.APNS_SEND_FAILED, "Invalid device token: must be a 64-character hex string"));
    }

    try {
      const now = Date.now();
      this.db
        .query(
          `INSERT INTO device_tokens (token, platform, created_at, last_used_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(token) DO UPDATE SET last_used_at = excluded.last_used_at`,
        )
        .run(token, platform, now, now);

      this.logger.info("register", "Device token registered", { platform });
      return Ok(undefined);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to register device token: ${message}`, err));
    }
  }

  /** Unregister a device token (e.g. user logged out or token invalidated by APNs 410). */
  unregisterDeviceToken(token: string): Result<void, EidolonError> {
    try {
      this.db.query("DELETE FROM device_tokens WHERE token = ?").run(token);
      this.logger.info("unregister", "Device token removed");
      return Ok(undefined);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to unregister device token: ${message}`, err));
    }
  }

  /** Get all registered device tokens, optionally filtered by platform. */
  getDeviceTokens(platform?: string): Result<readonly string[], EidolonError> {
    try {
      const rows = platform
        ? (this.db.query("SELECT token FROM device_tokens WHERE platform = ?").all(platform) as Array<{
            token: string;
          }>)
        : (this.db.query("SELECT token FROM device_tokens").all() as Array<{ token: string }>);

      return Ok(rows.map((r) => r.token));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get device tokens: ${message}`, err));
    }
  }

  // -----------------------------------------------------------------------
  // Push Notification Sending
  // -----------------------------------------------------------------------

  /** Send a push notification to a single device. */
  async sendPushNotification(deviceToken: string, payload: ApnsPayload): Promise<Result<void, EidolonError>> {
    if (!DEVICE_TOKEN_PATTERN.test(deviceToken)) {
      return Err(createError(ErrorCode.APNS_SEND_FAILED, "Invalid device token: must be a 64-character hex string"));
    }

    const jwtResult = this.getJwt();
    if (!jwtResult.ok) return jwtResult;

    const apnsPayload = this.buildApnsPayload(payload);
    const body = JSON.stringify(apnsPayload);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const result = await this.sendRequest(deviceToken, body, jwtResult.value);

      if (result.ok) {
        this.touchDeviceToken(deviceToken);
        return Ok(undefined);
      }

      const error = result.error;

      // 410 Gone — device unregistered, auto-remove token
      if (error.code === ErrorCode.APNS_DEVICE_UNREGISTERED) {
        this.logger.warn("send", "Device unregistered (410), removing token");
        this.unregisterDeviceToken(deviceToken);
        return result;
      }

      // 429 Rate limited — retry with delay
      if (error.code === ErrorCode.APNS_RATE_LIMITED && attempt < MAX_RETRIES) {
        const delayMs = this.config.retryDelayMs ?? RATE_LIMIT_RETRY_DELAY_MS;
        this.logger.warn("send", `Rate limited (429), retrying in ${delayMs}ms`, {
          attempt: attempt + 1,
        });
        await sleep(delayMs);
        continue;
      }

      // Non-retryable error — return immediately
      return result;
    }

    return Err(createError(ErrorCode.APNS_SEND_FAILED, "Max retries exceeded for APNs request"));
  }

  // -----------------------------------------------------------------------
  // JWT Generation
  // -----------------------------------------------------------------------

  /** Get a cached JWT or generate a new one. */
  private getJwt(): Result<string, EidolonError> {
    const now = Date.now();
    if (this.cachedJwt && now - this.cachedJwt.issuedAt < JWT_REFRESH_INTERVAL_MS) {
      return Ok(this.cachedJwt.token);
    }

    try {
      const token = this.generateJwt(now);
      this.cachedJwt = { token, issuedAt: now };
      return Ok(token);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.APNS_AUTH_FAILED, `Failed to generate APNs JWT: ${message}`, err));
    }
  }

  /** Generate a new ES256 JWT for APNs authentication. */
  private generateJwt(nowMs: number): string {
    const header = {
      alg: "ES256",
      kid: this.config.keyId,
    };
    const claims = {
      iss: this.config.teamId,
      iat: Math.floor(nowMs / 1000),
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedClaims = base64UrlEncode(JSON.stringify(claims));
    const signingInput = `${encodedHeader}.${encodedClaims}`;

    const sign = createSign("SHA256");
    sign.update(signingInput);
    const signature = sign.sign(this.config.privateKey);
    const encodedSignature = base64UrlEncodeBuffer(signature);

    return `${signingInput}.${encodedSignature}`;
  }

  // -----------------------------------------------------------------------
  // HTTP/2 Request
  // -----------------------------------------------------------------------

  /** Send a single HTTP/2 request to APNs and interpret the response. */
  private sendRequest(deviceToken: string, body: string, jwt: string): Promise<Result<void, EidolonError>> {
    return new Promise((resolve) => {
      try {
        const client = this.getHttp2Session();

        const headers: http2.OutgoingHttpHeaders = {
          ":method": "POST",
          ":path": `/3/device/${deviceToken}`,
          authorization: `bearer ${jwt}`,
          "apns-topic": this.config.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "content-type": "application/json",
        };

        const req = client.request(headers);
        let responseStatus = 0;
        const responseChunks: Buffer[] = [];

        // Request timeout
        const timer = setTimeout(() => {
          req.close();
          this.closeHttp2Session();
          resolve(Err(createError(ErrorCode.APNS_SEND_FAILED, `APNs request timed out after ${REQUEST_TIMEOUT_MS}ms`)));
        }, REQUEST_TIMEOUT_MS);

        req.on("response", (hdrs) => {
          const status = hdrs[":status"];
          responseStatus = typeof status === "number" ? status : 0;
        });

        req.on("data", (chunk: Buffer) => {
          responseChunks.push(chunk);
        });

        req.on("end", () => {
          clearTimeout(timer);
          const responseBody = Buffer.concat(responseChunks).toString("utf-8");
          resolve(this.interpretResponse(responseStatus, responseBody));
        });

        req.on("error", (err) => {
          clearTimeout(timer);
          this.closeHttp2Session();
          resolve(Err(createError(ErrorCode.APNS_SEND_FAILED, `APNs request error: ${err.message}`, err)));
        });

        req.write(body);
        req.end();
      } catch (err: unknown) {
        this.closeHttp2Session();
        const message = err instanceof Error ? err.message : String(err);
        resolve(Err(createError(ErrorCode.APNS_SEND_FAILED, `Failed to send APNs request: ${message}`, err)));
      }
    });
  }

  /** Interpret the APNs HTTP response status. */
  private interpretResponse(status: number, body: string): Result<void, EidolonError> {
    if (status === 200) {
      return Ok(undefined);
    }

    let reason = "Unknown";
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null && "reason" in parsed) {
        const r = (parsed as { reason: unknown }).reason;
        if (typeof r === "string") {
          reason = r;
        }
      }
    } catch {
      // Response body may not be JSON
    }

    if (status === 400) {
      return Err(createError(ErrorCode.APNS_SEND_FAILED, `APNs bad request (400): ${reason}`));
    }
    if (status === 403) {
      return Err(createError(ErrorCode.APNS_AUTH_FAILED, `APNs authentication failed (403): ${reason}`));
    }
    if (status === 410) {
      return Err(createError(ErrorCode.APNS_DEVICE_UNREGISTERED, `Device token unregistered (410): ${reason}`));
    }
    if (status === 429) {
      return Err(createError(ErrorCode.APNS_RATE_LIMITED, `APNs rate limited (429): ${reason}`));
    }

    return Err(createError(ErrorCode.APNS_SEND_FAILED, `APNs error (${status}): ${reason}`));
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Build the APNs JSON payload structure. */
  private buildApnsPayload(payload: ApnsPayload): Record<string, unknown> {
    const aps: Record<string, unknown> = {
      alert: {
        title: payload.alert.title,
        body: payload.alert.body,
      },
    };

    if (payload.badge !== undefined) {
      aps.badge = payload.badge;
    }
    if (payload.sound !== undefined) {
      aps.sound = payload.sound;
    } else {
      aps.sound = "default";
    }

    const result: Record<string, unknown> = { aps };

    if (payload.data) {
      for (const [key, value] of Object.entries(payload.data)) {
        result[key] = value;
      }
    }

    return result;
  }

  /** Update the last_used_at timestamp for a device token. */
  private touchDeviceToken(token: string): void {
    try {
      this.db.query("UPDATE device_tokens SET last_used_at = ? WHERE token = ?").run(Date.now(), token);
    } catch (err: unknown) {
      this.logger.warn("touch", "Failed to update device token timestamp", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

function base64UrlEncode(str: string): string {
  return Buffer.from(str, "utf-8").toString("base64url");
}

function base64UrlEncodeBuffer(buf: Buffer): string {
  return buf.toString("base64url");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
