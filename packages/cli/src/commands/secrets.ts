/**
 * eidolon secrets set|get|list|delete -- secret management.
 * Fully implemented in Phase 0.
 */

import { join } from "node:path";
import { getDataDir, getMasterKey, SecretStore } from "@eidolon/core";
import type { SecretMetadata } from "@eidolon/protocol";
import { SECRETS_DB_FILENAME } from "@eidolon/protocol";
import type { Command } from "commander";
import { formatTable } from "../utils/formatter.js";

function openStore(): SecretStore | null {
  const keyResult = getMasterKey();
  if (!keyResult.ok) {
    console.error(`Error: ${keyResult.error.message}`);
    process.exitCode = 1;
    return null;
  }
  const dbPath = join(getDataDir(), SECRETS_DB_FILENAME);
  return new SecretStore(dbPath, keyResult.value);
}

export function registerSecretsCommand(program: Command): void {
  const cmd = program.command("secrets").description("Manage encrypted secrets");

  cmd
    .command("set <key>")
    .description("Store an encrypted secret")
    .requiredOption("--value <value>", "Secret value to store")
    .option("-d, --description <description>", "Description of the secret")
    .action((key: string, options: { readonly value: string; readonly description?: string }) => {
      const store = openStore();
      if (!store) return;
      try {
        const result = store.set(key, options.value, options.description);
        if (!result.ok) {
          console.error(`Error: ${result.error.message}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Secret '${key}' stored successfully.`);
      } finally {
        store.close();
      }
    });

  cmd
    .command("get <key>")
    .description("Retrieve a secret")
    .option("--reveal", "Show the actual value (default: masked)")
    .action((key: string, options: { readonly reveal?: boolean }) => {
      const store = openStore();
      if (!store) return;
      try {
        const result = store.get(key);
        if (!result.ok) {
          console.error(`Error: ${result.error.message}`);
          process.exitCode = 1;
          return;
        }
        if (options.reveal) {
          console.log(result.value);
        } else {
          // Fixed-length mask: always 4 asterisks + last 4 chars (if long enough)
          // to avoid leaking the secret's length via mask length
          const value = result.value;
          if (value.length > 4) {
            console.log(`****${value.slice(-4)}`);
          } else {
            console.log("********");
          }
        }
      } finally {
        store.close();
      }
    });

  cmd
    .command("list")
    .description("List all secret keys (never shows values)")
    .action(() => {
      const store = openStore();
      if (!store) return;
      try {
        const result = store.list();
        if (!result.ok) {
          console.error(`Error: ${result.error.message}`);
          process.exitCode = 1;
          return;
        }
        if (result.value.length === 0) {
          console.log("No secrets stored.");
          return;
        }
        const rows = result.value.map((s: SecretMetadata) => ({
          Key: s.key,
          Description: s.description ?? "",
          Created: new Date(s.createdAt).toISOString(),
          Updated: new Date(s.updatedAt).toISOString(),
        }));
        console.log(formatTable(rows, ["Key", "Description", "Created", "Updated"]));
      } finally {
        store.close();
      }
    });

  cmd
    .command("delete <key>")
    .description("Delete a secret")
    .action((key: string) => {
      const store = openStore();
      if (!store) return;
      try {
        const result = store.delete(key);
        if (!result.ok) {
          console.error(`Error: ${result.error.message}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Secret '${key}' deleted.`);
      } finally {
        store.close();
      }
    });
}
