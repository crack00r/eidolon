---
paths:
  - "packages/core/src/security/**/*.ts"
  - "packages/core/src/config.ts"
  - "**/*secret*"
  - "**/*crypt*"
  - "**/*auth*"
---

# Security Rules (Eidolon)

## Secrets Management

- All secrets encrypted at rest with AES-256-GCM. Key derived via scrypt (N=2^17, r=8, p=1).
- Never log secrets, API keys, or tokens -- even partially. Mask in debug output.
- Never commit `.env`, `secrets.enc`, `*.pem`, or `*.key` files.
- API keys isolated per subprocess via environment injection, never shared across sessions.

## Claude Code Integration Security

- **Never** use `--dangerously-skip-permissions`. Always use `--allowedTools` whitelisting.
- Each session type (main loop, research, code gen) gets a minimal tool whitelist.
- Validate all IPC messages from Claude Code subprocess with Zod schemas before processing.
- Set `--max-budget-usd` on every session to prevent runaway costs.

## Self-Learning Sandbox

- All self-discovered code changes execute in a sandboxed environment.
- Changes require explicit user approval before applying to production.
- Content sanitized before LLM evaluation -- strip PII, credentials, file paths.
- Evaluation sessions use restricted tool sets (read-only where possible).

## Database Security

- Use parameterized queries exclusively. Never concatenate user input into SQL.
- Audit log (audit.db) is append-only. Never delete or modify audit entries.
- GDPR: support `eidolon privacy forget` (data deletion) and `eidolon privacy export`.

## GPU Worker Authentication

- All GPU worker endpoints require pre-shared key authentication.
- Validate GPU worker responses with Zod schemas.
- TLS for all network communication, even over Tailscale.

## Input Validation

- Validate all external input at system boundaries with Zod schemas.
- Sanitize file paths to prevent directory traversal.
- Rate-limit API endpoints and WebSocket connections.
