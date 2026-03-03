# Troubleshooting

> Common issues and their solutions. Each entry follows the format: Problem, Cause, Solution.

---

## Daemon Won't Start

**Problem:** `eidolon daemon start` fails immediately or the daemon exits after a few seconds.

**Cause:** Typically one of: invalid configuration, missing master key, or database permission errors. The daemon validates configuration at startup and fails fast on errors.

**Solution:**

1. Check the daemon log for the specific error:
   ```bash
   eidolon daemon start --foreground
   # Error messages will appear in stdout
   ```

2. Validate configuration:
   ```bash
   eidolon config validate
   ```

3. Verify the master key is available:
   ```bash
   echo $EIDOLON_MASTER_KEY
   # Should print a non-empty value
   ```

4. Check database directory permissions:
   ```bash
   ls -la ~/.eidolon/
   # All .db files should be readable and writable by the current user
   ```

5. Run the diagnostic tool:
   ```bash
   eidolon doctor
   # Reports status of all subsystems
   ```

6. If databases are corrupted, remove them and let the daemon recreate them:
   ```bash
   # Back up first
   cp ~/.eidolon/*.db ~/.eidolon/backup/
   rm ~/.eidolon/memory.db ~/.eidolon/operational.db ~/.eidolon/audit.db
   eidolon daemon start --foreground
   ```

---

## Claude Code CLI Not Found

**Problem:** `eidolon doctor` reports "Claude Code CLI: FAIL" or the daemon logs "CLAUDE_NOT_INSTALLED".

**Cause:** The `claude` binary is not in the system PATH, or it is not installed. Eidolon requires the Claude Code CLI as its execution engine.

**Solution:**

1. Verify Claude Code CLI is installed:
   ```bash
   which claude
   claude --version
   ```

2. If not installed, install it:
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

3. If installed but not in PATH, add it. The binary is typically at `~/.npm/bin/claude` or the global npm prefix:
   ```bash
   npm config get prefix
   # Add <prefix>/bin to your PATH in ~/.bashrc or ~/.zshrc
   export PATH="$(npm config get prefix)/bin:$PATH"
   ```

4. If using Bun's global install:
   ```bash
   bun install -g @anthropic-ai/claude-code
   ```

5. Verify authentication:
   ```bash
   claude auth login
   ```

---

## Telegram Bot Not Responding

**Problem:** Messages sent to the Telegram bot receive no response. The bot appears offline.

**Cause:** The bot token may be invalid, the user ID is not in the allowlist, the Telegram channel is not enabled in config, or the daemon is not running.

**Solution:**

1. Verify the daemon is running:
   ```bash
   eidolon daemon status
   ```

2. Check that Telegram is enabled in config:
   ```bash
   eidolon config show channels
   # channels.telegram.enabled should be true
   ```

3. Verify the bot token is stored and valid:
   ```bash
   eidolon secrets list
   # Should show TELEGRAM_BOT_TOKEN
   ```

4. Confirm your Telegram user ID is in the allowlist. Get your ID by messaging [@userinfobot](https://t.me/userinfobot) on Telegram, then check:
   ```bash
   eidolon config show channels
   # channels.telegram.allowedUserIds should include your ID
   ```

5. Check daemon logs for Telegram-specific errors:
   ```bash
   eidolon daemon start --foreground
   # Look for "channel:error" or "CHANNEL_AUTH_FAILED" messages
   ```

6. Test the bot token directly:
   ```bash
   curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe
   # Should return bot information
   ```

---

## GPU Worker Offline

**Problem:** Voice commands return text-only responses. `eidolon doctor` or logs show the GPU worker as offline.

**Cause:** The GPU worker Docker container is not running, Tailscale connectivity is broken, or the authentication token is wrong.

**Solution:**

1. Check if the GPU worker is running on the GPU machine:
   ```bash
   # On the GPU machine (e.g., Windows PC)
   docker ps | grep gpu-worker
   ```

2. If not running, start it:
   ```bash
   cd services/gpu-worker
   docker compose up -d
   ```

3. Verify Tailscale connectivity between the server and GPU machine:
   ```bash
   # On the server
   ping <gpu-machine-tailscale-ip>
   ```

4. Test the GPU worker health endpoint directly:
   ```bash
   curl -H "Authorization: Bearer $(eidolon secrets get GPU_WORKER_TOKEN)" \
     http://<gpu-host>:8420/health
   ```

5. If authentication fails, ensure the token matches on both sides:
   ```bash
   # On the server
   eidolon secrets get GPU_WORKER_TOKEN
   # Compare with the token configured in the GPU worker's environment
   ```

6. Check GPU worker logs for errors:
   ```bash
   docker logs gpu-worker
   ```

7. Note: When the GPU worker is offline, Eidolon automatically falls back through the TTS chain (Kitten TTS on CPU, then system TTS, then text-only). Voice will degrade but not fail completely.

---

## Memory Search Returns No Results

**Problem:** `eidolon memory search "query"` returns empty results even though conversations have occurred.

**Cause:** The embedding model may not be loaded, memory extraction may have failed, or the database may be empty.

**Solution:**

1. Check if memories exist:
   ```bash
   eidolon memory stats
   # Shows count of memories by type and layer
   ```

2. If no memories exist, the extractor may have failed. Check logs for extraction errors:
   ```bash
   # Look for MEMORY_EXTRACTION_FAILED or EMBEDDING_FAILED in logs
   ```

3. Verify the embedding model is accessible. The default model (`Xenova/multilingual-e5-small`) is downloaded on first use and cached:
   ```bash
   ls ~/.cache/huggingface/hub/models--Xenova--multilingual-e5-small/ 2>/dev/null
   # If empty, the model needs to be downloaded (requires internet)
   ```

4. Test search with a broad query:
   ```bash
   eidolon memory search "*"
   ```

5. If the database exists but search is broken, try rebuilding the FTS index. This is done automatically on migration but can be forced:
   ```bash
   # Advanced: connect to the database directly
   sqlite3 ~/.eidolon/memory.db "INSERT INTO memories_fts(memories_fts) VALUES('rebuild');"
   ```

---

## Rate Limit Errors

**Problem:** Responses are slow or fail with "CLAUDE_RATE_LIMITED". The daemon logs show all accounts exhausted.

**Cause:** All configured Claude accounts have hit their hourly token limits or are in cooldown from repeated rate limit responses.

**Solution:**

1. Check account status:
   ```bash
   eidolon daemon status
   # Shows per-account token usage and cooldown status
   ```

2. If using OAuth accounts (Anthropic Max), rate limits reset hourly. Wait for the cooldown to expire.

3. Add a fallback API key account to increase total capacity:
   ```bash
   eidolon secrets set ANTHROPIC_API_KEY
   # Then add to config:
   # brain.accounts: [{ type: "api-key", name: "fallback", credential: { "$secret": "ANTHROPIC_API_KEY" }, priority: 50 }]
   ```

4. Reduce token consumption by adjusting the energy budget:
   ```bash
   # Edit eidolon.json:
   # loop.energyBudget.maxTokensPerHour: 50000  (reduce this)
   # learning.enabled: false  (disable learning temporarily)
   ```

5. Check if a runaway session is consuming excessive tokens:
   ```bash
   eidolon daemon status
   # Look for sessions with unusually high token counts
   ```

---

## Secret Decryption Failed

**Problem:** The daemon fails to start with "SECRET_DECRYPTION_FAILED" or `eidolon secrets get` returns an error.

**Cause:** The master key does not match the key used to encrypt the secrets, or the `secrets.db` file is corrupted.

**Solution:**

1. Verify the correct master key is set:
   ```bash
   echo $EIDOLON_MASTER_KEY
   # Must match the key used during initial setup
   ```

2. If you have lost the master key, the encrypted secrets cannot be recovered. You must re-create them:
   ```bash
   # Remove the old secrets database
   rm ~/.eidolon/secrets.db

   # Set a new master key
   export EIDOLON_MASTER_KEY=$(openssl rand -base64 32)
   # Save this key securely

   # Re-add all secrets
   eidolon secrets set TELEGRAM_BOT_TOKEN
   eidolon secrets set GATEWAY_TOKEN
   # ... repeat for all required secrets
   ```

3. If the secrets file is corrupted (e.g., partial write during power loss), restore from backup:
   ```bash
   cp ~/.eidolon/backups/<latest>/secrets.db ~/.eidolon/secrets.db
   ```

4. Add the master key to your shell profile so it persists across sessions:
   ```bash
   echo 'export EIDOLON_MASTER_KEY="<your-key>"' >> ~/.bashrc
   source ~/.bashrc
   ```

---

## Database Locked

**Problem:** The daemon logs show "SQLITE_BUSY" errors, or operations hang and eventually time out with "DB_QUERY_FAILED".

**Cause:** Another process is holding a write lock on one of the SQLite databases, or WAL mode is not enabled. This can happen if two daemon instances are running, or if a backup tool is locking the file.

**Solution:**

1. Check for duplicate daemon processes:
   ```bash
   ps aux | grep eidolon
   # Should show at most one daemon process
   ```

2. If multiple instances are running, stop all and restart one:
   ```bash
   eidolon daemon stop
   # If that fails:
   kill $(cat ~/.eidolon/eidolon.pid)
   # Remove stale PID file
   rm ~/.eidolon/eidolon.pid
   eidolon daemon start
   ```

3. Verify WAL mode is enabled (it should be set automatically):
   ```bash
   sqlite3 ~/.eidolon/memory.db "PRAGMA journal_mode;"
   # Should print "wal"
   ```

4. If WAL mode is not enabled, set it manually:
   ```bash
   sqlite3 ~/.eidolon/memory.db "PRAGMA journal_mode=wal;"
   sqlite3 ~/.eidolon/operational.db "PRAGMA journal_mode=wal;"
   sqlite3 ~/.eidolon/audit.db "PRAGMA journal_mode=wal;"
   ```

5. Check if a backup tool or file sync service (Dropbox, OneDrive) is locking the database files. SQLite databases should not be stored in synced directories.

6. If the database is in an unrecoverable locked state, run a checkpoint and restart:
   ```bash
   sqlite3 ~/.eidolon/operational.db "PRAGMA wal_checkpoint(TRUNCATE);"
   ```

---

## Tests Failing

**Problem:** `pnpm -r test` or `bun test` in a package directory reports failures.

**Cause:** Common causes include wrong Bun version, missing dependencies, stale build artifacts, or environment-specific issues.

**Solution:**

1. Verify Bun version:
   ```bash
   bun --version
   # Should be 1.1 or later
   ```

2. Reinstall dependencies:
   ```bash
   rm -rf node_modules packages/*/node_modules
   pnpm install
   ```

3. Rebuild all packages:
   ```bash
   pnpm -r build
   ```

4. Run type checking to catch type errors that may cause test failures:
   ```bash
   pnpm -r typecheck
   ```

5. Run tests in a specific package to isolate the failure:
   ```bash
   cd packages/core && bun test
   cd packages/protocol && bun test
   cd packages/cli && bun test
   cd packages/test-utils && bun test
   ```

6. Run a specific test file for detailed output:
   ```bash
   bun test packages/core/src/config/__tests__/loader.test.ts
   ```

7. Check for environment variables that may affect tests:
   ```bash
   # Tests should not depend on external env vars, but verify:
   env | grep EIDOLON
   ```

8. If tests pass locally but fail in CI, check the CI logs for Bun version mismatches or missing system dependencies.

---

*See also: [Quick Start](setup/QUICKSTART.md), [Server Setup](setup/SERVER.md), [Configuration Reference](reference/CONFIGURATION.md).*
