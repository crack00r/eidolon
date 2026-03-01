---
paths:
  - "docs/**/*.md"
  - "*.md"
---

# Documentation Rules (Eidolon)

## Language

- All documentation in English. Code comments in English.
- User-facing CLI help text in English (German localization later).

## Structure

- Use ATX-style headers (`#`, `##`, `###`). Max depth: 4 levels.
- Keep lines under 120 characters where possible.
- Use fenced code blocks with language identifiers (```typescript, ```bash, ```python).
- Tables for structured comparisons. Bullet lists for enumeration.

## Content Standards

- No private data, API keys, or internal URLs in documentation (public repo).
- Architecture decisions include rationale (why, not just what).
- Design docs reference the specific expert review that motivated changes.
- Keep CHANGELOG.md updated with every user-facing change.

## Commit Messages for Docs

- Use `docs(scope): description` format.
- Scopes: architecture, memory, security, gpu, testing, roadmap, readme.
