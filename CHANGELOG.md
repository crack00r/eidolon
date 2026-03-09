# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** This changelog is automatically managed by
> [release-please](https://github.com/googleapis/release-please).
> Do not edit manually.

## [0.2.3](https://github.com/crack00r/eidolon/compare/v0.2.2...v0.2.3) (2026-03-09)


### Bug Fixes

* **ci:** invalidate Rust cache to fix Linux GLIBC_2.39 build failure ([be0c917](https://github.com/crack00r/eidolon/commit/be0c917027a1f6b003a316fd777e84a5095e130f))

## [0.2.2](https://github.com/crack00r/eidolon/compare/v0.2.1...v0.2.2) (2026-03-09)


### Bug Fixes

* **desktop:** downgrade zerocopy to 0.8.23 for Ubuntu 22.04 GLIBC compatibility ([57ada8a](https://github.com/crack00r/eidolon/commit/57ada8a99f273427436a5de38b3021e8c75f454a))

## [0.2.1](https://github.com/crack00r/eidolon/compare/v0.2.0...v0.2.1) (2026-03-09)


### Features

* **core:** add memory population, learning activation, parallel sessions, and REST API ([6def0ea](https://github.com/crack00r/eidolon/commit/6def0eaa834c616fd2ad7d21b434c4407c4d55ca))
* **desktop:** add chat history, conversation sidebar, and improved memory/learning views ([3714cb6](https://github.com/crack00r/eidolon/commit/3714cb669f75552152bb54ac40d8022a3af5027b))


### Bug Fixes

* **ci:** fix CLI build output path and pin Linux runner to Ubuntu 22.04 ([614f7b7](https://github.com/crack00r/eidolon/commit/614f7b70022403a108a3ad43971c14fb5d029cee))
* **cli:** inject version at build time for compiled binaries ([2800887](https://github.com/crack00r/eidolon/commit/2800887b3b0ab25668f19abc6331a2e2ae9f937b))
* **core:** remove stale session-resume test and old ConversationSessionStore init ([1b170d3](https://github.com/crack00r/eidolon/commit/1b170d3a8d195f00335f2df354df0383eb08d8c4))
* **desktop:** fix reconnect on restart and resolve $secret references in Rust ([373c82f](https://github.com/crack00r/eidolon/commit/373c82f818652817a1b19a453782b5d3e631bf6b))

## [0.2.0](https://github.com/crack00r/eidolon/compare/v0.1.15...v0.2.0) (2026-03-09)


### Bug Fixes

* **core:** gateway event publishing and client manager cleanup ([03f2cc8](https://github.com/crack00r/eidolon/commit/03f2cc8dfca501bb8288cc7537bca469fb286aea))
* **core:** harden daemon, workflow, GPU, and infrastructure subsystems ([1c3f112](https://github.com/crack00r/eidolon/commit/1c3f1120f83fd22a094d451e67d24440f764ff3a))
* **core:** harden memory, learning, channels, and data layer ([ecaec57](https://github.com/crack00r/eidolon/commit/ecaec57f8881637b8cf249bbc240ada5e80ba404))
* **core:** improve resource cleanup, resilience, and error handling ([237dfa4](https://github.com/crack00r/eidolon/commit/237dfa43a65f2b1d90c40f7804ea3b0df7fae802))
* **protocol:** strengthen type safety and config schemas ([0b03760](https://github.com/crack00r/eidolon/commit/0b03760fbda5bf7a40b01c7620f4d9f82996530b))
* **security:** harden auth, SSRF protection, secrets, and privacy across codebase ([60310fa](https://github.com/crack00r/eidolon/commit/60310fa43aeefa6b5b5310af32d904cad2120f78))


### Miscellaneous

* release v0.2.0 -- 20-round comprehensive security audit ([b957408](https://github.com/crack00r/eidolon/commit/b95740890155b6b065aa1ff51d42bb8a7e1b682d))
* update agent memory ([6cda069](https://github.com/crack00r/eidolon/commit/6cda0692e63fbaf93e3ab01d1648e5ffae179b6a))


### Tests

* **core:** add security tests and update test expectations for audit fixes ([08ba348](https://github.com/crack00r/eidolon/commit/08ba3484dbedc98f2c536456dbbd8fb718e050c7))

## [0.1.15](https://github.com/crack00r/eidolon/compare/v0.1.14...v0.1.15) (2026-03-08)


### Bug Fixes

* **apps:** harden desktop, web, and CLI frontends ([3bbbf96](https://github.com/crack00r/eidolon/commit/3bbbf967d5e0cff74d21efa048a6746affec8a01))
* **channels:** harden all communication channels ([9f5e783](https://github.com/crack00r/eidolon/commit/9f5e783b9df8e569ba34157c43fe3f71c9d3577c))
* **ci:** remove deprecated macOS Intel target and fix Linux AppImage build ([098224d](https://github.com/crack00r/eidolon/commit/098224dc5c605d68e0564bc1af31af33d8982e82))
* **cli:** add missing zod dependency for Ollama schema validation ([d3d4c4e](https://github.com/crack00r/eidolon/commit/d3d4c4e3b07878a3f7d3010beaef06126aa6a099))
* **config:** sync versions, release-please, and config validation ([f8ad461](https://github.com/crack00r/eidolon/commit/f8ad461e7e57f5cb49e0a00f14aca820d2ba536b))
* **data:** add transactions, UPSERT, and data integrity guards ([4b0ec58](https://github.com/crack00r/eidolon/commit/4b0ec585f9d0f221385b351f6292eb5142cea543))
* **desktop:** fix daemon exit event payload and add updater bundles ([c6df384](https://github.com/crack00r/eidolon/commit/c6df3846ea4223f7375b6400165c38a4eb10786c))
* **errors:** improve error handling, resource cleanup, and resilience ([dd97686](https://github.com/crack00r/eidolon/commit/dd976860105237363d5d5921252ee79c4787d775))
* **resources:** add bounds, rate limits, and memory safety ([613509f](https://github.com/crack00r/eidolon/commit/613509fc71db6c624ba6b01d95a18e45a1873f4a))
* **security:** prevent injection, SSRF, and auth vulnerabilities ([b067a9f](https://github.com/crack00r/eidolon/commit/b067a9fe5ad990dc42127d34aeeea00f2c7b4805))
* **types:** strengthen type safety and Zod boundary validation ([a9d65f3](https://github.com/crack00r/eidolon/commit/a9d65f3c009444d208914111bf4490ca7effc093))


### Miscellaneous

* update agent memory ([3172675](https://github.com/crack00r/eidolon/commit/3172675021a5da9ba808c92557e9adc24fb5e49d))


### Tests

* fix error code expectation in daemon memory integration test ([afb668a](https://github.com/crack00r/eidolon/commit/afb668a3ae38b24c07eb8ff4e87d09fb622b11e6))
* update tests for audit fixes ([f688ef2](https://github.com/crack00r/eidolon/commit/f688ef2bc3c151aa2bbb34d20def1014447ace63))

## [0.1.14](https://github.com/crack00r/eidolon/compare/v0.1.13...v0.1.14) (2026-03-08)


### Bug Fixes

* **ci:** add macOS Intel build and prevent CLI duplicate publish ([488a8b3](https://github.com/crack00r/eidolon/commit/488a8b3340bd525e351ad139ffe0361660b52778))
* comprehensive bugfix across desktop, protocol, core, CLI, and CI ([6615af4](https://github.com/crack00r/eidolon/commit/6615af40d7554acf43b5358138671431f9b15843))
* critical bugfixes for chat, credentials, onboarding, and daemon ([858f4a8](https://github.com/crack00r/eidolon/commit/858f4a87b615b84f41ed0303df9604b064218e3d))
* **desktop:** configure real updater signing keys and fix workflow ([95cea29](https://github.com/crack00r/eidolon/commit/95cea29564f78b8ce9c6f57f62f7a7bfff090703))
* **desktop:** use Tauri sidecar API instead of manual path resolution ([de0457d](https://github.com/crack00r/eidolon/commit/de0457d2739b688f35737b20b05f0e665783bee2))

## [0.1.13](https://github.com/crack00r/eidolon/compare/v0.1.12...v0.1.13) (2026-03-07)


### Bug Fixes

* **ci:** build CLI sidecar binary before Tauri desktop build ([a8a7991](https://github.com/crack00r/eidolon/commit/a8a79911b22e896fba2c43d2c229947a70eeae16))
* sync Cargo.toml version to 0.1.12 and fix release-please TOML config ([2a222d6](https://github.com/crack00r/eidolon/commit/2a222d6145adedc5972f4e55ceb568e5c2b7393c))

## [0.1.12](https://github.com/crack00r/eidolon/compare/v0.1.11...v0.1.12) (2026-03-07)


### Bug Fixes

* **desktop:** fix bun eval and onboarding server setup ([e62a3a7](https://github.com/crack00r/eidolon/commit/e62a3a721e201273145ddd029bdcdc9d9a193b7d))

## [0.1.11](https://github.com/crack00r/eidolon/compare/v0.1.10...v0.1.11) (2026-03-07)


### Features

* **cli:** add daemon logs command ([5bce1ad](https://github.com/crack00r/eidolon/commit/5bce1ad48eb8177527d995c6cd015940c093a534))
* **core:** add shared onboarding modules with tests ([0d0c939](https://github.com/crack00r/eidolon/commit/0d0c939118aa155d2081e734abe6187f1422af10))
* **desktop:** add onboarding UI with role selection, server setup, and client pairing ([4014ca8](https://github.com/crack00r/eidolon/commit/4014ca8b2478e30120db10c897c13d30dd481699))
* **desktop:** add Tauri commands for daemon lifecycle and onboarding ([dedaca8](https://github.com/crack00r/eidolon/commit/dedaca8841794e3ad7dad6b72f7b9f8e5e0b9736))
* **desktop:** auto-connect on launch and persist settings ([37b4c62](https://github.com/crack00r/eidolon/commit/37b4c627a4739118afdc5b2bf47d0a4f625619c3))
* **protocol:** add role and server fields to config schema ([cf45071](https://github.com/crack00r/eidolon/commit/cf45071e96ce65987e9883891c3fef2abd0c536e))


### Bug Fixes

* **cli:** pass --config flag to EidolonDaemon in foreground mode ([c9ba26c](https://github.com/crack00r/eidolon/commit/c9ba26c9d7863cc7079bebf2e39195730b8af0b4))
* **core,cli:** resolve all lint errors across codebase ([bf3de05](https://github.com/crack00r/eidolon/commit/bf3de0597bf920da5f568129175726e40531fca7))
* **core:** improve error message when config file is not found ([2c33e50](https://github.com/crack00r/eidolon/commit/2c33e50fb4bf5bbe3993fe6591592ca07712cc7b))
* **core:** resolve typecheck errors from lint cleanup ([8b9377a](https://github.com/crack00r/eidolon/commit/8b9377a2db105221a0609b433b081eb47712b70a))
* **desktop:** default useTls to false to match server default ([ff193eb](https://github.com/crack00r/eidolon/commit/ff193eb40fdb7af1b077d9e664f6847bb88af0e2))
* **desktop:** expand CSP connect-src to allow WebSocket and Tailscale domains ([9ab800d](https://github.com/crack00r/eidolon/commit/9ab800d8f517901fc3a686c93327a557f60fafee))
* **desktop:** show dynamic app version instead of hardcoded v0.1.0 ([6f731dd](https://github.com/crack00r/eidolon/commit/6f731dd8ad3657e5a7c20a5417665f7eabcebb77))
* **desktop:** sync tauri.conf.json version with release-please ([24a092e](https://github.com/crack00r/eidolon/commit/24a092ed22288043199b723dbf1cb3cf8d0b989f))
* **protocol,cli:** resolve lint errors and update test mocks ([74b018a](https://github.com/crack00r/eidolon/commit/74b018a798859d06309005598660cafe6bf75bff))
* **protocol:** change gateway auth default from "token" to "none" ([ae9116e](https://github.com/crack00r/eidolon/commit/ae9116ec349dc770511eb5f744aaeb50cbbcdf59))
* **protocol:** read VERSION from package.json instead of hardcoded "0.0.0" ([d75dfe5](https://github.com/crack00r/eidolon/commit/d75dfe5c08a4565ab9a29e0c36fcfa448b1e2244))


### Code Refactoring

* **cli:** delegate onboarding logic to shared core modules ([e1ca7b2](https://github.com/crack00r/eidolon/commit/e1ca7b2b4fc7e3bff74c3b8a1339999af9b993e7))


### Documentation

* first-launch experience implementation plan ([f3f3075](https://github.com/crack00r/eidolon/commit/f3f30756245d5b9c169242451edcaaba16eed3bb))
* first-launch experience redesign design doc ([5dabb6e](https://github.com/crack00r/eidolon/commit/5dabb6e89613af114d035d2c08d9da7ccd5c7aca))

## [0.1.10](https://github.com/crack00r/eidolon/compare/v0.1.9...v0.1.10) (2026-03-07)


### Features

* implement v2.1 features -- proactive intelligence, agentic workflows, slack, browser, MCP marketplace, wyoming, multi-user, project management, node replication ([157a7cb](https://github.com/crack00r/eidolon/commit/157a7cb5aae6f7fa6acbb3cf397372c352976adc))


### Bug Fixes

* **cli:** expand privacy-forget.ts formatting for biome compliance ([312ca22](https://github.com/crack00r/eidolon/commit/312ca22f1b8bceab6a01db07fb8c137d19adec11))
* **core,cli,protocol:** biome lint and formatting fixes across all packages ([52c5d4d](https://github.com/crack00r/eidolon/commit/52c5d4d836a2629d6a28abf78f7db4fd35b60c8e))
* **core:** fix test failures in MemoryMcpServer and TelegramChannel ([a5541e1](https://github.com/crack00r/eidolon/commit/a5541e1f76fc56b519098fac023ea4d267f99701))
* **desktop:** exclude test files from svelte-check typecheck ([db0fa5c](https://github.com/crack00r/eidolon/commit/db0fa5c40d2a3db755209ce292e07884b6a3de8d))
* update pnpm-lock.yaml for @slack/bolt dependency ([814e3a0](https://github.com/crack00r/eidolon/commit/814e3a0fed3323c3c76a5baa6ce8b4931f4a5f16))
* **web:** exclude test files from svelte-check typecheck ([5893f8d](https://github.com/crack00r/eidolon/commit/5893f8d7b3ade3b89c6a1c3e168862371c3a754a))

## [0.1.9](https://github.com/crack00r/eidolon/compare/v0.1.8...v0.1.9) (2026-03-07)


### Bug Fixes

* sync tauri.conf.json version and add extra-files to release-please ([7d6172d](https://github.com/crack00r/eidolon/commit/7d6172d3b23979e6ddb9796b6d33c8c9da343956))


### Documentation

* update ROADMAP version to v0.1.8 ([57077e1](https://github.com/crack00r/eidolon/commit/57077e13fe0a38ebcc5923781e7365e15d987d9d))

## [0.1.8](https://github.com/crack00r/eidolon/compare/v0.1.7...v0.1.8) (2026-03-07)


### Features

* **core:** add security hardening, Memory MCP server, and PWA support ([9fb423d](https://github.com/crack00r/eidolon/commit/9fb423d0ede73744984cb8a2584793ee0345177d))
* **core:** implement sqlite-vec ANN search, npm publish workflow, and doc corrections ([fe4e41c](https://github.com/crack00r/eidolon/commit/fe4e41cee6c4dcfcdb6542a22c0eb6f492b6d16b))
* **core:** implement Wave 1 foundation tasks ([d257d1f](https://github.com/crack00r/eidolon/commit/d257d1f703122e95d09195cc6b6743304dd602fb))
* **core:** implement Wave 2 core wiring and daemon decomposition ([13f5a15](https://github.com/crack00r/eidolon/commit/13f5a1585bc438a8a213b82f7302656beab16d74))
* **core:** implement Wave 3 gateway methods, KG predictions, and learning pipeline ([6bc8054](https://github.com/crack00r/eidolon/commit/6bc805496076df26472ab4f6c12084eb89b9745a))
* **core:** implement Waves 5-9 features, tests, and documentation ([05c2357](https://github.com/crack00r/eidolon/commit/05c235775582c1cdbd972c54f94656ccad12c40d))
* **core:** wire user:message handler in daemon event loop ([ed3651e](https://github.com/crack00r/eidolon/commit/ed3651eebd379736cbcc79a053f66ddb679bbc02))


### Bug Fixes

* close 9 remaining gaps from plan audit ([8630c3e](https://github.com/crack00r/eidolon/commit/8630c3e18a4dbec80d522c671d20d686b107ef1f))
* close all completeness gaps from project audit ([446ac5a](https://github.com/crack00r/eidolon/commit/446ac5a9fc663a9a8b520d3f1b82aa72243b2ed9))
* **ios:** resolve Swift strict concurrency errors in deinit and NWConnection handlers ([682f588](https://github.com/crack00r/eidolon/commit/682f5887fac7d4483f86cbd6fc10d3fdb114f1a6))
* sync desktop and iOS app versions to 0.1.7 and add to release-please ([318407c](https://github.com/crack00r/eidolon/commit/318407cf6807c1f9f2841b3f9f9bb31b5f636b55))


### Documentation

* update ROADMAP test count and CONFIGURATION reference ([6cc7904](https://github.com/crack00r/eidolon/commit/6cc7904ef6f3b7c56e710e2dc948c036db8d3ed5))
* update ROADMAP test count to 2658 and version to v0.1.7 ([bcaea24](https://github.com/crack00r/eidolon/commit/bcaea24b88039c0308fe84153288a3adaf69bffc))


### CI/CD

* add workflow_dispatch trigger to release workflow ([4098cf2](https://github.com/crack00r/eidolon/commit/4098cf20a9a552a37e98749873ec206d05c48f59))


### Tests

* **core:** add Wave 4 integration tests and Wave 5 code quality improvements ([b7d6e61](https://github.com/crack00r/eidolon/commit/b7d6e61fffe4d003eaf5b6caf4fcd3a1dfd1e2f6))

## [0.1.7](https://github.com/crack00r/eidolon/compare/v0.1.6...v0.1.7) (2026-03-06)


### Documentation

* update roadmap and plans to reflect v2.0 completion ([13d90dc](https://github.com/crack00r/eidolon/commit/13d90dca5ed0520460d13445c3eefda0f047c62d))

## [0.1.6](https://github.com/crack00r/eidolon/compare/v0.1.5...v0.1.6) (2026-03-06)


### Features

* **core:** add MCP secret resolution, entity dedup, gateway rate limiting, and client logging ([da0b88a](https://github.com/crack00r/eidolon/commit/da0b88a8a8ddc25749295ce6e038ece21556d6bf))
* **core:** add OpenAI-compatible REST API, webhook ingestion, and user profile generation ([a5cb3b2](https://github.com/crack00r/eidolon/commit/a5cb3b2b2df4ff61fd42ad60a9ad8224850e6286))
* **core:** add OpenTelemetry distributed tracing integration ([9fb1ec8](https://github.com/crack00r/eidolon/commit/9fb1ec828beb6dfbb1978598631f5d54edd6a77a))
* **core:** add WhatsApp and Email channel implementations ([18807e7](https://github.com/crack00r/eidolon/commit/18807e7518e191755df7bdd39a50cc15ac555e58))
* **core:** implement Integration Plan Tier 1 (Sprints 1-3) ([a5a95c1](https://github.com/crack00r/eidolon/commit/a5a95c18cac8562c409003f3237efcf09cc081c0))
* **core:** implement Integration Plan Tier 2 (Sprints 4-8) ([60f2436](https://github.com/crack00r/eidolon/commit/60f2436dc16f252f094417c024e8a1ac3ed48202))
* **core:** implement Integration Plan Tier 3 (Sprints 9-12) ([3e65366](https://github.com/crack00r/eidolon/commit/3e6536600edf2d84e09cc9459c1e92838444b790))
* **core:** implement plugin system and local LLM provider support ([3b146f9](https://github.com/crack00r/eidolon/commit/3b146f9aab556f987becb527b2180a7b4c539e50))
* **core:** implement post-v1.0 Sprint 1 - Calendar Integration and Multi-GPU Worker Pool ([6cda4e5](https://github.com/crack00r/eidolon/commit/6cda4e5882d6310da575cb76b34592a84bed03ab))
* **core:** implement post-v1.0 Sprint 2 - Advanced Home Automation and Web Dashboard ([0592770](https://github.com/crack00r/eidolon/commit/0592770b410d661af6778e5eb86648a4c92442cf))
* **core:** wire CognitiveLoop and full PEAR pipeline in daemon initialization ([f18ca0d](https://github.com/crack00r/eidolon/commit/f18ca0ddcc36347a01c5988c2ae7e804400eab9c))
* **core:** wire Prometheus metrics, Telegram channel, and graceful shutdown ([bfed16d](https://github.com/crack00r/eidolon/commit/bfed16dff9c50569aa33d124ddffd34ae7bab580))
* cross-platform daemon, setup guides, client logging, and onboard wizard ([eb69200](https://github.com/crack00r/eidolon/commit/eb69200483e304a909b8ff45e472432c143847e4))
* **ios:** add Dashboard and Learning views with MVVM architecture ([cc44526](https://github.com/crack00r/eidolon/commit/cc44526f5bd4373466a08aaa6c7f15e1dfe79a76))
* network discovery, setup guides, and cross-platform deployment ([87651bd](https://github.com/crack00r/eidolon/commit/87651bdcabbc4ff7374990927f295668566321df))
* unified design system, iOS voice mode, Prometheus metrics, and completeness gaps ([b918d13](https://github.com/crack00r/eidolon/commit/b918d133add734583412c7b4800d11bd039890b9))
* **web:** implement Sprint 3 - calendar dashboard route and gateway handlers ([8a12b30](https://github.com/crack00r/eidolon/commit/8a12b30e490738fe8c01e2106bfd3e56c01d5c10))


### Bug Fixes

* **cli:** refactor onboard wizard into modular steps and fix phone-home logging ([9d15914](https://github.com/crack00r/eidolon/commit/9d15914c86aaacf1345ad07a6c70b5989d96a225))
* close completeness gaps G-06, G-08, G-12, G-14 ([a4c0442](https://github.com/crack00r/eidolon/commit/a4c04425041ce9ee703448c46afb3f47b6303d2b))
* close completeness gaps G-06/G-08/G-10/G-11/G-14/G-15 ([999f09d](https://github.com/crack00r/eidolon/commit/999f09defac86d21ee0549bab21c2f6d3ed8b6af))
* close final completeness gaps G-01 and G-10 ([3c92e14](https://github.com/crack00r/eidolon/commit/3c92e144b1c9835734c863de4f9a3b7f50fb0951))
* **core:** restore class property declarations removed by Biome unsafe lint ([cd6e3a9](https://github.com/crack00r/eidolon/commit/cd6e3a9429f992c725912818559a15fd06feacac))
* **security:** second-round security audit remediation across audits [#8](https://github.com/crack00r/eidolon/issues/8)-[#12](https://github.com/crack00r/eidolon/issues/12) ([8b939b5](https://github.com/crack00r/eidolon/commit/8b939b54f81be53edf3aa27130341c85f5b8d7aa))


### Documentation

* add completeness audit report and onboard wizard tests ([dd059f1](https://github.com/crack00r/eidolon/commit/dd059f1938bd41a6ebf2a02e59237a77eeab2f48))
* add post-v1.0 implementation plan for top 4 v1.1 features ([e416fec](https://github.com/crack00r/eidolon/commit/e416fec8e10cb03dc111ec30a1ed9a1428987bf7))
* add v1.2/v2.0 implementation plan and update roadmap ([8f4d80c](https://github.com/crack00r/eidolon/commit/8f4d80c4105d6c9b9c51150dae7214f1be7f2f60))
* mark post-v1.0 plan as completed ([4119b23](https://github.com/crack00r/eidolon/commit/4119b23f6e300c4d7ecc965c6f50ea8cc36a8a0c))


### Miscellaneous

* update agent memory with Integration Plan patterns and live status ([ec96c3a](https://github.com/crack00r/eidolon/commit/ec96c3aaa29d8fcbe9c519f2020560e382e6680b))
* update planner agent memory ([cb67934](https://github.com/crack00r/eidolon/commit/cb67934466584e1a9cc24237ceba70222801e371))

## [0.1.5](https://github.com/crack00r/eidolon/compare/v0.1.4...v0.1.5) (2026-03-02)


### Features

* **all:** add integration tests, example config, fix lint, align versions, update roadmap ([8f62577](https://github.com/crack00r/eidolon/commit/8f625772ef8fd70e61b0180952d3276a9f1c0fa9))


### Bug Fixes

* **cli:** complete server/client install on all platforms ([ee11538](https://github.com/crack00r/eidolon/commit/ee115382bb97e8de847ac8ff70b8ec32b698d170))
* **core:** add zod dependency and fix implicit any types in gateway RPC validation ([e465c85](https://github.com/crack00r/eidolon/commit/e465c85633d6f759d777f952b4de578848bcf26d))
* **security:** comprehensive security audit remediation across all 8 domains ([504e644](https://github.com/crack00r/eidolon/commit/504e644c518f4df00f6f95f4f546f35b42668fca))


### CI/CD

* **ios:** move iOS workflow to deploy/ to fix phantom CI failures ([4965bd9](https://github.com/crack00r/eidolon/commit/4965bd9fd9bef327d5decef500537c3e57965b12))
* **ios:** suppress phantom push failures for workflow_dispatch-only workflow ([ca16db2](https://github.com/crack00r/eidolon/commit/ca16db22b4d79704ad0352302beb93d0c3ddcf2f))

## [0.1.4](https://github.com/crack00r/eidolon/compare/v0.1.3...v0.1.4) (2026-03-02)


### Features

* **all:** fix cron regex, add health check modules, wire daemon placeholders, add test-database helper ([b0af387](https://github.com/crack00r/eidolon/commit/b0af387c11b68ebb787e07b7fc3bdb0c665db93d))


### Bug Fixes

* **core:** complete barrel exports for learning and knowledge-graph modules ([e127993](https://github.com/crack00r/eidolon/commit/e1279936a6dc030a21ccc00872156411965c7e7a))

## [0.1.3](https://github.com/crack00r/eidolon/compare/v0.1.2...v0.1.3) (2026-03-02)


### Features

* **all:** add network discovery, enhanced onboarding, and cross-platform service support ([8cfdb3d](https://github.com/crack00r/eidolon/commit/8cfdb3de3f91af5093fdfcafe8cfd231afc199ef))


### Bug Fixes

* **all:** auto-fix biome lint formatting issues in discovery and onboard modules ([bff0716](https://github.com/crack00r/eidolon/commit/bff0716bdca9c56d1239ea6c91a6c1dcc076cb70))
* **desktop:** use Builder pattern for tauri-plugin-updater v2 ([13a60fe](https://github.com/crack00r/eidolon/commit/13a60febf3ab203ef555c59c480ed47b65ec68d8))

## [0.1.2](https://github.com/crack00r/eidolon/compare/v0.1.1...v0.1.2) (2026-03-02)


### Features

* **all:** add real-time dashboard, bidirectional client control, and auto-update ([cb29370](https://github.com/crack00r/eidolon/commit/cb293704dfbb960f8251d5d9ebdb49557eebd3b0))
* **all:** add setup documentation, fix 44 logging gaps, implement error reporting ([a766897](https://github.com/crack00r/eidolon/commit/a7668977d7be5691c103b339808ec67baa75fb0f))
* **all:** close implementation plan gaps — CLI tests, KG communities, realtime voice, APNs, constants ([508b595](https://github.com/crack00r/eidolon/commit/508b595fe930906b289b19d1faf788244c64e076))


### Bug Fixes

* **all:** change .js to .ts in all import/export paths for Linux Bun compatibility ([59fbd49](https://github.com/crack00r/eidolon/commit/59fbd496c2e22375cbb9ee22820a5c73a2cacce7))
* **ci:** move build step before test to ensure dist/ exists for cross-package imports ([fe41c34](https://github.com/crack00r/eidolon/commit/fe41c3421987fe18d0a04c74bb2f5fcb1dab60cf))
* **cli:** add mock.module for @eidolon/core before command imports in CI ([162bdd0](https://github.com/crack00r/eidolon/commit/162bdd0d8ea0893ad4b7cf63232a263dd8b84b33))
* **cli:** add test preload file for global @eidolon/core mock in CI ([e3e3237](https://github.com/crack00r/eidolon/commit/e3e3237749bfb65893c5bf7567b47eb8d637013f))
* **cli:** run each test file in separate Bun process to fix Linux mock.module bug ([2ca3c46](https://github.com/crack00r/eidolon/commit/2ca3c46cda77a5acb957ec10e878d9c683989609))
* **core:** add exports map for reliable Bun workspace resolution on Linux ([ef23963](https://github.com/crack00r/eidolon/commit/ef23963cfbe7be42a68208f0ef54e89bf9439f93))
* **core:** change main field to dist/index.js for Linux CI compatibility ([a83ee6f](https://github.com/crack00r/eidolon/commit/a83ee6f57b9e4d1ad35431bd15a9c82a3e1a23b6))

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
