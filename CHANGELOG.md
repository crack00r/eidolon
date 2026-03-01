# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** This changelog is automatically managed by
> [release-please](https://github.com/googleapis/release-please).
> Do not edit manually.

## 1.0.0 (2026-03-01)


### Features

* add agent-first development workflow with 5 specialized subagents ([e209ac6](https://github.com/crack00r/eidolon/commit/e209ac672ed08f835e51a847cecc839279f87026))


### Bug Fixes

* **ci:** make all workflows pass on initial empty monorepo ([3077392](https://github.com/crack00r/eidolon/commit/307739267739e7b55f2b1d17088ba4593b9ffa7b))
* **ci:** resolve pnpm version conflict and enable PR creation ([a0938dc](https://github.com/crack00r/eidolon/commit/a0938dc77664a6178b1803c620d5114867d60d13))


### Documentation

* add Knowledge Graph (TransE), real-time voice protocol, and research-driven enhancements ([a06f5a7](https://github.com/crack00r/eidolon/commit/a06f5a7d9e7e84b68aec151288669faff97db606))
* complete project documentation and architecture plan ([d4562aa](https://github.com/crack00r/eidolon/commit/d4562aad6fae796f87dd880306781c1c59e70bae))
* integrate 20 expert review findings into architecture and design ([bb2563c](https://github.com/crack00r/eidolon/commit/bb2563c611a68dd0c8e73c8261a7a1921eb5594f))


### Miscellaneous

* add .keys/ to gitignore for signing key safety ([091d574](https://github.com/crack00r/eidolon/commit/091d574a178cfea211bc3833def25c9f83f61f7a))
* add Claude Code development infrastructure ([e6cbedf](https://github.com/crack00r/eidolon/commit/e6cbedf41e096b1b33e23cd575be10ee7bcea959))


### CI/CD

* add release automation, platform builds, and versioning infrastructure ([65208d6](https://github.com/crack00r/eidolon/commit/65208d62942b3664b5a9ee92f1fbb081107f0d47))

## [Unreleased]

### Added
- Complete project documentation and architecture design
- Vision, roadmap, and comparison documents
- 12 design documents (architecture, cognitive loop, memory engine, security, GPU/voice, clients, channels, testing, self-learning, Claude integration, accessibility, home automation)
- Configuration reference
- Development roadmap (Phase 0-9, ~22 weeks)
- 20 expert reviews synthesized into architecture improvements
- Claude Code development infrastructure (agents, skills, rules, settings, agent-memory)
- Agent-first development workflow with 5 specialized subagents (coder, debugger, tester, planner, reviewer)
- GitHub Actions CI pipeline (lint, typecheck, test, build)
- GitHub Actions Claude Code integration (@claude mentions, PR auto-review)
- GitHub Actions release automation (release-please, desktop builds, iOS builds)
- Community files (CODE_OF_CONDUCT.md, SECURITY.md, CONTRIBUTING.md, issue templates, PR template)
- release-please configuration for monorepo versioning
