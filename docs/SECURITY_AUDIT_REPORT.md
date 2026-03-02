# Security Audit Master Report

> **Date:** 2026-03-03
> **Scope:** Full codebase security audit of the Eidolon project (all packages, services, CI workflows, dependencies)
> **Method:** 8 independent security audits covering supply chain, secrets management, network/gateway, configuration, database/audit integrity, CI/CD, voice/GPU pipeline, and client architecture
> **Codebase Version:** v0.1.4 (commit 17f428e, branch main)

---

## Executive Summary

Eight focused security audits were conducted across the entire Eidolon codebase. The audits examined supply chain dependencies, secrets management and cryptography, network and gateway security, configuration system integrity, database and audit trail protection, CI/CD pipeline security, voice and GPU worker pipeline, and client architecture.

**44+ distinct findings** were identified across four severity levels. The most critical issues involve a pre-release dependency in production, a broken audit log integrity hash chain, environment variable overrides that can disable security controls, and a race condition in configuration hot-reload validation.

High-severity findings cluster around three themes: (1) credential exposure through logs, URLs, and plaintext config files, (2) inconsistencies between documented and implemented cryptographic practices, and (3) insufficient authorization boundaries in the gateway and client execution model.

The codebase demonstrates strong security design intent (encrypted secrets, audit logging, action classification, locked config fields), but implementation gaps undermine several of these controls. No findings indicate active exploitation or data loss.

**Immediate action is required for the 4 CRITICAL findings.** HIGH findings should be addressed before any production deployment. MEDIUM and LOW findings should be scheduled into regular development sprints.

---

## Severity Statistics

| Severity | Count | Description |
|----------|------:|-------------|
| CRITICAL | 4     | Immediate risk of security control bypass or data integrity loss |
| HIGH     | 15    | Significant risk requiring remediation before production use |
| MEDIUM   | 25+   | Moderate risk; defense-in-depth gaps or hardening opportunities |
| LOW      | 15+   | Minor issues; code quality, cleanup, or theoretical attack vectors |
| **Total** | **44+** | |

### Findings by Domain

| Audit Domain | CRIT | HIGH | MED | LOW | Total |
|-------------|-----:|-----:|----:|----:|------:|
| Supply Chain and Dependencies | 1 | 2 | 1 | 0 | 4 |
| Secrets and Cryptography | 0 | 2 | 2 | 1 | 5 |
| Network and Gateway | 0 | 3 | 3 | 1 | 7 |
| Configuration System | 2 | 0 | 2 | 0 | 4 |
| Database and Audit Integrity | 1 | 2 | 2 | 1 | 6 |
| CI/CD Pipeline | 0 | 1 | 1 | 0 | 2 |
| Voice and GPU Pipeline | 0 | 1 | 2 | 2 | 5 |
| Client Architecture | 0 | 2 | 2 | 1 | 5 |
| Cross-Cutting (logging, etc.) | 0 | 2 | 10+ | 9+ | 21+ |

---

## CRITICAL Findings

### CRIT-1: onnxruntime-web Pre-Release Dev Build in Production

| Attribute | Value |
|-----------|-------|
| **File** | pnpm-lock.yaml (onnxruntime-web dependency) |
| **Domain** | Supply Chain and Dependencies |
| **Found By** | Supply Chain Audit |

**Description:** The production dependency tree includes a pre-release or development build of onnxruntime-web. Pre-release builds are not subject to the same testing and review processes as stable releases and may contain experimental code, debug instrumentation, or unpatched vulnerabilities.

**Impact:** Unstable, potentially untested code running in production. Dev builds may include debug endpoints, verbose error messages exposing internals, or unreviewed security patches. The ONNX runtime has direct access to model inference, making it a high-value target.

**Remediation:** Pin onnxruntime-web to the latest stable release. Verify the pinned version against the official ONNX Runtime releases. Add a CI check that rejects pre-release versions in the dependency tree.

**Priority:** P0 -- fix immediately.

---

### CRIT-2: Audit Log Integrity Hash Chain Broken

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/database/schemas/audit.ts (line ~60) |
| **Domain** | Database and Audit Integrity |
| **Found By** | Database and Audit Integrity Audit |

**Description:** The audit log schema defines `integrity_hash TEXT NOT NULL DEFAULT ''`. The DEFAULT '' clause allows rows to be inserted with an empty hash, which breaks the hash chain that is supposed to guarantee tamper detection. Any row with an empty hash creates a gap in the chain, and all subsequent hashes built on that gap are meaningless.

**Code:**
```sql
ALTER TABLE audit_log ADD COLUMN integrity_hash TEXT NOT NULL DEFAULT '';
```

**Impact:** An attacker with database write access can insert, modify, or delete audit log entries without detection. The integrity hash chain, which is the primary tamper-evidence mechanism for the audit trail, provides no actual protection in its current form.

**Remediation:**
1. Remove DEFAULT '' from the column definition.
2. Enforce hash computation on every INSERT via an application-level check or a database trigger.
3. Add a startup integrity verification routine that walks the hash chain and alerts on any broken links.
4. Backfill existing rows with computed hashes if any empty-hash rows exist.

**Priority:** P0 -- fix immediately.

---

### CRIT-3: Environment Variables Can Disable Audit Logging

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/config/env.ts (lines 38-46) |
| **Domain** | Configuration System |
| **Found By** | Configuration System Audit |

**Description:** The environment variable override system allows any configuration field to be overridden, including security-critical fields. Specifically:
- EIDOLON_SECURITY_AUDIT_ENABLED=false disables audit logging entirely.
- EIDOLON_GATEWAY_AUTH_TYPE=none disables gateway authentication.

The config watcher has a LOCKED_FIELDS mechanism that prevents hot-reload changes to security fields, but the env override system has no equivalent protection. An attacker who gains the ability to set environment variables (e.g., via a compromised systemd override, container orchestrator, or CI variable) can silently disable security controls before the daemon starts.

**Impact:** Complete bypass of audit logging and/or gateway authentication via environment manipulation. This is especially dangerous because environment variable changes leave no trace in the audit log (since audit logging itself can be disabled).

**Remediation:**
1. Create an ENV_LOCKED_PATHS list parallel to the watcher's LOCKED_FIELDS.
2. In applyEnvOverrides(), reject overrides for any path in ENV_LOCKED_PATHS.
3. Log a CRITICAL-level warning (to stderr, not just the structured logger) if an attempt is made to override a locked field via environment.
4. The locked paths should include at minimum: security.audit.enabled, gateway.auth.type, gateway.auth.token, security.policies, database.directory.

**Priority:** P0 -- fix immediately.

---

### CRIT-4: First Hot-Reload Skips Locked-Field Check

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/config/watcher.ts (lines 105-110) |
| **Domain** | Configuration System |
| **Found By** | Configuration System Audit |

**Description:** The config watcher's locked-field validation compares the new config against currentConfig. When currentConfig is null (which occurs on the first reload after the watcher starts), the validation is skipped entirely. This means that on first hot-reload, security-critical fields like security, brain.accounts, and database can be changed without any check.

**Impact:** A race condition exists between daemon startup and the first config file modification. If an attacker can modify the config file after the daemon reads it initially but before the watcher initializes currentConfig, they can change security-critical fields that would normally be locked.

**Remediation:**
1. Initialize currentConfig from the loaded config before starting the file watcher.
2. Ensure the watcher constructor or start() method receives the initial config.
3. Add a test that verifies locked fields are rejected even on the first reload event.

**Priority:** P0 -- fix immediately.

---

## HIGH Findings

### HIGH-1: Auth Token in WebSocket URL Query Parameter

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/gpu/realtime-client.ts (line 292) |
| **Domain** | Network and Gateway / Voice and GPU Pipeline |
| **Found By** | 4 independent audits (Network, GPU, Gateway, Client) |

**Description:** The GPU worker real-time voice WebSocket connection embeds the authentication token in the URL query string:

```typescript
return `${wsBase}/voice/realtime?token=${encodeURIComponent(authToken)}`;
```

**Impact:** The authentication token appears in:
- Server access logs (default configurations of nginx, Apache, Caddy)
- Reverse proxy logs
- Network monitoring tools
- Browser developer tools and history (if used from a web client)
- HTTP Referer headers on any subsequent requests
- Tailscale logs (if URL logging is enabled)

This is the most frequently identified finding across all audits (4 out of 8 audits flagged it independently).

**Remediation:** Send the token in the first WebSocket message after connection establishment, or use the Sec-WebSocket-Protocol header for token transport. The server should reject connections that do not provide a valid token within a configurable timeout (e.g., 5 seconds) after the WebSocket handshake completes.

**Priority:** P1 -- fix before production deployment.

---

### HIGH-2: Gateway Auth Token Printed to stdout During Onboarding

| Attribute | Value |
|-----------|-------|
| **File** | packages/cli/src/commands/onboard.ts (lines 225, 554) |
| **Domain** | Secrets and Cryptography |
| **Found By** | Secrets and Cryptography Audit |

**Description:** During the onboarding wizard, the generated gateway authentication token is printed in full to stdout:

```typescript
console.log(`  Generated token: ${gatewayToken}`);
```

Additionally, the pairing URL (line 554) includes the token in a URL string that is displayed to the user.

**Impact:** The token is visible in terminal history (.bash_history, .zsh_history), terminal scrollback buffers, screen recordings, screen sharing sessions, and over-the-shoulder viewing. If the terminal output is logged (e.g., script command, CI logs), the token is persisted in plaintext.

**Remediation:**
1. Display only the first and last 4 characters of the token (e.g., abc1...xyz9).
2. Write the full token to a file with 0600 permissions, or instruct the user to retrieve it via `eidolon secrets get gateway-auth-token`.
3. For the pairing URL, use a short-lived pairing code instead of the permanent token.

**Priority:** P1 -- fix before production deployment.

---

### HIGH-3: Fixed Passphrase Salt Duplicated Across Files

| Attribute | Value |
|-----------|-------|
| **Files** | packages/core/src/secrets/crypto.ts (line 49), packages/core/src/secrets/master-key.ts (line 32) |
| **Domain** | Secrets and Cryptography |
| **Found By** | Secrets and Cryptography Audit |

**Description:** The same PASSPHRASE_SALT value is defined independently in two separate files:

```typescript
// crypto.ts line 49
export const PASSPHRASE_SALT = Buffer.from("eidolon-master-key-v1", "utf-8");

// master-key.ts line 32
const PASSPHRASE_SALT = Buffer.from("eidolon-master-key-v1", "utf-8");
```

Both files define the same constant with the same value, but master-key.ts defines its own private copy instead of importing from crypto.ts.

**Impact:** If one file's salt is updated during a future key derivation change but the other is not, key derivation will silently produce different keys depending on the code path. This would cause secret decryption failures or, worse, the appearance of successful decryption with corrupted data.

**Remediation:** Remove the duplicate definition in master-key.ts and import PASSPHRASE_SALT from crypto.ts. The crypto.ts export already exists (packages/core/src/secrets/index.ts line 7 re-exports it).

**Priority:** P1 -- fix before production deployment.

---

### HIGH-4: console.warn Bypasses Structured Logger

| Attribute | Value |
|-----------|-------|
| **Files** | packages/core/src/secrets/master-key.ts (lines 81-85), packages/core/src/database/connection.ts (lines 76-81) |
| **Domain** | Cross-Cutting |
| **Found By** | Secrets Audit, Database Audit |

**Description:** Security-relevant warnings use console.warn() instead of the structured Logger:
- In master-key.ts: warns about short passphrases (a security-relevant condition)
- In connection.ts: warns about database connection issues

**Impact:** These warnings bypass the structured logging pipeline, which means they:
- Do not appear in the JSON log files
- Are not captured by log aggregation systems
- Do not include timestamps, module identifiers, or trace IDs
- Cannot be monitored or alerted on
- Skip the audit trail entirely

**Remediation:** Replace all console.warn() calls in production code with logger.warn(). The Logger instance should be passed via dependency injection or created as a module-level child logger.

**Priority:** P1.

---

### HIGH-5: onnxruntime-node Postinstall Downloads Binaries Without Hash Verification

| Attribute | Value |
|-----------|-------|
| **File** | pnpm-lock.yaml (onnxruntime-node dependency) |
| **Domain** | Supply Chain and Dependencies |
| **Found By** | Supply Chain Audit |

**Description:** The onnxruntime-node package runs a postinstall script that downloads prebuilt native binaries from a remote server. These downloads are not verified against known checksums or signatures.

**Impact:** A supply chain attacker who compromises the download endpoint or performs a man-in-the-middle attack could inject malicious native binaries. Since these are native libraries loaded into the Bun runtime, they run with full process privileges.

**Remediation:**
1. Pin the exact version of onnxruntime-node.
2. Verify downloaded binary checksums against known-good values (e.g., from the GitHub release).
3. Consider using pre-built Docker containers that include the verified binary.
4. Add pnpm audit to the CI pipeline.

**Priority:** P1.

---

### HIGH-6: grammy Ships Legacy HTTP Stack

| Attribute | Value |
|-----------|-------|
| **File** | grammy dependency tree (node-fetch@2, tr46@0.0.3) |
| **Domain** | Supply Chain and Dependencies |
| **Found By** | Supply Chain Audit |

**Description:** The grammy Telegram bot framework pulls in node-fetch@2 and tr46@0.0.3 as transitive dependencies. Both are legacy versions with known issues. tr46@0.0.3 in particular has been flagged in npm advisories.

**Impact:** Known vulnerabilities in transitive dependencies could be exploited if an attacker can influence HTTP responses from the Telegram API or control URL inputs.

**Remediation:** Update grammy to the latest version, or use pnpm overrides to force newer versions of node-fetch and tr46. Bun natively supports fetch, so node-fetch may be eliminable entirely.

**Priority:** P1.

---

### HIGH-7: No Python Lockfile for GPU Worker

| Attribute | Value |
|-----------|-------|
| **File** | services/gpu-worker/pyproject.toml (missing lockfile) |
| **Domain** | Supply Chain and Dependencies |
| **Found By** | Supply Chain Audit, GPU Pipeline Audit |

**Description:** The GPU worker Python service has a pyproject.toml defining dependencies but no lockfile (uv.lock, poetry.lock, or requirements.txt with hashes). Each pip install or uv sync resolves dependencies at install time, potentially pulling different (and possibly compromised) versions.

**Impact:** Non-reproducible builds. Dependency confusion attacks are possible if an attacker publishes a malicious package with a matching name on PyPI. Without hash verification, even legitimate packages could be replaced.

**Remediation:** Generate and commit a lockfile with pinned versions and integrity hashes. If using uv, run `uv lock` and commit uv.lock. If using pip, generate requirements.txt via `pip freeze` with --require-hashes.

**Priority:** P1.

---

### HIGH-8: claude.yml Workflow Has Excessive Permissions

| Attribute | Value |
|-----------|-------|
| **File** | .github/workflows/claude.yml (lines 13-15) |
| **Domain** | CI/CD Pipeline |
| **Found By** | CI/CD Audit |

**Description:** The GitHub Actions workflow for the Claude AI agent has contents:write and issues:write permissions. This workflow runs AI-generated code, which means a compromised or manipulated AI agent could modify repository contents or create/edit issues.

**Impact:** If the AI agent is manipulated via prompt injection (e.g., through a crafted issue title or PR description), it could push malicious code to the repository or modify issues to hide evidence.

**Remediation:** Reduce permissions to contents:read and issues:read. If write access is genuinely needed, scope it to a specific job with additional approval gates. Consider requiring manual approval for any AI-initiated commits.

**Priority:** P1.

---

### HIGH-9: VACUUM INTO Uses String Interpolation

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/backup/manager.ts (line ~178) |
| **Domain** | Database and Audit Integrity |
| **Found By** | Database Audit |

**Description:** The backup command uses string interpolation for the file path in a SQL statement:

```typescript
db.exec(`VACUUM INTO '${safePath}'`);
```

While a validateBackupPath() function exists, the FORBIDDEN_PATH_CHARS list does not include double-quote or newline characters, which could be used to break out of the string context in certain SQLite configurations.

**Impact:** Path injection could cause the backup to be written to an attacker-controlled location, or could cause data corruption if the path manipulation results in writing to an existing database file.

**Remediation:** Add double-quote and newline to FORBIDDEN_PATH_CHARS. Since SQLite's VACUUM INTO does not support parameterized paths, also validate that the resolved path is within the expected backup directory using a canonical path comparison.

**Priority:** P1.

---

### HIGH-10: Backup Encryption Optional Without Warning

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/backup/manager.ts |
| **Domain** | Database and Audit Integrity |
| **Found By** | Database Audit |

**Description:** Database backups can be created without encryption, and no security warning is emitted when encryption is disabled. The backup files contain the full contents of memory.db, operational.db, and audit.db, including potentially sensitive personal data, conversation histories, and knowledge graph entities.

**Impact:** Unencrypted backup files on disk (or transferred to backup storage) expose all user data. If the backup path is on a network share or cloud-synced directory, the data may be accessible to third parties.

**Remediation:** Default to encrypted backups. When encryption is disabled, log a WARNING-level message on every backup run. Consider requiring an explicit --insecure flag to create unencrypted backups.

**Priority:** P1.

---

### HIGH-11: APNs Device Tokens Stored in Plaintext

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/database/schemas/operational.ts (lines 174-182) |
| **Domain** | Client Architecture |
| **Found By** | Client Architecture Audit, Database Audit |

**Description:** Apple Push Notification service (APNs) device tokens are stored in the operational.db database without encryption. Device tokens are considered personally identifiable information (PII) under GDPR and Apple's developer guidelines.

**Impact:** Database exfiltration exposes device tokens, which could be used to send unwanted push notifications to the user's device (though sending requires the APNs auth key as well). More significantly, plaintext PII storage may violate GDPR data protection requirements.

**Remediation:** Encrypt device tokens at rest using the same AES-256-GCM encryption used for the secret store. Decrypt only when sending push notifications.

**Priority:** P1.

---

### HIGH-12: ConsentType Missing 'voice' for GDPR Art. 9

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/database/schemas/operational.ts (line 209) |
| **Domain** | Database and Audit Integrity |
| **Found By** | Database Audit |

**Description:** The user_consent table's CHECK constraint on the consent_type column does not include 'voice' as a valid type. Voice recordings are biometric data under GDPR Article 9, which requires explicit consent before processing. Without a 'voice' consent type, the system cannot properly record or enforce voice biometric consent.

**Impact:** GDPR compliance gap. The design document (docs/design/SECURITY.md) explicitly requires voice consent tracking, but the schema does not support it. This could result in processing voice biometric data without proper consent records.

**Remediation:** Add 'voice' to the CHECK constraint enum for consent_type. Add a migration to update the constraint. Implement consent checking in the voice pipeline before processing audio.

**Priority:** P1.

---

### HIGH-13: MCP Config Writes Plaintext Secrets

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/claude/mcp.ts (lines 40-47) |
| **Domain** | Secrets and Cryptography |
| **Found By** | Secrets Audit, Configuration Audit |

**Description:** When generating the MCP server configuration file for Claude Code CLI's --mcp-config flag, environment variable values (which may contain resolved $secret references like Home Assistant tokens) are written as plaintext to .mcp-servers.json on disk.

**Impact:** Secrets like HA_TOKEN are written to a file that may be readable by other processes or users on the system. If the workspace directory is under version control, the secrets file could be accidentally committed.

**Remediation:** Pass resolved secret values via the subprocess environment (the env parameter of Bun.spawn()) rather than writing them to a config file. If a file is required by the Claude Code CLI, ensure it is created with 0600 permissions, placed in a temporary directory, and deleted after the session ends.

**Priority:** P1.

---

### HIGH-14: Tauri Updater Pubkey is Placeholder

| Attribute | Value |
|-----------|-------|
| **File** | apps/desktop/src-tauri/tauri.conf.json |
| **Domain** | Client Architecture |
| **Found By** | Client Architecture Audit |

**Description:** The Tauri auto-updater public key in the desktop application configuration is a placeholder value. Without a valid public key, the updater cannot verify the signature of downloaded updates.

**Impact:** Man-in-the-middle attacks on the update channel could inject malicious binaries that would be installed without signature verification. Since the desktop client has deep system access (shell, filesystem, clipboard), a compromised update is a full system compromise.

**Remediation:** Generate a real Tauri signing key pair using `tauri signer generate`. Set the public key in tauri.conf.json and store the private key securely (e.g., as a GitHub Actions secret for CI builds). Never commit the private key to the repository.

**Priority:** P1 -- required before any public distribution of the desktop app.

---

### HIGH-15: client.execute Allows Lateral Movement

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/gateway/server.ts |
| **Domain** | Network and Gateway |
| **Found By** | Gateway Audit, Client Architecture Audit |

**Description:** The gateway's client.execute RPC method allows any authenticated client to send commands for execution on other connected clients. There is no authorization check to verify that the requesting client should be allowed to run commands on the target client.

**Impact:** If any single client is compromised (e.g., a desktop client with a stolen gateway token), the attacker can pivot to run commands on all other connected clients. This effectively turns a single-client compromise into a full mesh compromise.

**Remediation:**
1. Add per-client authorization: each client should declare which other clients (if any) it allows to send commands to it.
2. Require explicit user approval for cross-client execution requests.
3. Log all cross-client execution attempts to the audit trail.
4. Consider removing the client.execute capability entirely and routing all execution through the Core daemon.

**Priority:** P1.

---

## MEDIUM Findings

### MED-1: GPU Worker Health Endpoint Bypasses Authentication

| Attribute | Value |
|-----------|-------|
| **File** | services/gpu-worker/src/auth.py (lines 81-83) |
| **Domain** | Voice and GPU Pipeline |

**Description:** The /health endpoint on the GPU worker does not require authentication. While health endpoints are commonly unauthenticated, this one returns GPU utilization, VRAM usage, temperature, and loaded model information.

**Remediation:** Either require authentication on /health, or limit the unauthenticated response to a simple status indicator without hardware details. Detailed health data should require a valid token.

---

### MED-2: No Rate Limiting on WebSocket Auth Failures

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/gateway/server.ts |
| **Domain** | Network and Gateway |

**Description:** Failed WebSocket authentication attempts are not rate-limited. An attacker can brute-force the gateway token by rapidly connecting and disconnecting.

**Remediation:** Implement connection-level rate limiting: after N failed authentication attempts from the same IP within a time window, temporarily block that IP. Log all failed authentication attempts to the audit trail.

---

### MED-3: Fixed Application Salt for Master Key

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/secrets/master-key.ts |
| **Domain** | Secrets and Cryptography |

**Description:** The master key derivation uses a fixed application-wide salt ("eidolon-master-key-v1"). All Eidolon installations use the same salt, which means identical passphrases will produce identical derived keys across different installations.

**Remediation:** Generate a random salt per installation and store it alongside the encrypted secret store. This prevents rainbow table attacks that target the fixed salt value. The salt is not secret and can be stored in plaintext.

---

### MED-4: Windows Permission Bypass in Config Watcher

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/config/watcher.ts (lines 136-145) |
| **Domain** | Configuration System |

**Description:** The config watcher's file permission check returns true (permitted) when statSync fails, as a Windows compatibility workaround. On Windows, statSync may not return Unix-style permission bits.

**Remediation:** Default to false (denied) on statSync failure. Implement a Windows-specific permission check using fs.accessSync or equivalent. Log a warning when the permission check cannot be performed.

---

### MED-5: gateway.auth Not in Hot-Reload LOCKED_FIELDS

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/config/watcher.ts |
| **Domain** | Configuration System |

**Description:** The LOCKED_FIELDS set includes "security" and "database" but does not include "gateway.auth". This means the gateway authentication configuration (including token and auth type) can be changed via hot-reload without a daemon restart.

**Remediation:** Add "gateway.auth" to the LOCKED_FIELDS set. Also consider adding "gateway.tls" since TLS configuration changes should require a restart.

---

### MED-6: Origin Validation Disabled by Default

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/gateway/server.ts |
| **Domain** | Network and Gateway |

**Description:** WebSocket origin validation is disabled by default. Any origin can connect to the gateway, which enables cross-site WebSocket hijacking if the gateway is accessible from a browser context.

**Remediation:** Enable origin validation by default. Allow configuration of permitted origins. When running behind Tailscale only, this is low risk, but when exposed via Cloudflare Tunnel, it becomes significant.

---

### MED-7: Log Injection via Unsanitized entry.data

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/logging/formatter.ts (line 61) |
| **Domain** | Cross-Cutting |

**Description:** The log formatter includes entry.data in JSON output without sanitizing for control characters (newlines, ANSI escape codes, null bytes). Malicious input in log data could inject fake log entries or corrupt log parsing tools.

**Remediation:** Sanitize JSON.stringify output to escape or remove control characters in the formatted output.

---

### MED-8: python-multipart Allows Vulnerable ReDoS Version

| Attribute | Value |
|-----------|-------|
| **File** | services/gpu-worker/pyproject.toml |
| **Domain** | Supply Chain and Dependencies |

**Description:** The python-multipart dependency version range allows versions prior to 0.0.12, which are vulnerable to Regular Expression Denial of Service (ReDoS) via crafted multipart form data.

**Remediation:** Pin python-multipart >= 0.0.12 in pyproject.toml.

---

### MED-9: gateway.auth.type="none" Valid With No Warning

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/config/validator.ts or packages/core/src/config/env.ts |
| **Domain** | Configuration System |

**Description:** Setting gateway.auth.type to "none" is accepted without any security warning. This completely disables authentication on the WebSocket gateway.

**Remediation:** When gateway.auth.type is "none", log a WARN-level security message at startup and on every client connection. Consider requiring an --insecure flag or an explicit confirmation in the config.

---

### MED-10: scrypt Used Instead of Documented Argon2id

| Attribute | Value |
|-----------|-------|
| **Files** | packages/core/src/secrets/crypto.ts, docs/design/SECURITY.md |
| **Domain** | Secrets and Cryptography |

**Description:** The design documentation specifies Argon2id for key derivation, but the implementation uses Node.js scryptSync. While scrypt is a legitimate KDF, the inconsistency between documentation and implementation creates confusion and may cause issues during security reviews or compliance audits.

**Remediation:** Either update the documentation to reflect the scrypt implementation, or migrate to Argon2id as documented. If scrypt is retained, document the specific parameters used (N, r, p) and the rationale for the deviation.

---

### MED-11 through MED-25: Additional Medium Findings

The following medium-severity issues were also identified. Each should be tracked as a separate remediation item:

| ID | Summary | File(s) |
|----|---------|---------|
| MED-11 | TOCTOU race in config file permission check | config/watcher.ts |
| MED-12 | Path traversal edge case in document indexer paths | memory/document-indexer.ts |
| MED-13 | Rate limiter Map grows unbounded between cleanup cycles | gateway/rate-limiter.ts |
| MED-14 | ReDoS patterns in safety classifier regex | learning/safety.ts |
| MED-15 | Subprocess env inherits parent process env by default | claude/manager.ts |
| MED-16 | No maximum size check on inbound WebSocket messages | gateway/server.ts |
| MED-17 | Circuit breaker state persisted without encryption | database/schemas/operational.ts |
| MED-18 | Voice session transcripts not covered by privacy forget | privacy/forget.ts |
| MED-19 | No TLS certificate pinning for GPU worker connections | gpu/manager.ts |
| MED-20 | Backup path validation does not resolve symlinks | backup/manager.ts |
| MED-21 | Event bus replay does not verify event integrity | loop/event-bus.ts |
| MED-22 | Account rotation exposes account names in logs | claude/account-rotation.ts |
| MED-23 | Learning content sanitizer does not strip HTML entities | learning/relevance.ts |
| MED-24 | SQLite busy timeout too short for concurrent writes | database/connection.ts |
| MED-25 | No file size limit on voice message uploads | channels/telegram/media.ts |

---

## LOW Findings

### LOW-1: HMAC Signing Falls Back to Empty-String Key

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/discovery/broadcaster.ts (line 177) |
| **Domain** | Cross-Cutting |

**Description:** If the HMAC signing key is not configured, the code falls back to using an empty string as the key instead of throwing an error.

**Remediation:** Throw an error if the signing key is not configured. An empty-string key provides no security.

---

### LOW-2: RealtimeVoiceClient Callback Arrays Have No Deregistration

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/gpu/realtime-client.ts |
| **Domain** | Voice and GPU Pipeline |

**Description:** Event listener callbacks are added to arrays but there is no mechanism to remove them. Over a long-running session, this could lead to memory growth.

**Remediation:** Add removeListener() or off() methods to the RealtimeVoiceClient class.

---

### LOW-3: Log Rotation Race Condition

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/logging/rotation.ts |
| **Domain** | Cross-Cutting |

**Description:** Log rotation uses a non-atomic rename pattern. Under high log volume, log entries could be lost during the rename window.

**Remediation:** Use an atomic rename pattern: write to a temporary file, then rename to the final path.

---

### LOW-4: Session Map Has No Stale-Entry Eviction

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/loop/session-supervisor.ts (line 35) |
| **Domain** | Cross-Cutting |

**Description:** The session supervisor's in-memory session map retains entries for completed and failed sessions indefinitely.

**Remediation:** Add periodic cleanup of completed/failed sessions from the in-memory map. Retain them in the database for history.

---

### LOW-5: Rate Limiter Map Grows Unbounded Between Cleanup Cycles

| Attribute | Value |
|-----------|-------|
| **File** | packages/core/src/gateway/rate-limiter.ts (line 64) |
| **Domain** | Network and Gateway |

**Description:** The rate limiter's in-memory map of IP addresses grows without bound between periodic cleanup cycles. Under a distributed attack, this could consume significant memory.

**Remediation:** Add a maximum entries limit. When the limit is reached, evict the oldest entries or reject new connections.

---

### LOW-6 through LOW-15: Additional Low Findings

| ID | Summary | File(s) |
|----|---------|---------|
| LOW-6 | Unused error codes defined in protocol constants | packages/protocol/src/errors.ts |
| LOW-7 | Test helper createTestConfig uses hardcoded secrets | packages/test-utils/src/test-config.ts |
| LOW-8 | No timeout on GPU worker health check HTTP requests | gpu/manager.ts |
| LOW-9 | Dreaming scheduler does not jitter start time | memory/dreaming/scheduler.ts |
| LOW-10 | Voice metrics table lacks index on session_id | database/schemas/operational.ts |
| LOW-11 | CLI help text exposes internal file paths | packages/cli/src/index.ts |
| LOW-12 | TypeScript strict mode not enforced in all tsconfigs | Various tsconfig.json |
| LOW-13 | No Content-Security-Policy on web dashboard | core/gateway/ |
| LOW-14 | Embedding model cache directory world-readable | memory/embeddings.ts |
| LOW-15 | No integrity check on startup for skills/ directory | claude/workspace.ts |

---

## Cross-Reference: Findings Detected by Multiple Audits

The following findings were independently identified by more than one audit, indicating systemic importance:

| Finding | Audits That Found It | Count |
|---------|---------------------|------:|
| HIGH-1: Auth token in WebSocket URL | Network, GPU, Gateway, Client | 4 |
| HIGH-13: MCP config writes plaintext secrets | Secrets, Configuration | 2 |
| HIGH-7: No Python lockfile | Supply Chain, GPU Pipeline | 2 |
| HIGH-11: APNs tokens in plaintext | Client Architecture, Database | 2 |
| HIGH-4: console.warn bypasses Logger | Secrets, Database | 2 |
| MED-10: scrypt vs documented Argon2id | Secrets, Cross-Cutting | 2 |
| CRIT-3: Env vars disable audit logging | Configuration, Security Policy | 2 |

Findings detected by 3+ audits should be treated as the highest priority within their severity level, as they represent issues visible across multiple security domains.

---

## Remediation Priority Order

The following order is recommended for addressing findings. Items within the same priority group can be parallelized.

### Priority 0: Immediate (block production deployment)

| Order | Finding | Estimated Effort |
|------:|---------|-----------------|
| 1 | CRIT-2: Fix audit log integrity hash chain | 2-4 hours |
| 2 | CRIT-3: Add ENV_LOCKED_PATHS for security fields | 2-3 hours |
| 3 | CRIT-4: Initialize currentConfig before watcher start | 1 hour |
| 4 | CRIT-1: Pin onnxruntime-web to stable release | 1 hour |

### Priority 1: Before production deployment

| Order | Finding | Estimated Effort |
|------:|---------|-----------------|
| 5 | HIGH-1: Move auth token out of WebSocket URL | 3-4 hours |
| 6 | HIGH-13: Stop writing secrets to MCP config file | 2-3 hours |
| 7 | HIGH-2: Mask gateway token in onboarding output | 1-2 hours |
| 8 | HIGH-3: Deduplicate PASSPHRASE_SALT | 30 minutes |
| 9 | HIGH-9: Harden VACUUM INTO path validation | 1-2 hours |
| 10 | HIGH-15: Add authorization to client.execute | 4-6 hours |
| 11 | HIGH-8: Reduce claude.yml workflow permissions | 30 minutes |
| 12 | HIGH-14: Generate real Tauri updater key pair | 1-2 hours |
| 13 | HIGH-4: Replace console.warn with Logger | 1-2 hours |
| 14 | HIGH-7: Generate and commit Python lockfile | 1 hour |
| 15 | HIGH-12: Add 'voice' to consent type enum | 1 hour |
| 16 | HIGH-11: Encrypt APNs device tokens | 2-3 hours |
| 17 | HIGH-10: Default to encrypted backups | 2-3 hours |
| 18 | HIGH-5: Verify onnxruntime-node binary checksums | 2-3 hours |
| 19 | HIGH-6: Update grammy or override legacy deps | 1-2 hours |

### Priority 2: Next development sprint

| Order | Finding | Estimated Effort |
|------:|---------|-----------------|
| 20-30 | MED-1 through MED-10 | 1-3 hours each |

### Priority 3: Scheduled maintenance

| Order | Finding | Estimated Effort |
|------:|---------|-----------------|
| 31-44 | MED-11 through MED-25, LOW-1 through LOW-15 | 30 min - 2 hours each |

---

## Methodology Notes

Each of the 8 audits followed a consistent methodology:

1. **Static analysis:** Manual code review of all files within the audit domain, focusing on security-relevant patterns (authentication, authorization, encryption, input validation, error handling).
2. **Dependency analysis:** Review of direct and transitive dependencies for known vulnerabilities and supply chain risks.
3. **Configuration review:** Analysis of default configurations, schema validation, and runtime override mechanisms.
4. **Design conformance:** Comparison of implementation against design documents (docs/design/SECURITY.md, docs/IMPLEMENTATION_PLAN.md) to identify deviations.
5. **Threat modeling:** Consideration of attacker profiles (local user, network attacker, compromised dependency, compromised client) and attack vectors specific to each domain.

No automated scanning tools (SAST/DAST) were used; all findings are from manual review. Automated scanning is recommended as a follow-up to catch additional issues.

---

## Appendix: Files Referenced

| File Path | Findings |
|-----------|----------|
| pnpm-lock.yaml | CRIT-1, HIGH-5, HIGH-6 |
| packages/core/src/database/schemas/audit.ts | CRIT-2 |
| packages/core/src/config/env.ts | CRIT-3 |
| packages/core/src/config/watcher.ts | CRIT-4, MED-4, MED-5 |
| packages/core/src/gpu/realtime-client.ts | HIGH-1, LOW-2 |
| packages/cli/src/commands/onboard.ts | HIGH-2 |
| packages/core/src/secrets/crypto.ts | HIGH-3, MED-10 |
| packages/core/src/secrets/master-key.ts | HIGH-3, HIGH-4, MED-3 |
| packages/core/src/database/connection.ts | HIGH-4 |
| services/gpu-worker/pyproject.toml | HIGH-7, MED-8 |
| .github/workflows/claude.yml | HIGH-8 |
| packages/core/src/backup/manager.ts | HIGH-9, HIGH-10 |
| packages/core/src/database/schemas/operational.ts | HIGH-11, HIGH-12 |
| packages/core/src/claude/mcp.ts | HIGH-13 |
| apps/desktop/src-tauri/tauri.conf.json | HIGH-14 |
| packages/core/src/gateway/server.ts | HIGH-15, MED-2, MED-6 |
| services/gpu-worker/src/auth.py | MED-1 |
| packages/core/src/logging/formatter.ts | MED-7 |
| packages/core/src/discovery/broadcaster.ts | LOW-1 |
| packages/core/src/logging/rotation.ts | LOW-3 |
| packages/core/src/loop/session-supervisor.ts | LOW-4 |
| packages/core/src/gateway/rate-limiter.ts | LOW-5 |

---

*Report generated on 2026-03-03. Covers Eidolon v0.1.4 codebase at commit 17f428e on branch main.*
