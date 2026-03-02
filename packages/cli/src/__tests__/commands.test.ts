import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock @eidolon/core BEFORE any command imports (they transitively import it).
// On Linux/CI, Bun's module resolution for re-exported .js → .ts fails when
// the module is first loaded inside mock.module() boundaries. Providing all
// exports here prevents SyntaxError for missing named exports.
// ---------------------------------------------------------------------------

mock.module("@eidolon/core", () => ({
  // config
  loadConfig: async () => ({ ok: true, value: {} }),
  getConfigPath: () => "/tmp/eidolon-test/config.json",
  getConfigDir: () => "/tmp/eidolon-test/config",
  // directories
  getDataDir: () => "/tmp/eidolon-test/data",
  getLogDir: () => "/tmp/eidolon-test/logs",
  // daemon
  getPidFilePath: () => "/tmp/eidolon-test/eidolon.pid",
  EidolonDaemon: class {},
  // secrets
  getMasterKey: () => ({ ok: true, value: Buffer.alloc(32) }),
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
  zeroBuffer: () => {},
  generateMasterKey: () => "0".repeat(64),
  KEY_LENGTH: 32,
  PASSPHRASE_SALT: "eidolon-test-salt",
  SCRYPT_N: 2,
  SCRYPT_R: 8,
  SCRYPT_P: 1,
  SCRYPT_MAXMEM: 128 * 1024 * 1024,
  // logging
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  // database
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
  // chat / claude
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
  // memory
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
}));

// ---------------------------------------------------------------------------
// Import command registrations AFTER mocking
// ---------------------------------------------------------------------------

import { Command } from "commander";
import { registerChannelCommand } from "../commands/channel.ts";
import { registerChatCommand } from "../commands/chat.ts";
import { registerConfigCommand } from "../commands/config.ts";
import { registerDaemonCommand } from "../commands/daemon.ts";
import { registerDoctorCommand } from "../commands/doctor.ts";
import { registerLearningCommand } from "../commands/learning.ts";
import { registerMemoryCommand } from "../commands/memory.ts";
import { registerOnboardCommand } from "../commands/onboard.ts";
import { registerPrivacyCommand } from "../commands/privacy.ts";
import { registerSecretsCommand } from "../commands/secrets.ts";

// ---------------------------------------------------------------------------
// Helper: create a fully-registered program (mirrors src/index.ts)
// ---------------------------------------------------------------------------

function createProgram(): Command {
  const program = new Command();
  program.name("eidolon").description("Autonomous, self-learning personal AI assistant").version("0.0.0");
  program.exitOverride(); // Throw instead of process.exit

  registerDaemonCommand(program);
  registerConfigCommand(program);
  registerSecretsCommand(program);
  registerDoctorCommand(program);
  registerChatCommand(program);
  registerMemoryCommand(program);
  registerLearningCommand(program);
  registerChannelCommand(program);
  registerPrivacyCommand(program);
  registerOnboardCommand(program);

  return program;
}

// ---------------------------------------------------------------------------
// Helper: find a command by name in the program
// ---------------------------------------------------------------------------

function findCommand(program: Command, name: string): Command | undefined {
  return program.commands.find((c) => c.name() === name);
}

function findSubcommand(parent: Command, name: string): Command | undefined {
  return parent.commands.find((c) => c.name() === name);
}

/** Asserting variant -- throws if command is not found (avoids non-null assertions in tests) */
function requireCommand(program: Command, name: string): Command {
  const cmd = findCommand(program, name);
  if (!cmd) throw new Error(`Command "${name}" not found`);
  return cmd;
}

function requireSubcommand(parent: Command, name: string): Command {
  const cmd = findSubcommand(parent, name);
  if (!cmd) throw new Error(`Subcommand "${name}" not found`);
  return cmd;
}

// ---------------------------------------------------------------------------
// Top-level command registration
// ---------------------------------------------------------------------------

describe("CLI command registration", () => {
  const program = createProgram();

  test("program has correct name and description", () => {
    expect(program.name()).toBe("eidolon");
    expect(program.description()).toContain("AI assistant");
  });

  test("all 10 top-level commands are registered", () => {
    const commandNames = program.commands.map((c) => c.name());
    const expected = [
      "daemon",
      "config",
      "secrets",
      "doctor",
      "chat",
      "memory",
      "learning",
      "channel",
      "privacy",
      "onboard",
    ];

    for (const name of expected) {
      expect(commandNames).toContain(name);
    }
    expect(program.commands.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// daemon subcommands
// ---------------------------------------------------------------------------

describe("daemon command", () => {
  const program = createProgram();
  const daemon = requireCommand(program, "daemon");

  test("daemon command exists with description", () => {
    expect(daemon).toBeDefined();
    expect(daemon.description()).toContain("daemon");
  });

  test("has start, stop, and status subcommands", () => {
    const subNames = daemon.commands.map((c) => c.name());
    expect(subNames).toContain("start");
    expect(subNames).toContain("stop");
    expect(subNames).toContain("status");
    expect(subNames).toHaveLength(3);
  });

  test("start has --foreground and --config options", () => {
    const start = requireSubcommand(daemon, "start");
    expect(start).toBeDefined();

    const opts = start.options.map((o) => o.long);
    expect(opts).toContain("--foreground");
    expect(opts).toContain("--config");
  });

  test("stop has --timeout option", () => {
    const stop = requireSubcommand(daemon, "stop");
    expect(stop).toBeDefined();

    const opts = stop.options.map((o) => o.long);
    expect(opts).toContain("--timeout");
  });

  test("status has no extra options", () => {
    const status = requireSubcommand(daemon, "status");
    expect(status).toBeDefined();
    expect(status.options).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// config subcommands
// ---------------------------------------------------------------------------

describe("config command", () => {
  const program = createProgram();
  const config = requireCommand(program, "config");

  test("has show and validate subcommands", () => {
    const subNames = config.commands.map((c) => c.name());
    expect(subNames).toContain("show");
    expect(subNames).toContain("validate");
    expect(subNames).toHaveLength(2);
  });

  test("show has --path option", () => {
    const show = requireSubcommand(config, "show");
    const opts = show.options.map((o) => o.long);
    expect(opts).toContain("--path");
  });

  test("validate has --path option", () => {
    const validate = requireSubcommand(config, "validate");
    const opts = validate.options.map((o) => o.long);
    expect(opts).toContain("--path");
  });
});

// ---------------------------------------------------------------------------
// secrets subcommands
// ---------------------------------------------------------------------------

describe("secrets command", () => {
  const program = createProgram();
  const secrets = requireCommand(program, "secrets");

  test("has set, get, list, delete subcommands", () => {
    const subNames = secrets.commands.map((c) => c.name());
    expect(subNames).toContain("set");
    expect(subNames).toContain("get");
    expect(subNames).toContain("list");
    expect(subNames).toContain("delete");
    expect(subNames).toHaveLength(4);
  });

  test("set requires a <key> argument", () => {
    const set = requireSubcommand(secrets, "set");
    // Commander stores "set <key>" as the command name
    expect(set).toBeDefined();
  });

  test("set has --value (required) and --description options", () => {
    const set = requireSubcommand(secrets, "set");
    const opts = set.options.map((o) => o.long);
    expect(opts).toContain("--value");
    expect(opts).toContain("--description");
    // --value is required
    const valueOpt = set.options.find((o) => o.long === "--value");
    expect(valueOpt).toBeDefined();
    expect(valueOpt?.required).toBe(true);
  });

  test("get has --reveal option", () => {
    const get = requireSubcommand(secrets, "get");
    const opts = get.options.map((o) => o.long);
    expect(opts).toContain("--reveal");
  });

  test("delete requires a <key> argument", () => {
    const del = requireSubcommand(secrets, "delete");
    expect(del).toBeDefined();
  });

  test("list has no required options", () => {
    const list = requireSubcommand(secrets, "list");
    expect(list.options).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// doctor command
// ---------------------------------------------------------------------------

describe("doctor command", () => {
  const program = createProgram();
  const doctor = requireCommand(program, "doctor");

  test("doctor exists with description", () => {
    expect(doctor).toBeDefined();
    expect(doctor.description()).toContain("diagnostics");
  });

  test("doctor has no subcommands (flat command)", () => {
    expect(doctor.commands).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// chat command
// ---------------------------------------------------------------------------

describe("chat command", () => {
  const program = createProgram();
  const chat = requireCommand(program, "chat");

  test("has -m/--message, --model, and --session options", () => {
    const opts = chat.options.map((o) => o.long);
    expect(opts).toContain("--message");
    expect(opts).toContain("--model");
    expect(opts).toContain("--session");
  });

  test("--message has -m short flag", () => {
    const msgOpt = chat.options.find((o) => o.long === "--message");
    expect(msgOpt).toBeDefined();
    expect(msgOpt?.short).toBe("-m");
  });
});

// ---------------------------------------------------------------------------
// memory subcommands
// ---------------------------------------------------------------------------

describe("memory command", () => {
  const program = createProgram();
  const memory = requireCommand(program, "memory");

  test("has search, list, add, delete, stats, dream, and index subcommands", () => {
    const subNames = memory.commands.map((c) => c.name());
    expect(subNames).toContain("search");
    expect(subNames).toContain("list");
    expect(subNames).toContain("add");
    expect(subNames).toContain("delete");
    expect(subNames).toContain("stats");
    expect(subNames).toContain("dream");
    expect(subNames).toContain("index");
    expect(subNames).toHaveLength(7);
  });

  test("search has --type and --limit options", () => {
    const search = requireSubcommand(memory, "search");
    const opts = search.options.map((o) => o.long);
    expect(opts).toContain("--type");
    expect(opts).toContain("--limit");
  });

  test("list has --type, --layer, and --limit options", () => {
    const list = requireSubcommand(memory, "list");
    const opts = list.options.map((o) => o.long);
    expect(opts).toContain("--type");
    expect(opts).toContain("--layer");
    expect(opts).toContain("--limit");
  });

  test("add has --type, --confidence, and --tags options", () => {
    const add = requireSubcommand(memory, "add");
    const opts = add.options.map((o) => o.long);
    expect(opts).toContain("--type");
    expect(opts).toContain("--confidence");
    expect(opts).toContain("--tags");
  });

  test("dream has --phase option", () => {
    const dream = requireSubcommand(memory, "dream");
    const opts = dream.options.map((o) => o.long);
    expect(opts).toContain("--phase");
  });
});

// ---------------------------------------------------------------------------
// privacy subcommands
// ---------------------------------------------------------------------------

describe("privacy command", () => {
  const program = createProgram();
  const privacy = requireCommand(program, "privacy");

  test("has forget and export subcommands", () => {
    const subNames = privacy.commands.map((c) => c.name());
    expect(subNames).toContain("forget");
    expect(subNames).toContain("export");
    expect(subNames).toHaveLength(2);
  });

  test("export has --output option", () => {
    const exp = requireSubcommand(privacy, "export");
    const opts = exp.options.map((o) => o.long);
    expect(opts).toContain("--output");
  });
});

// ---------------------------------------------------------------------------
// stub commands
// ---------------------------------------------------------------------------

describe("stub commands", () => {
  const program = createProgram();

  test("learning command exists", () => {
    expect(findCommand(program, "learning")).toBeDefined();
  });

  test("channel command exists", () => {
    expect(findCommand(program, "channel")).toBeDefined();
  });

  test("onboard command exists", () => {
    expect(findCommand(program, "onboard")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// parseAsync argument parsing (without executing actions)
// ---------------------------------------------------------------------------

describe("argument parsing", () => {
  // For parse tests, we override actions to capture parsed args without
  // executing the real logic (which requires databases, etc.)

  test("daemon start parses --foreground flag", async () => {
    const program = new Command();
    program.exitOverride();
    let capturedOpts: Record<string, unknown> | undefined;

    const daemon = program.command("daemon");
    daemon
      .command("start")
      .option("--foreground", "Run in foreground", false)
      .option("--config <path>", "Config file path")
      .action((opts) => {
        capturedOpts = opts;
      });

    await program.parseAsync(["daemon", "start", "--foreground"], { from: "user" });
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts?.foreground).toBe(true);
  });

  test("daemon start --config parses path", async () => {
    const program = new Command();
    program.exitOverride();
    let capturedOpts: Record<string, unknown> | undefined;

    const daemon = program.command("daemon");
    daemon
      .command("start")
      .option("--foreground", "Run in foreground", false)
      .option("--config <path>", "Config file path")
      .action((opts) => {
        capturedOpts = opts;
      });

    await program.parseAsync(["daemon", "start", "--config", "/etc/eidolon.json"], { from: "user" });
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts?.config).toBe("/etc/eidolon.json");
    expect(capturedOpts?.foreground).toBe(false);
  });

  test("daemon stop parses --timeout", async () => {
    const program = new Command();
    program.exitOverride();
    let capturedOpts: Record<string, unknown> | undefined;

    const daemon = program.command("daemon");
    daemon
      .command("stop")
      .option("--timeout <ms>", "Timeout", "15000")
      .action((opts) => {
        capturedOpts = opts;
      });

    await program.parseAsync(["daemon", "stop", "--timeout", "5000"], { from: "user" });
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts?.timeout).toBe("5000");
  });

  test("secrets set parses key argument and --value", async () => {
    const program = new Command();
    program.exitOverride();
    let capturedKey: string | undefined;
    let capturedOpts: Record<string, unknown> | undefined;

    const secrets = program.command("secrets");
    secrets
      .command("set <key>")
      .requiredOption("--value <value>", "Secret value")
      .option("-d, --description <desc>", "Description")
      .action((key: string, opts: Record<string, unknown>) => {
        capturedKey = key;
        capturedOpts = opts;
      });

    await program.parseAsync(["secrets", "set", "my-api-key", "--value", "sk-12345"], { from: "user" });
    expect(capturedKey).toBe("my-api-key");
    expect(capturedOpts?.value).toBe("sk-12345");
  });

  test("secrets set with --description", async () => {
    const program = new Command();
    program.exitOverride();
    let capturedOpts: Record<string, unknown> | undefined;

    const secrets = program.command("secrets");
    secrets
      .command("set <key>")
      .requiredOption("--value <value>", "Secret value")
      .option("-d, --description <desc>", "Description")
      .action((_key: string, opts: Record<string, unknown>) => {
        capturedOpts = opts;
      });

    await program.parseAsync(["secrets", "set", "token", "--value", "abc", "--description", "API token"], {
      from: "user",
    });
    expect(capturedOpts?.description).toBe("API token");
  });

  test("secrets get parses key and --reveal flag", async () => {
    const program = new Command();
    program.exitOverride();
    let capturedKey: string | undefined;
    let capturedOpts: Record<string, unknown> | undefined;

    const secrets = program.command("secrets");
    secrets
      .command("get <key>")
      .option("--reveal", "Show value")
      .action((key: string, opts: Record<string, unknown>) => {
        capturedKey = key;
        capturedOpts = opts;
      });

    await program.parseAsync(["secrets", "get", "my-key", "--reveal"], { from: "user" });
    expect(capturedKey).toBe("my-key");
    expect(capturedOpts?.reveal).toBe(true);
  });

  test("memory search parses query and --type/--limit", async () => {
    const program = new Command();
    program.exitOverride();
    let capturedQuery: string | undefined;
    let capturedOpts: Record<string, unknown> | undefined;

    const memory = program.command("memory");
    memory
      .command("search <query>")
      .option("--type <type>", "Filter by type")
      .option("--limit <n>", "Max results", "10")
      .action((query: string, opts: Record<string, unknown>) => {
        capturedQuery = query;
        capturedOpts = opts;
      });

    await program.parseAsync(["memory", "search", "favorite food", "--type", "fact", "--limit", "5"], {
      from: "user",
    });
    expect(capturedQuery).toBe("favorite food");
    expect(capturedOpts?.type).toBe("fact");
    expect(capturedOpts?.limit).toBe("5");
  });

  test("memory add parses content and options", async () => {
    const program = new Command();
    program.exitOverride();
    let capturedContent: string | undefined;
    let capturedOpts: Record<string, unknown> | undefined;

    const memory = program.command("memory");
    memory
      .command("add <content>")
      .option("--type <type>", "Memory type", "fact")
      .option("--confidence <n>", "Confidence", "0.9")
      .option("--tags <tags>", "Tags")
      .action((content: string, opts: Record<string, unknown>) => {
        capturedContent = content;
        capturedOpts = opts;
      });

    await program.parseAsync(
      ["memory", "add", "User likes coffee", "--type", "preference", "--confidence", "0.85", "--tags", "food,drink"],
      { from: "user" },
    );
    expect(capturedContent).toBe("User likes coffee");
    expect(capturedOpts?.type).toBe("preference");
    expect(capturedOpts?.confidence).toBe("0.85");
    expect(capturedOpts?.tags).toBe("food,drink");
  });

  test("chat -m parses message option", async () => {
    const program = new Command();
    program.exitOverride();
    let capturedOpts: Record<string, unknown> | undefined;

    program
      .command("chat")
      .option("-m, --message <text>", "Single message")
      .option("--model <model>", "Model")
      .option("--session <id>", "Session")
      .action((opts: Record<string, unknown>) => {
        capturedOpts = opts;
      });

    await program.parseAsync(["chat", "-m", "Hello, how are you?"], { from: "user" });
    expect(capturedOpts?.message).toBe("Hello, how are you?");
  });

  test("privacy forget parses entity argument", async () => {
    const program = new Command();
    program.exitOverride();
    let capturedEntity: string | undefined;

    const privacy = program.command("privacy");
    privacy.command("forget <entity>").action((entity: string) => {
      capturedEntity = entity;
    });

    await program.parseAsync(["privacy", "forget", "John Doe"], { from: "user" });
    expect(capturedEntity).toBe("John Doe");
  });

  test("privacy export parses --output option", async () => {
    const program = new Command();
    program.exitOverride();
    let capturedOpts: Record<string, unknown> | undefined;

    const privacy = program.command("privacy");
    privacy
      .command("export")
      .option("--output <path>", "Output path")
      .action((opts: Record<string, unknown>) => {
        capturedOpts = opts;
      });

    await program.parseAsync(["privacy", "export", "--output", "/tmp/export.json"], { from: "user" });
    expect(capturedOpts?.output).toBe("/tmp/export.json");
  });

  test("memory dream --phase parses phase option", async () => {
    const program = new Command();
    program.exitOverride();
    let capturedOpts: Record<string, unknown> | undefined;

    const memory = program.command("memory");
    memory
      .command("dream")
      .option("--phase <phase>", "Run specific phase")
      .action((opts: Record<string, unknown>) => {
        capturedOpts = opts;
      });

    await program.parseAsync(["memory", "dream", "--phase", "rem"], { from: "user" });
    expect(capturedOpts?.phase).toBe("rem");
  });
});
