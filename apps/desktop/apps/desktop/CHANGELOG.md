# Changelog

## [0.2.1](https://github.com/crack00r/eidolon/compare/v0.2.0...v0.2.1) (2026-03-09)


### Features

* **desktop:** add chat history, conversation sidebar, and improved memory/learning views ([3714cb6](https://github.com/crack00r/eidolon/commit/3714cb669f75552152bb54ac40d8022a3af5027b))


### Bug Fixes

* **desktop:** fix reconnect on restart and resolve $secret references in Rust ([373c82f](https://github.com/crack00r/eidolon/commit/373c82f818652817a1b19a453782b5d3e631bf6b))

## [0.2.0](https://github.com/crack00r/eidolon/compare/v0.1.15...v0.2.0) (2026-03-09)


### Bug Fixes

* **protocol:** strengthen type safety and config schemas ([0b03760](https://github.com/crack00r/eidolon/commit/0b03760fbda5bf7a40b01c7620f4d9f82996530b))


### Miscellaneous

* release v0.2.0 -- 20-round comprehensive security audit ([b957408](https://github.com/crack00r/eidolon/commit/b95740890155b6b065aa1ff51d42bb8a7e1b682d))

## [0.1.15](https://github.com/crack00r/eidolon/compare/v0.1.14...v0.1.15) (2026-03-08)


### Bug Fixes

* **apps:** harden desktop, web, and CLI frontends ([3bbbf96](https://github.com/crack00r/eidolon/commit/3bbbf967d5e0cff74d21efa048a6746affec8a01))
* **desktop:** fix daemon exit event payload and add updater bundles ([c6df384](https://github.com/crack00r/eidolon/commit/c6df3846ea4223f7375b6400165c38a4eb10786c))

## [0.1.14](https://github.com/crack00r/eidolon/compare/v0.1.13...v0.1.14) (2026-03-08)


### Bug Fixes

* comprehensive bugfix across desktop, protocol, core, CLI, and CI ([6615af4](https://github.com/crack00r/eidolon/commit/6615af40d7554acf43b5358138671431f9b15843))
* critical bugfixes for chat, credentials, onboarding, and daemon ([858f4a8](https://github.com/crack00r/eidolon/commit/858f4a87b615b84f41ed0303df9604b064218e3d))
* **desktop:** configure real updater signing keys and fix workflow ([95cea29](https://github.com/crack00r/eidolon/commit/95cea29564f78b8ce9c6f57f62f7a7bfff090703))
* **desktop:** use Tauri sidecar API instead of manual path resolution ([de0457d](https://github.com/crack00r/eidolon/commit/de0457d2739b688f35737b20b05f0e665783bee2))

## [0.1.13](https://github.com/crack00r/eidolon/compare/v0.1.12...v0.1.13) (2026-03-07)


### Bug Fixes

* sync Cargo.toml version to 0.1.12 and fix release-please TOML config ([2a222d6](https://github.com/crack00r/eidolon/commit/2a222d6145adedc5972f4e55ceb568e5c2b7393c))

## [0.1.12](https://github.com/crack00r/eidolon/compare/v0.1.11...v0.1.12) (2026-03-07)


### Bug Fixes

* **desktop:** fix bun eval and onboarding server setup ([e62a3a7](https://github.com/crack00r/eidolon/commit/e62a3a721e201273145ddd029bdcdc9d9a193b7d))

## [0.1.11](https://github.com/crack00r/eidolon/compare/v0.1.10...v0.1.11) (2026-03-07)


### Features

* **desktop:** add onboarding UI with role selection, server setup, and client pairing ([4014ca8](https://github.com/crack00r/eidolon/commit/4014ca8b2478e30120db10c897c13d30dd481699))
* **desktop:** add Tauri commands for daemon lifecycle and onboarding ([dedaca8](https://github.com/crack00r/eidolon/commit/dedaca8841794e3ad7dad6b72f7b9f8e5e0b9736))
* **desktop:** auto-connect on launch and persist settings ([37b4c62](https://github.com/crack00r/eidolon/commit/37b4c627a4739118afdc5b2bf47d0a4f625619c3))


### Bug Fixes

* **desktop:** default useTls to false to match server default ([ff193eb](https://github.com/crack00r/eidolon/commit/ff193eb40fdb7af1b077d9e664f6847bb88af0e2))
* **desktop:** expand CSP connect-src to allow WebSocket and Tailscale domains ([9ab800d](https://github.com/crack00r/eidolon/commit/9ab800d8f517901fc3a686c93327a557f60fafee))
* **desktop:** show dynamic app version instead of hardcoded v0.1.0 ([6f731dd](https://github.com/crack00r/eidolon/commit/6f731dd8ad3657e5a7c20a5417665f7eabcebb77))
* **desktop:** sync tauri.conf.json version with release-please ([24a092e](https://github.com/crack00r/eidolon/commit/24a092ed22288043199b723dbf1cb3cf8d0b989f))

## [0.1.10](https://github.com/crack00r/eidolon/compare/v0.1.9...v0.1.10) (2026-03-07)


### Features

* implement v2.1 features -- proactive intelligence, agentic workflows, slack, browser, MCP marketplace, wyoming, multi-user, project management, node replication ([157a7cb](https://github.com/crack00r/eidolon/commit/157a7cb5aae6f7fa6acbb3cf397372c352976adc))


### Bug Fixes

* **desktop:** exclude test files from svelte-check typecheck ([db0fa5c](https://github.com/crack00r/eidolon/commit/db0fa5c40d2a3db755209ce292e07884b6a3de8d))

## [0.1.9](https://github.com/crack00r/eidolon/compare/v0.1.8...v0.1.9) (2026-03-07)


### Bug Fixes

* sync tauri.conf.json version and add extra-files to release-please ([7d6172d](https://github.com/crack00r/eidolon/commit/7d6172d3b23979e6ddb9796b6d33c8c9da343956))

## [0.1.8](https://github.com/crack00r/eidolon/compare/v0.1.7...v0.1.8) (2026-03-07)


### Features

* **core:** implement Waves 5-9 features, tests, and documentation ([05c2357](https://github.com/crack00r/eidolon/commit/05c235775582c1cdbd972c54f94656ccad12c40d))


### Bug Fixes

* sync desktop and iOS app versions to 0.1.7 and add to release-please ([318407c](https://github.com/crack00r/eidolon/commit/318407cf6807c1f9f2841b3f9f9bb31b5f636b55))
