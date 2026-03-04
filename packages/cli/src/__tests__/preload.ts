/**
 * Bun test preload — global mock for @eidolon/core.
 *
 * On Linux/CI, Bun cannot resolve the .js → .ts re-exports in @eidolon/core's
 * barrel index when the module is first loaded between test files. File-scoped
 * mock.module() calls do not persist across files, so the SECOND test file to
 * load will attempt real resolution and crash.
 *
 * This preload is registered in bunfig.toml [test].preload and runs once before
 * ALL test files, ensuring @eidolon/core is mocked globally. Individual test
 * files can still call mock.module("@eidolon/core", ...) to override with
 * test-specific behavior.
 */

import { mock } from "bun:test";

mock.module("@eidolon/core", () => ({
  // ── Config ──────────────────────────────────────────────────────────────
  loadConfig: async () => ({ ok: true, value: {} }),
  getConfigPath: () => "/tmp/eidolon-test/config.json",
  getConfigDir: () => "/tmp/eidolon-test/config",
  validateAndResolve: () => ({ ok: true, value: {} }),
  validateConfig: () => ({ ok: true, value: {} }),

  // ── Directories ─────────────────────────────────────────────────────────
  getDataDir: () => "/tmp/eidolon-test/data",
  getLogDir: () => "/tmp/eidolon-test/logs",

  // ── Daemon ──────────────────────────────────────────────────────────────
  getPidFilePath: () => "/tmp/eidolon-test/eidolon.pid",
  EidolonDaemon: class {
    static create() {
      return { ok: true, value: {} };
    }
    async start() {}
  },

  // ── Secrets / Crypto ────────────────────────────────────────────────────
  getMasterKey: () => ({ ok: true, value: Buffer.alloc(32) }),
  generateMasterKey: () => "0".repeat(64),
  zeroBuffer: () => {},
  SecretStore: class {
    set() {
      return { ok: true };
    }
    get() {
      return { ok: true, value: "" };
    }
    delete() {
      return { ok: true };
    }
    list() {
      return { ok: true, value: [] };
    }
    close() {}
  },
  KEY_LENGTH: 32,
  PASSPHRASE_SALT: "eidolon-test-salt",
  SCRYPT_N: 2,
  SCRYPT_R: 8,
  SCRYPT_P: 1,
  SCRYPT_MAXMEM: 128 * 1024 * 1024,

  // ── Logging ─────────────────────────────────────────────────────────────
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),

  // ── Database ────────────────────────────────────────────────────────────
  DatabaseManager: class {
    initialize() {
      return { ok: true };
    }
    close() {}
    get memory() {
      return {};
    }
    get operational() {
      return {};
    }
    get audit() {
      return {};
    }
  },

  // ── Discovery / Pairing ──────────────────────────────────────────────────
  DISCOVERY_PORT: 41920,
  generateAuthToken: () => "test-token-0000000000000000000000000000",
  DiscoveryBroadcaster: class {},
  DiscoveryListener: class {},
  TailscaleDetector: class {},
  buildPairingUrl: () => "eidolon://localhost:8419?token=test",
  formatConnectionDetails: () => "",

  // ── Chat / Claude ───────────────────────────────────────────────────────
  ClaudeCodeManager: class {
    async isAvailable() {
      return false;
    }
  },
  AccountRotation: class {
    selectAccount() {
      return { ok: false, error: { message: "mock" } };
    }
  },
  SessionManager: class {
    create() {
      return { ok: false, error: { message: "mock" } };
    }
    updateStatus() {}
  },
  WorkspacePreparer: class {
    async prepare() {
      return { ok: false, error: { message: "mock" } };
    }
    cleanup() {}
  },
  generateMcpConfig: async () => ({ ok: false }),

  // ── Privacy / Consent ────────────────────────────────────────────────────
  ConsentManager: class {
    checkConsentStatus() {
      return false;
    }
    getConsentStatus() {
      return { ok: true, value: null };
    }
    grantConsent() {
      return { ok: true };
    }
    revokeConsent() {
      return { ok: true };
    }
  },
  RetentionEnforcer: class {
    enforce() {
      return { ok: true, value: { timestamp: 0, deletedCounts: {}, totalDeleted: 0, errors: [] } };
    }
  },

  // ── Backup ──────────────────────────────────────────────────────────────
  BackupManager: class {
    runBackup() {
      return { ok: true, value: "2025-01-01_00-00-00" };
    }
    listBackups() {
      return { ok: true, value: [] };
    }
    pruneOldBackups() {
      return { ok: true, value: 0 };
    }
    deleteAllBackups() {
      return { ok: true, value: 0 };
    }
  },

  // ── Memory ──────────────────────────────────────────────────────────────
  MemoryStore: class {
    searchText() {
      return { ok: true, value: [] };
    }
    list() {
      return { ok: true, value: [] };
    }
    create() {
      return { ok: false, error: { message: "mock" } };
    }
    delete() {
      return { ok: false, error: { message: "mock" } };
    }
    count() {
      return { ok: true, value: 0 };
    }
  },
  MemorySearch: class {},
  EmbeddingModel: class {},
  GraphMemory: class {},
  DocumentIndexer: class {
    indexDirectory() {
      return { ok: false, error: { message: "mock" } };
    }
    indexFile() {
      return { ok: false, error: { message: "mock" } };
    }
  },
  DreamRunner: class {
    async runPhase() {
      return { ok: false, error: { message: "mock" } };
    }
    async runAll() {
      return { ok: false, error: { message: "mock" } };
    }
  },
  HousekeepingPhase: class {},
  RemPhase: class {},
  NremPhase: class {},

  // ── Learning ──────────────────────────────────────────────────────────────
  DiscoveryEngine: class {
    getStats() {
      return { ok: true, value: { total: 0, byStatus: {} } };
    }
    countToday() {
      return { ok: true, value: 0 };
    }
    listByStatus() {
      return { ok: true, value: [] };
    }
    get() {
      return { ok: true, value: null };
    }
    updateStatus() {
      return { ok: true };
    }
  },
  LearningJournal: class {
    get count() {
      return 0;
    }
    getRecent() {
      return [];
    }
    getByType() {
      return [];
    }
    dispose() {}
  },
}));
