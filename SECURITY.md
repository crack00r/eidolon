# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Eidolon, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **manuel@guttmann.dev**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment:** Within 48 hours
- **Initial assessment:** Within 1 week
- **Fix or mitigation:** Within 2 weeks for critical issues

## Scope

This policy covers:
- The Eidolon Core daemon (`packages/core`)
- The CLI (`packages/cli`)
- The GPU worker (`services/gpu-worker`)
- The desktop client (`apps/desktop`)
- The iOS client (`apps/ios`)

## Out of Scope

- Vulnerabilities in upstream dependencies (report to the respective project)
- Vulnerabilities in Claude Code CLI (report to Anthropic)
- Social engineering attacks
- Denial of service attacks against the user's own infrastructure

## Security Design

For Eidolon's security architecture, see [docs/design/SECURITY.md](docs/design/SECURITY.md).

## Supported Versions

| Version | Supported |
|---|---|
| 0.x (development) | Best effort |
| 1.x (stable) | Full support |
