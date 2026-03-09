# Changelog

## [0.2.1](https://github.com/crack00r/eidolon/compare/v0.2.0...v0.2.1) (2026-03-09)


### Bug Fixes

* **ci:** fix CLI build output path and pin Linux runner to Ubuntu 22.04 ([614f7b7](https://github.com/crack00r/eidolon/commit/614f7b70022403a108a3ad43971c14fb5d029cee))
* **cli:** inject version at build time for compiled binaries ([2800887](https://github.com/crack00r/eidolon/commit/2800887b3b0ab25668f19abc6331a2e2ae9f937b))

## [0.2.0](https://github.com/crack00r/eidolon/compare/v0.1.14...v0.2.0) (2026-03-09)


### Bug Fixes

* **apps:** harden desktop, web, and CLI frontends ([3bbbf96](https://github.com/crack00r/eidolon/commit/3bbbf967d5e0cff74d21efa048a6746affec8a01))
* **cli:** add missing zod dependency for Ollama schema validation ([d3d4c4e](https://github.com/crack00r/eidolon/commit/d3d4c4e3b07878a3f7d3010beaef06126aa6a099))
* **core:** improve resource cleanup, resilience, and error handling ([237dfa4](https://github.com/crack00r/eidolon/commit/237dfa43a65f2b1d90c40f7804ea3b0df7fae802))
* **security:** harden auth, SSRF protection, secrets, and privacy across codebase ([60310fa](https://github.com/crack00r/eidolon/commit/60310fa43aeefa6b5b5310af32d904cad2120f78))


### Miscellaneous

* release main ([030003a](https://github.com/crack00r/eidolon/commit/030003afdfe87c2fcee1a2c79609bf53b091f505))
* release main ([79c0465](https://github.com/crack00r/eidolon/commit/79c04652619f2fbab897a0112f72c7265a353c5d))
* release v0.2.0 -- 20-round comprehensive security audit ([b957408](https://github.com/crack00r/eidolon/commit/b95740890155b6b065aa1ff51d42bb8a7e1b682d))


### Tests

* update tests for audit fixes ([f688ef2](https://github.com/crack00r/eidolon/commit/f688ef2bc3c151aa2bbb34d20def1014447ace63))

## [0.1.14](https://github.com/crack00r/eidolon/compare/v0.1.13...v0.1.14) (2026-03-08)


### Bug Fixes

* **apps:** harden desktop, web, and CLI frontends ([3bbbf96](https://github.com/crack00r/eidolon/commit/3bbbf967d5e0cff74d21efa048a6746affec8a01))
* **cli:** add missing zod dependency for Ollama schema validation ([d3d4c4e](https://github.com/crack00r/eidolon/commit/d3d4c4e3b07878a3f7d3010beaef06126aa6a099))
* comprehensive bugfix across desktop, protocol, core, CLI, and CI ([6615af4](https://github.com/crack00r/eidolon/commit/6615af40d7554acf43b5358138671431f9b15843))
* critical bugfixes for chat, credentials, onboarding, and daemon ([858f4a8](https://github.com/crack00r/eidolon/commit/858f4a87b615b84f41ed0303df9604b064218e3d))


### Miscellaneous

* release main ([5425158](https://github.com/crack00r/eidolon/commit/5425158b66a595b5368e9304e385de917b2334c6))
* release main ([bd7ede4](https://github.com/crack00r/eidolon/commit/bd7ede4f647fe54f5307002bfcea06060219233c))


### Tests

* update tests for audit fixes ([f688ef2](https://github.com/crack00r/eidolon/commit/f688ef2bc3c151aa2bbb34d20def1014447ace63))

## [0.1.13](https://github.com/crack00r/eidolon/compare/v0.1.12...v0.1.13) (2026-03-08)


### Bug Fixes

* comprehensive bugfix across desktop, protocol, core, CLI, and CI ([6615af4](https://github.com/crack00r/eidolon/commit/6615af40d7554acf43b5358138671431f9b15843))
* critical bugfixes for chat, credentials, onboarding, and daemon ([858f4a8](https://github.com/crack00r/eidolon/commit/858f4a87b615b84f41ed0303df9604b064218e3d))


### Miscellaneous

* release main ([08dd818](https://github.com/crack00r/eidolon/commit/08dd81847eae3f72d9710ca97db36d34afb3435f))
* release main ([cdc0c13](https://github.com/crack00r/eidolon/commit/cdc0c13a074be2639e9979371ef030dc99573bab))

## [0.1.12](https://github.com/crack00r/eidolon/compare/v0.1.11...v0.1.12) (2026-03-07)


### Miscellaneous

* release main ([471360c](https://github.com/crack00r/eidolon/commit/471360c4f505751200697a4d9e6937a9adce96df))
* release main ([54e907b](https://github.com/crack00r/eidolon/commit/54e907b0e73a643a74ee76e0799357b4f524cfab))

## [0.1.11](https://github.com/crack00r/eidolon/compare/v0.1.10...v0.1.11) (2026-03-07)


### Features

* **cli:** add daemon logs command ([5bce1ad](https://github.com/crack00r/eidolon/commit/5bce1ad48eb8177527d995c6cd015940c093a534))


### Bug Fixes

* **cli:** pass --config flag to EidolonDaemon in foreground mode ([c9ba26c](https://github.com/crack00r/eidolon/commit/c9ba26c9d7863cc7079bebf2e39195730b8af0b4))
* **core,cli:** resolve all lint errors across codebase ([bf3de05](https://github.com/crack00r/eidolon/commit/bf3de0597bf920da5f568129175726e40531fca7))
* **protocol,cli:** resolve lint errors and update test mocks ([74b018a](https://github.com/crack00r/eidolon/commit/74b018a798859d06309005598660cafe6bf75bff))


### Code Refactoring

* **cli:** delegate onboarding logic to shared core modules ([e1ca7b2](https://github.com/crack00r/eidolon/commit/e1ca7b2b4fc7e3bff74c3b8a1339999af9b993e7))


### Miscellaneous

* release main ([2d597dd](https://github.com/crack00r/eidolon/commit/2d597dd6d378857a2dd0e09e9be5b95d12082eea))
* release main ([5ebae5c](https://github.com/crack00r/eidolon/commit/5ebae5ce643baf3cf5ad60ef0391a3a81d4f23c7))

## [0.1.10](https://github.com/crack00r/eidolon/compare/v0.1.9...v0.1.10) (2026-03-07)


### Features

* **cli:** add daemon logs command ([5bce1ad](https://github.com/crack00r/eidolon/commit/5bce1ad48eb8177527d995c6cd015940c093a534))
* implement v2.1 features -- proactive intelligence, agentic workflows, slack, browser, MCP marketplace, wyoming, multi-user, project management, node replication ([157a7cb](https://github.com/crack00r/eidolon/commit/157a7cb5aae6f7fa6acbb3cf397372c352976adc))


### Bug Fixes

* **cli:** expand privacy-forget.ts formatting for biome compliance ([312ca22](https://github.com/crack00r/eidolon/commit/312ca22f1b8bceab6a01db07fb8c137d19adec11))
* **cli:** pass --config flag to EidolonDaemon in foreground mode ([c9ba26c](https://github.com/crack00r/eidolon/commit/c9ba26c9d7863cc7079bebf2e39195730b8af0b4))
* **core,cli,protocol:** biome lint and formatting fixes across all packages ([52c5d4d](https://github.com/crack00r/eidolon/commit/52c5d4d836a2629d6a28abf78f7db4fd35b60c8e))
* **core,cli:** resolve all lint errors across codebase ([bf3de05](https://github.com/crack00r/eidolon/commit/bf3de0597bf920da5f568129175726e40531fca7))
* **protocol,cli:** resolve lint errors and update test mocks ([74b018a](https://github.com/crack00r/eidolon/commit/74b018a798859d06309005598660cafe6bf75bff))


### Code Refactoring

* **cli:** delegate onboarding logic to shared core modules ([e1ca7b2](https://github.com/crack00r/eidolon/commit/e1ca7b2b4fc7e3bff74c3b8a1339999af9b993e7))


### Miscellaneous

* release main ([20ad0fb](https://github.com/crack00r/eidolon/commit/20ad0fbed8771bb2203b9a492d867a7caa4c4754))
* release main ([2b7c6e1](https://github.com/crack00r/eidolon/commit/2b7c6e19f0901509e87d6bc92ee17ef74717a173))

## [0.1.9](https://github.com/crack00r/eidolon/compare/v0.1.8...v0.1.9) (2026-03-07)


### Features

* implement v2.1 features -- proactive intelligence, agentic workflows, slack, browser, MCP marketplace, wyoming, multi-user, project management, node replication ([157a7cb](https://github.com/crack00r/eidolon/commit/157a7cb5aae6f7fa6acbb3cf397372c352976adc))


### Bug Fixes

* **cli:** expand privacy-forget.ts formatting for biome compliance ([312ca22](https://github.com/crack00r/eidolon/commit/312ca22f1b8bceab6a01db07fb8c137d19adec11))
* **core,cli,protocol:** biome lint and formatting fixes across all packages ([52c5d4d](https://github.com/crack00r/eidolon/commit/52c5d4d836a2629d6a28abf78f7db4fd35b60c8e))


### Miscellaneous

* release main ([7ae0b0b](https://github.com/crack00r/eidolon/commit/7ae0b0b6c2bfe5f643f9191683643b51984fe0ca))
* release main ([41921fc](https://github.com/crack00r/eidolon/commit/41921fcc22711ebeeec9c33c5e2af30f7dd07c96))

## [0.1.8](https://github.com/crack00r/eidolon/compare/v0.1.7...v0.1.8) (2026-03-07)


### Features

* **core:** add security hardening, Memory MCP server, and PWA support ([9fb423d](https://github.com/crack00r/eidolon/commit/9fb423d0ede73744984cb8a2584793ee0345177d))
* **core:** implement sqlite-vec ANN search, npm publish workflow, and doc corrections ([fe4e41c](https://github.com/crack00r/eidolon/commit/fe4e41cee6c4dcfcdb6542a22c0eb6f492b6d16b))
* **core:** implement Wave 1 foundation tasks ([d257d1f](https://github.com/crack00r/eidolon/commit/d257d1f703122e95d09195cc6b6743304dd602fb))
* **core:** implement Wave 2 core wiring and daemon decomposition ([13f5a15](https://github.com/crack00r/eidolon/commit/13f5a1585bc438a8a213b82f7302656beab16d74))
* **core:** implement Wave 3 gateway methods, KG predictions, and learning pipeline ([6bc8054](https://github.com/crack00r/eidolon/commit/6bc805496076df26472ab4f6c12084eb89b9745a))
* **core:** implement Waves 5-9 features, tests, and documentation ([05c2357](https://github.com/crack00r/eidolon/commit/05c235775582c1cdbd972c54f94656ccad12c40d))


### Bug Fixes

* close all completeness gaps from project audit ([446ac5a](https://github.com/crack00r/eidolon/commit/446ac5a9fc663a9a8b520d3f1b82aa72243b2ed9))


### Miscellaneous

* release main ([5a3ee16](https://github.com/crack00r/eidolon/commit/5a3ee16308e3dd13184677b050cf6f2eb8de013e))
* release main ([04d55a0](https://github.com/crack00r/eidolon/commit/04d55a0dc8fa21433ef61bcf730c0bb05f1e22fa))


### Tests

* **core:** add Wave 4 integration tests and Wave 5 code quality improvements ([b7d6e61](https://github.com/crack00r/eidolon/commit/b7d6e61fffe4d003eaf5b6caf4fcd3a1dfd1e2f6))

## [0.1.7](https://github.com/crack00r/eidolon/compare/v0.1.6...v0.1.7) (2026-03-07)


### Features

* **core:** add security hardening, Memory MCP server, and PWA support ([9fb423d](https://github.com/crack00r/eidolon/commit/9fb423d0ede73744984cb8a2584793ee0345177d))
* **core:** implement sqlite-vec ANN search, npm publish workflow, and doc corrections ([fe4e41c](https://github.com/crack00r/eidolon/commit/fe4e41cee6c4dcfcdb6542a22c0eb6f492b6d16b))
* **core:** implement Wave 1 foundation tasks ([d257d1f](https://github.com/crack00r/eidolon/commit/d257d1f703122e95d09195cc6b6743304dd602fb))
* **core:** implement Wave 2 core wiring and daemon decomposition ([13f5a15](https://github.com/crack00r/eidolon/commit/13f5a1585bc438a8a213b82f7302656beab16d74))
* **core:** implement Wave 3 gateway methods, KG predictions, and learning pipeline ([6bc8054](https://github.com/crack00r/eidolon/commit/6bc805496076df26472ab4f6c12084eb89b9745a))
* **core:** implement Waves 5-9 features, tests, and documentation ([05c2357](https://github.com/crack00r/eidolon/commit/05c235775582c1cdbd972c54f94656ccad12c40d))


### Bug Fixes

* close all completeness gaps from project audit ([446ac5a](https://github.com/crack00r/eidolon/commit/446ac5a9fc663a9a8b520d3f1b82aa72243b2ed9))


### Tests

* **core:** add Wave 4 integration tests and Wave 5 code quality improvements ([b7d6e61](https://github.com/crack00r/eidolon/commit/b7d6e61fffe4d003eaf5b6caf4fcd3a1dfd1e2f6))

## [0.1.6](https://github.com/crack00r/eidolon/compare/v0.1.5...v0.1.6) (2026-03-06)


### Features

* **core:** add MCP secret resolution, entity dedup, gateway rate limiting, and client logging ([da0b88a](https://github.com/crack00r/eidolon/commit/da0b88a8a8ddc25749295ce6e038ece21556d6bf))
* **core:** implement Integration Plan Tier 2 (Sprints 4-8) ([60f2436](https://github.com/crack00r/eidolon/commit/60f2436dc16f252f094417c024e8a1ac3ed48202))
* **core:** implement plugin system and local LLM provider support ([3b146f9](https://github.com/crack00r/eidolon/commit/3b146f9aab556f987becb527b2180a7b4c539e50))
* cross-platform daemon, setup guides, client logging, and onboard wizard ([eb69200](https://github.com/crack00r/eidolon/commit/eb69200483e304a909b8ff45e472432c143847e4))
* unified design system, iOS voice mode, Prometheus metrics, and completeness gaps ([b918d13](https://github.com/crack00r/eidolon/commit/b918d133add734583412c7b4800d11bd039890b9))


### Bug Fixes

* **cli:** refactor onboard wizard into modular steps and fix phone-home logging ([9d15914](https://github.com/crack00r/eidolon/commit/9d15914c86aaacf1345ad07a6c70b5989d96a225))
* close completeness gaps G-06/G-08/G-10/G-11/G-14/G-15 ([999f09d](https://github.com/crack00r/eidolon/commit/999f09defac86d21ee0549bab21c2f6d3ed8b6af))
* close final completeness gaps G-01 and G-10 ([3c92e14](https://github.com/crack00r/eidolon/commit/3c92e144b1c9835734c863de4f9a3b7f50fb0951))
* **core:** restore class property declarations removed by Biome unsafe lint ([cd6e3a9](https://github.com/crack00r/eidolon/commit/cd6e3a9429f992c725912818559a15fd06feacac))
* **security:** second-round security audit remediation across audits [#8](https://github.com/crack00r/eidolon/issues/8)-[#12](https://github.com/crack00r/eidolon/issues/12) ([8b939b5](https://github.com/crack00r/eidolon/commit/8b939b54f81be53edf3aa27130341c85f5b8d7aa))


### Documentation

* add completeness audit report and onboard wizard tests ([dd059f1](https://github.com/crack00r/eidolon/commit/dd059f1938bd41a6ebf2a02e59237a77eeab2f48))

## [0.1.5](https://github.com/crack00r/eidolon/compare/v0.1.4...v0.1.5) (2026-03-02)


### Features

* **all:** add integration tests, example config, fix lint, align versions, update roadmap ([8f62577](https://github.com/crack00r/eidolon/commit/8f625772ef8fd70e61b0180952d3276a9f1c0fa9))


### Bug Fixes

* **cli:** complete server/client install on all platforms ([ee11538](https://github.com/crack00r/eidolon/commit/ee115382bb97e8de847ac8ff70b8ec32b698d170))
* **security:** comprehensive security audit remediation across all 8 domains ([504e644](https://github.com/crack00r/eidolon/commit/504e644c518f4df00f6f95f4f546f35b42668fca))
