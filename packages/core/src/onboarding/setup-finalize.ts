/**
 * Config builder and writer for onboarding finalization.
 *
 * Builds server and client config objects, and writes them to disk
 * with restricted permissions (0o600).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";

export interface ServerConfigInput {
  readonly ownerName: string;
  readonly claudeCredential: {
    readonly type: string;
    readonly name: string;
    readonly credential: string | { readonly $secret: string };
  };
  readonly gateway: Record<string, unknown>;
  readonly dataDir: string;
}

export interface ClientConfigInput {
  readonly host: string;
  readonly port: number;
  readonly token?: string;
  readonly tls?: boolean;
}

export function buildServerConfig(input: ServerConfigInput): Record<string, unknown> {
  return {
    role: "server",
    identity: { name: "Eidolon", ownerName: input.ownerName },
    brain: { accounts: [input.claudeCredential], model: {}, session: {} },
    loop: { energyBudget: { categories: {} }, rest: {}, businessHours: {} },
    memory: {
      extraction: {},
      dreaming: {},
      search: {},
      embedding: {},
      retention: {},
      entityResolution: {},
    },
    learning: { relevance: {}, autoImplement: {}, budget: {} },
    channels: {},
    gateway: input.gateway,
    gpu: { tts: {}, stt: {}, fallback: {} },
    security: { policies: {}, approval: {}, sandbox: {}, audit: {} },
    database: { directory: input.dataDir },
    logging: {},
    daemon: {},
  };
}

export function buildClientConfig(server: ClientConfigInput): Record<string, unknown> {
  return {
    role: "client",
    server: {
      host: server.host,
      port: server.port,
      token: server.token,
      tls: server.tls ?? false,
    },
    identity: { name: "Eidolon", ownerName: "Client" },
    brain: {
      accounts: [{ type: "oauth", name: "primary", credential: "oauth" }],
      model: {},
      session: {},
    },
    loop: { energyBudget: { categories: {} }, rest: {}, businessHours: {} },
    memory: {
      extraction: {},
      dreaming: {},
      search: {},
      embedding: {},
      retention: {},
      entityResolution: {},
    },
    learning: { relevance: {}, autoImplement: {}, budget: {} },
    channels: {},
    gateway: { auth: { type: "none" } },
    gpu: { tts: {}, stt: {}, fallback: {} },
    security: { policies: {}, approval: {}, sandbox: {}, audit: {} },
    database: {},
    logging: {},
    daemon: {},
  };
}

export function writeConfig(path: string, config: Record<string, unknown>): Result<void, EidolonError> {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
    return Ok(undefined);
  } catch (cause) {
    return Err(createError(ErrorCode.INVALID_STATE, `Failed to write config: ${cause}`, cause));
  }
}
