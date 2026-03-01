# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** This changelog is automatically managed by
> [release-please](https://github.com/googleapis/release-please).
> Do not edit manually.

## [0.1.1](https://github.com/crack00r/eidolon/compare/v0.1.0...v0.1.1) (2026-03-01)


### Bug Fixes

* **ci:** move continue-on-error to reusable workflow job level ([2fca930](https://github.com/crack00r/eidolon/commit/2fca93068387e2a8ec61fe5666f0d4a47327a140))
* **desktop:** add placeholder icons and fix Linux build dependencies ([59884de](https://github.com/crack00r/eidolon/commit/59884de14abc2f401b889a9524c86ba3d845e67e))


### Security

* **all:** fix ~113 LOW-severity findings from second security audit ([39773fe](https://github.com/crack00r/eidolon/commit/39773fe184bc51d8ac73b3ba2c43e1e206f5f19b))
* **all:** fix ~65 CRITICAL+HIGH+MEDIUM findings from second security audit ([6caab98](https://github.com/crack00r/eidolon/commit/6caab983df24fa9a059e237260dbadd75186b264))
* **all:** fix 162 findings from third comprehensive security audit ([ce66c8c](https://github.com/crack00r/eidolon/commit/ce66c8cb8178cb679ef21aba5de17d69681466c7))


### Tests

* **core:** fix time-dependent RestCalculator tests with setSystemTime ([4fa098e](https://github.com/crack00r/eidolon/commit/4fa098ed7d00dd493bffdf4d19ec25c3d7eecbd6))

## 0.1.0 (2026-03-01)


### Features

* add agent-first development workflow with 5 specialized subagents ([e209ac6](https://github.com/crack00r/eidolon/commit/e209ac672ed08f835e51a847cecc839279f87026))
* **cli:** implement CLI skeleton with doctor, config, secrets, and daemon status ([3ecf7a3](https://github.com/crack00r/eidolon/commit/3ecf7a30575498fdb9c7f07a4187a756bc7dbebe))
* **cli:** implement memory management commands ([6532689](https://github.com/crack00r/eidolon/commit/6532689bb4df2fb28a9ecda692f478c2c25b2add))
* **core,cli:** implement CLI chat command and health check HTTP endpoint ([9952516](https://github.com/crack00r/eidolon/commit/9952516978a6ee0aca4d57411aa6901f1035903f))
* **core,cli:** implement daemon orchestrator, onboard wizard, and GDPR privacy commands ([3c6d9d9](https://github.com/crack00r/eidolon/commit/3c6d9d99e4cc305c6f69919f1c2fb3cf9390f43f))
* **core,desktop:** implement Gateway server and Tauri 2.0 desktop client ([eedfd4f](https://github.com/crack00r/eidolon/commit/eedfd4ff07344521bc95ea82af9c7bdbbf2caa6f))
* **core:** add workspace preparer, session manager, and MCP config passthrough ([80c135d](https://github.com/crack00r/eidolon/commit/80c135dbb063bf476efb760820f094770e52277a))
* **core:** implement 3-database split with migration system ([42c569f](https://github.com/crack00r/eidolon/commit/42c569f361662ce7cf1fd0196aa48d550af7bac2))
* **core:** implement AES-256-GCM encrypted secret store with scrypt key derivation ([4bcf0fd](https://github.com/crack00r/eidolon/commit/4bcf0fd01b3932032f82e9ff78822b0f3482b93b))
* **core:** implement automated SQLite backup with timestamped snapshots ([89dbe37](https://github.com/crack00r/eidolon/commit/89dbe3714dba09d7e5cca151d90b44f914117470))
* **core:** implement circuit breaker and health checker ([45c6d32](https://github.com/crack00r/eidolon/commit/45c6d32227586828b6a603a8fac8e32c64251750))
* **core:** implement ClaudeCodeManager, stream parser, and account rotation ([dcba45e](https://github.com/crack00r/eidolon/commit/dcba45e8b81aee4d1e96933ec686fbacdfdd95be))
* **core:** implement Cognitive Loop foundation — EventBus, StateMachine, Priority, Energy, Rest, SessionSupervisor, TaskScheduler ([1528c53](https://github.com/crack00r/eidolon/commit/1528c5335dfe4236d42051e74b84a3ed8b79c719))
* **core:** implement CognitiveLoop — autonomous PEAR cycle orchestrator ([a7fcc2e](https://github.com/crack00r/eidolon/commit/a7fcc2ec67268b177af1be3a8068d0f673b985c4))
* **core:** implement config system with loading, validation, env overrides, and hot-reload ([85b90ca](https://github.com/crack00r/eidolon/commit/85b90caaecdd6d8b20e9635518faf2b46476ca57))
* **core:** implement dreaming system with housekeeping, REM, and NREM phases ([f9dd40e](https://github.com/crack00r/eidolon/commit/f9dd40e3a66378aca93bb8dc07d598b6edba52ed))
* **core:** implement EmbeddingModel with multilingual-e5-small via @huggingface/transformers ([070fb36](https://github.com/crack00r/eidolon/commit/070fb36f13b6549b5befceb9921bd4926cac799d))
* **core:** implement GPU worker and voice pipeline with TTS/STT clients ([54d2aa4](https://github.com/crack00r/eidolon/commit/54d2aa4d25f9ed1c5739fc61cfebd4087d9f9409))
* **core:** implement GraphMemory with edge CRUD and graph-walk expansion ([2ed35f9](https://github.com/crack00r/eidolon/commit/2ed35f9645ad5ea840a0040cd926d5d7e0c7788b))
* **core:** implement Knowledge Graph with entity/relation CRUD and ComplEx embeddings ([7a86260](https://github.com/crack00r/eidolon/commit/7a862604c0402e66539aa02b34ad0b93ecf36034))
* **core:** implement MemoryExtractor with hybrid rule-based and LLM extraction ([f63d7cb](https://github.com/crack00r/eidolon/commit/f63d7cb4769f438b4bb222e6e6f7073071fea03d))
* **core:** implement MemoryInjector and DocumentIndexer ([1e8fa4d](https://github.com/crack00r/eidolon/commit/1e8fa4dd68faa05b8a79fa7a29e8e6c2eaefd478))
* **core:** implement MemorySearch with BM25, vector similarity, and RRF fusion ([8c606b2](https://github.com/crack00r/eidolon/commit/8c606b2e090af7d0e2f65b4e73f4f699909b7760))
* **core:** implement MemoryStore with CRUD, FTS5 search, and batch operations ([c5da4a5](https://github.com/crack00r/eidolon/commit/c5da4a5cdb2f3908b250228bb0f12e0b088f876c))
* **core:** implement self-learning pipeline with discovery, safety, and implementation ([23592be](https://github.com/crack00r/eidolon/commit/23592beaaa8a931f6f14202931483576c52513c6))
* **core:** implement structured logging with JSON/pretty format and file rotation ([ba0ee80](https://github.com/crack00r/eidolon/commit/ba0ee80d13f0cd1fb5881466adf08df0463c5d1f))
* **core:** implement Telegram channel with grammy, MessageRouter, and formatter ([209032c](https://github.com/crack00r/eidolon/commit/209032c05e9dcc8b5dc740017b24a19f65c01e3f))
* **core:** implement token usage tracking and cost calculation ([dd48e0b](https://github.com/crack00r/eidolon/commit/dd48e0bc508484ffe7323103826062194531578d))
* **core:** scaffold monorepo with 4 workspace packages and build tooling ([1f734d0](https://github.com/crack00r/eidolon/commit/1f734d0db00a0d0db5a444f0db540bfb3b0e8dcd))
* **ios:** implement SwiftUI iOS client with WebSocket gateway connection ([d94d06c](https://github.com/crack00r/eidolon/commit/d94d06c6905b8869ad02de5295849eead0001005))
* **protocol:** implement all shared types, interfaces, and Zod schemas ([f013e87](https://github.com/crack00r/eidolon/commit/f013e875bbff8d9380224d1c4f6eac1d1c687894))
* **test-utils:** implement FakeClaudeProcess, test config, event and async helpers ([1bed02d](https://github.com/crack00r/eidolon/commit/1bed02d14f37a9c3f1c2d39ab6a193ef83d0ae86))
* **web:** implement SvelteKit web interface with security headers ([1dce772](https://github.com/crack00r/eidolon/commit/1dce7727a254e422196546378d74d116d7015304))


### Bug Fixes

* **ci:** make all workflows pass on initial empty monorepo ([3077392](https://github.com/crack00r/eidolon/commit/307739267739e7b55f2b1d17088ba4593b9ffa7b))
* **ci:** resolve pnpm version conflict and enable PR creation ([a0938dc](https://github.com/crack00r/eidolon/commit/a0938dc77664a6178b1803c620d5114867d60d13))
* **ci:** set initial release version to 0.1.0 (development phase) ([f360195](https://github.com/crack00r/eidolon/commit/f360195ac6ede72ea071b779baf4ae00f96c9d70))


### Documentation

* add Knowledge Graph (TransE), real-time voice protocol, and research-driven enhancements ([a06f5a7](https://github.com/crack00r/eidolon/commit/a06f5a7d9e7e84b68aec151288669faff97db606))
* add master implementation plan with exact file structure, interfaces, and build order ([bad8ea4](https://github.com/crack00r/eidolon/commit/bad8ea40b8d8f969bc883cd7e3b7adaf090c881f))
* complete project documentation and architecture plan ([d4562aa](https://github.com/crack00r/eidolon/commit/d4562aad6fae796f87dd880306781c1c59e70bae))
* integrate 20 expert review findings into architecture and design ([bb2563c](https://github.com/crack00r/eidolon/commit/bb2563c611a68dd0c8e73c8261a7a1921eb5594f))
* update README with security audit results and streamlined content ([e69dd8a](https://github.com/crack00r/eidolon/commit/e69dd8ae8e7131d09a47bd87cbad8091bd7cb921))


### Miscellaneous

* add .keys/ to gitignore for signing key safety ([091d574](https://github.com/crack00r/eidolon/commit/091d574a178cfea211bc3833def25c9f83f61f7a))
* add Claude Code development infrastructure ([e6cbedf](https://github.com/crack00r/eidolon/commit/e6cbedf41e096b1b33e23cd575be10ee7bcea959))
* add security type to release-please changelog sections ([9e4b2ed](https://github.com/crack00r/eidolon/commit/9e4b2edeab5961ac2c9049b8f645d81ba8b46ad7))
* add systemd service files and fix TypeScript/build configuration ([275ad4e](https://github.com/crack00r/eidolon/commit/275ad4e1e20d50f68560b843170b9d4ea87ee410))


### Security

* **all:** fix 29 LOW-severity audit findings ([7ef7d44](https://github.com/crack00r/eidolon/commit/7ef7d445f63418a1a64f20f474d7e9f3a51c02af))
* **core,cli,protocol,desktop,web,ios,gpu:** fix 48 CRITICAL+HIGH+MEDIUM audit findings ([cb1b029](https://github.com/crack00r/eidolon/commit/cb1b0295b9095b438e0ab9f72601241e8406b599))
* **core,desktop,ios:** harden gateway with TLS, rate limiting, and fix auth protocol ([5e4fcc9](https://github.com/crack00r/eidolon/commit/5e4fcc9385bc29a8366d1883f85a688394327a48))


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
