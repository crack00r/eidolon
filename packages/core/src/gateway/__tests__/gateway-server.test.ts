/**
 * Tests for the Gateway builtin RPC handlers registered via registerBuiltinHandlers().
 *
 * These tests invoke each handler directly through a captured handler map,
 * verifying parameter validation (Zod), return shapes, EventBus interactions,
 * and deps callback usage.
 *
 * Existing gateway.test.ts already covers: protocol parsing, helper functions,
 * WebSocket lifecycle, auth flows, connection limits, message size, and
 * method routing at the server level. This file focuses on the handler logic.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { GatewayMethod } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { BuiltinHandlerDeps } from "../builtin-handlers.ts";
import { registerBuiltinHandlers } from "../builtin-handlers.ts";
import { RpcValidationError } from "../rpc-schemas.ts";
import type { ClientState, MethodHandler } from "../server-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

interface PublishedEvent {
  type: string;
  payload: unknown;
  options?: Record<string, unknown>;
}

function createMockEventBus(): { publish: (...args: unknown[]) => void; events: PublishedEvent[] } {
  const events: PublishedEvent[] = [];
  return {
    events,
    publish(type: unknown, payload: unknown, options?: unknown) {
      events.push({ type: type as string, payload, options: options as Record<string, unknown> });
    },
  };
}

function createMockClient(id: string, authenticated = true): ClientState {
  return {
    id,
    ip: "127.0.0.1",
    ws: {
      data: { clientId: id, ip: "127.0.0.1" },
      send: () => 0,
      close: () => {},
    },
    authenticated,
    platform: "test",
    version: "1.0.0",
    connectedAt: Date.now(),
    messageCount: 0,
    messageWindowStart: Date.now(),
  };
}

interface TestContext {
  handlers: Map<string, MethodHandler>;
  eventBus: ReturnType<typeof createMockEventBus>;
  subscriberIds: string[];
  pushEvents: Array<{ type: string; data: Record<string, unknown> }>;
  clients: Map<string, ClientState>;
  sentMessages: Array<{ clientId: string; data: string }>;
}

function setupHandlers(overrides?: Partial<BuiltinHandlerDeps>): TestContext {
  const handlers = new Map<string, MethodHandler>();
  const eventBus = createMockEventBus();
  const subscriberIds: string[] = [];
  const pushEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const clients = new Map<string, ClientState>();
  const sentMessages: Array<{ clientId: string; data: string }> = [];

  const deps: BuiltinHandlerDeps = {
    logger: createSilentLogger(),
    eventBus: eventBus as unknown as BuiltinHandlerDeps["eventBus"],
    rateLimitTracker: undefined,
    calendarManager: undefined,
    registerHandler: (method: GatewayMethod, handler: MethodHandler) => {
      handlers.set(method, handler);
    },
    getClient: (id: string) => clients.get(id),
    getClients: () => clients.values(),
    getClientCount: () => clients.size,
    isSubscribed: (id: string) => subscriberIds.includes(id),
    addSubscriber: (id: string) => {
      subscriberIds.push(id);
    },
    pushToSubscribers: (type, data) => {
      pushEvents.push({ type, data });
    },
    sendToClient: (clientId: string, data: string) => {
      const client = clients.get(clientId);
      if (!client) return false;
      sentMessages.push({ clientId, data });
      return true;
    },
    isRunning: () => true,
    getStartTime: () => Date.now() - 60_000,
    ...overrides,
  };

  registerBuiltinHandlers(deps);
  return { handlers, eventBus, subscriberIds, pushEvents, clients, sentMessages };
}

function invoke(ctx: TestContext, method: string, params: Record<string, unknown>, clientId = "client-1"): Promise<unknown> {
  const handler = ctx.handlers.get(method);
  if (!handler) throw new Error(`Handler not registered for ${method}`);
  return handler(params, clientId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerBuiltinHandlers", () => {
  test("registers expected handler methods", () => {
    const ctx = setupHandlers();
    const expectedMethods = [
      "error.report",
      "client.reportErrors",
      "system.status",
      "system.subscribe",
      "brain.pause",
      "brain.resume",
      "brain.triggerAction",
      "brain.getLog",
      "client.list",
      "client.execute",
      "command.result",
      "research.start",
      "research.status",
      "research.list",
      "profile.get",
      "metrics.rateLimits",
      "approval.list",
      "approval.respond",
      "automation.list",
      "automation.create",
      "automation.delete",
      "system.health",
    ];
    for (const method of expectedMethods) {
      expect(ctx.handlers.has(method)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// error.report / client.reportErrors
// ---------------------------------------------------------------------------

describe("error.report", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = setupHandlers();
  });

  test("accepts valid error report and returns count", async () => {
    const result = await invoke(ctx, "error.report", {
      errors: [
        { module: "ui", message: "crash", level: "error" },
        { module: "net", message: "timeout" },
      ],
    });
    expect(result).toEqual({ received: 2 });
  });

  test("publishes event to EventBus", async () => {
    await invoke(ctx, "error.report", {
      errors: [{ message: "oops" }],
      clientInfo: { platform: "desktop", version: "2.0" },
    });
    expect(ctx.eventBus.events).toHaveLength(1);
    expect(ctx.eventBus.events[0]!.type).toBe("gateway:client_error_report");
    const payload = ctx.eventBus.events[0]!.payload as Record<string, unknown>;
    expect(payload.platform).toBe("desktop");
    expect(payload.version).toBe("2.0");
    expect(payload.errorCount).toBe(1);
  });

  test("uses client state for platform/version when clientInfo missing", async () => {
    ctx.clients.set("c1", createMockClient("c1"));
    await invoke(ctx, "error.report", { errors: [{ message: "x" }] }, "c1");
    const payload = ctx.eventBus.events[0]!.payload as Record<string, unknown>;
    expect(payload.platform).toBe("test");
    expect(payload.version).toBe("1.0.0");
  });

  test("client.reportErrors is an alias for error.report", async () => {
    const result = await invoke(ctx, "client.reportErrors", {
      errors: [{ message: "alias" }],
    });
    expect(result).toEqual({ received: 1 });
  });

  test("rejects invalid params", async () => {
    try {
      await invoke(ctx, "error.report", { errors: "not-an-array" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });

  test("rejects missing errors field", async () => {
    try {
      await invoke(ctx, "error.report", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });
});

// ---------------------------------------------------------------------------
// system.status
// ---------------------------------------------------------------------------

describe("system.status", () => {
  test("returns running state with uptime and client count", async () => {
    const ctx = setupHandlers();
    ctx.clients.set("a", createMockClient("a"));
    ctx.clients.set("b", createMockClient("b"));
    const result = (await invoke(ctx, "system.status", {})) as Record<string, unknown>;
    expect(result.state).toBe("running");
    expect(result.connectedClients).toBe(2);
    expect(typeof result.uptime).toBe("number");
    expect((result.uptime as number) > 0).toBe(true);
  });

  test("returns zero uptime when not running", async () => {
    const ctx = setupHandlers({ isRunning: () => false });
    const result = (await invoke(ctx, "system.status", {})) as Record<string, unknown>;
    expect(result.uptime).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// system.subscribe
// ---------------------------------------------------------------------------

describe("system.subscribe", () => {
  test("adds client to subscribers", async () => {
    const ctx = setupHandlers();
    const result = await invoke(ctx, "system.subscribe", {}, "sub-client");
    expect(result).toEqual({ subscribed: true });
    expect(ctx.subscriberIds).toContain("sub-client");
  });
});

// ---------------------------------------------------------------------------
// brain.pause / brain.resume
// ---------------------------------------------------------------------------

describe("brain.pause", () => {
  test("publishes pause event and pushes state change", async () => {
    const ctx = setupHandlers();
    const result = await invoke(ctx, "brain.pause", {}, "admin");
    expect(result).toEqual({ paused: true });
    expect(ctx.eventBus.events).toHaveLength(1);
    expect(ctx.eventBus.events[0]!.type).toBe("system:config_changed");
    const payload = ctx.eventBus.events[0]!.payload as Record<string, unknown>;
    expect(payload.action).toBe("pause");
    expect(payload.requestedBy).toBe("admin");
    expect(ctx.pushEvents).toHaveLength(1);
    expect(ctx.pushEvents[0]!.type).toBe("push.stateChange");
    expect(ctx.pushEvents[0]!.data.currentState).toBe("paused");
  });
});

describe("brain.resume", () => {
  test("publishes resume event and pushes state change", async () => {
    const ctx = setupHandlers();
    const result = await invoke(ctx, "brain.resume", {}, "admin");
    expect(result).toEqual({ resumed: true });
    expect(ctx.eventBus.events[0]!.type).toBe("system:config_changed");
    const payload = ctx.eventBus.events[0]!.payload as Record<string, unknown>;
    expect(payload.action).toBe("resume");
    expect(ctx.pushEvents[0]!.data.currentState).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// brain.triggerAction
// ---------------------------------------------------------------------------

describe("brain.triggerAction", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = setupHandlers();
  });

  test("triggers allowed action 'dream'", async () => {
    const result = (await invoke(ctx, "brain.triggerAction", { action: "dream" })) as Record<string, unknown>;
    expect(result.triggered).toBe(true);
    expect(result.action).toBe("dream");
    expect(ctx.eventBus.events).toHaveLength(1);
    const payload = ctx.eventBus.events[0]!.payload as Record<string, unknown>;
    expect(payload.triggerAction).toBe("dream");
  });

  test("triggers allowed action 'learn'", async () => {
    const result = (await invoke(ctx, "brain.triggerAction", { action: "learn" })) as Record<string, unknown>;
    expect(result.action).toBe("learn");
  });

  test("triggers allowed action 'health_check'", async () => {
    const result = (await invoke(ctx, "brain.triggerAction", { action: "health_check" })) as Record<string, unknown>;
    expect(result.action).toBe("health_check");
  });

  test("triggers allowed action 'consolidate'", async () => {
    const result = (await invoke(ctx, "brain.triggerAction", { action: "consolidate" })) as Record<string, unknown>;
    expect(result.action).toBe("consolidate");
  });

  test("triggers allowed action 'check_telegram'", async () => {
    const result = (await invoke(ctx, "brain.triggerAction", { action: "check_telegram" })) as Record<string, unknown>;
    expect(result.action).toBe("check_telegram");
  });

  test("passes args through to event payload", async () => {
    await invoke(ctx, "brain.triggerAction", { action: "dream", args: { depth: 3 } });
    const payload = ctx.eventBus.events[0]!.payload as Record<string, unknown>;
    expect(payload.args).toEqual({ depth: 3 });
  });

  test("rejects unknown action", async () => {
    try {
      await invoke(ctx, "brain.triggerAction", { action: "reboot_server" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
      expect((err as Error).message).toContain("Unknown action");
    }
  });

  test("rejects missing action param", async () => {
    try {
      await invoke(ctx, "brain.triggerAction", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });

  test("rejects empty action string", async () => {
    try {
      await invoke(ctx, "brain.triggerAction", { action: "" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });
});

// ---------------------------------------------------------------------------
// brain.getLog
// ---------------------------------------------------------------------------

describe("brain.getLog", () => {
  test("returns stub entries with default limit", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "brain.getLog", {})) as Record<string, unknown>;
    expect(result.entries).toEqual([]);
    expect(result.limit).toBe(50);
  });

  test("respects custom limit", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "brain.getLog", { limit: 10 })) as Record<string, unknown>;
    expect(result.limit).toBe(10);
  });

  test("rejects invalid limit (too high)", async () => {
    const ctx = setupHandlers();
    try {
      await invoke(ctx, "brain.getLog", { limit: 999 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });

  test("rejects non-integer limit", async () => {
    const ctx = setupHandlers();
    try {
      await invoke(ctx, "brain.getLog", { limit: 10.5 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });
});

// ---------------------------------------------------------------------------
// client.list
// ---------------------------------------------------------------------------

describe("client.list", () => {
  test("returns only authenticated clients", async () => {
    const ctx = setupHandlers();
    ctx.clients.set("auth1", createMockClient("auth1", true));
    ctx.clients.set("unauth", createMockClient("unauth", false));
    ctx.clients.set("auth2", createMockClient("auth2", true));

    const result = (await invoke(ctx, "client.list", {})) as { clients: Array<Record<string, unknown>> };
    expect(result.clients).toHaveLength(2);
    const ids = result.clients.map((c) => c.id);
    expect(ids).toContain("auth1");
    expect(ids).toContain("auth2");
    expect(ids).not.toContain("unauth");
  });

  test("returns empty when no clients", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "client.list", {})) as { clients: unknown[] };
    expect(result.clients).toHaveLength(0);
  });

  test("includes subscription status", async () => {
    const ctx = setupHandlers();
    ctx.clients.set("sub", createMockClient("sub"));
    ctx.subscriberIds.push("sub");
    const result = (await invoke(ctx, "client.list", {})) as { clients: Array<Record<string, unknown>> };
    expect(result.clients[0]!.subscribed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// client.execute
// ---------------------------------------------------------------------------

describe("client.execute", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = setupHandlers();
    ctx.clients.set("sender", createMockClient("sender"));
    ctx.clients.set("target", createMockClient("target"));
  });

  test("sends command to target client and returns commandId", async () => {
    const result = (await invoke(ctx, "client.execute", {
      targetClientId: "target",
      command: "screenshot",
    }, "sender")) as Record<string, unknown>;

    expect(result.sent).toBe(true);
    expect(typeof result.commandId).toBe("string");
    expect(result.targetClientId).toBe("target");
    expect(ctx.sentMessages).toHaveLength(1);
    expect(ctx.sentMessages[0]!.clientId).toBe("target");
  });

  test("passes args to target", async () => {
    await invoke(ctx, "client.execute", {
      targetClientId: "target",
      command: "run",
      args: { cmd: "ls" },
    }, "sender");

    const pushed = JSON.parse(ctx.sentMessages[0]!.data);
    expect(pushed.params.command).toBe("run");
    expect(pushed.params.args).toEqual({ cmd: "ls" });
  });

  test("rejects self-targeting", async () => {
    try {
      await invoke(ctx, "client.execute", {
        targetClientId: "sender",
        command: "test",
      }, "sender");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
      expect((err as Error).message).toContain("self");
    }
  });

  test("rejects when sender is not authenticated", async () => {
    ctx.clients.set("unauth-sender", createMockClient("unauth-sender", false));
    try {
      await invoke(ctx, "client.execute", {
        targetClientId: "target",
        command: "test",
      }, "unauth-sender");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
      expect((err as Error).message).toContain("Unauthorized");
    }
  });

  test("rejects when target is not found", async () => {
    try {
      await invoke(ctx, "client.execute", {
        targetClientId: "nonexistent",
        command: "test",
      }, "sender");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
      expect((err as Error).message).toContain("not found");
    }
  });

  test("rejects when target is not authenticated", async () => {
    ctx.clients.set("unauth-target", createMockClient("unauth-target", false));
    try {
      await invoke(ctx, "client.execute", {
        targetClientId: "unauth-target",
        command: "test",
      }, "sender");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
      expect((err as Error).message).toContain("not authenticated");
    }
  });

  test("rejects missing command param", async () => {
    try {
      await invoke(ctx, "client.execute", { targetClientId: "target" }, "sender");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });

  test("reports failure when sendToClient returns false", async () => {
    const failCtx = setupHandlers({
      sendToClient: () => false,
    });
    failCtx.clients.set("sender", createMockClient("sender"));
    failCtx.clients.set("target", createMockClient("target"));

    try {
      await invoke(failCtx, "client.execute", {
        targetClientId: "target",
        command: "test",
      }, "sender");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
      expect((err as Error).message).toContain("Failed to send");
    }
  });
});

// ---------------------------------------------------------------------------
// command.result
// ---------------------------------------------------------------------------

describe("command.result", () => {
  test("accepts valid success result", async () => {
    const ctx = setupHandlers();
    const result = await invoke(ctx, "command.result", {
      commandId: "cmd-123",
      success: true,
      result: { output: "done" },
    });
    expect(result).toEqual({ received: true, commandId: "cmd-123" });
    expect(ctx.eventBus.events).toHaveLength(1);
    const payload = ctx.eventBus.events[0]!.payload as Record<string, unknown>;
    expect(payload.success).toBe(true);
  });

  test("accepts failure result with error message", async () => {
    const ctx = setupHandlers();
    const result = await invoke(ctx, "command.result", {
      commandId: "cmd-456",
      success: false,
      error: "file not found",
    });
    expect(result).toEqual({ received: true, commandId: "cmd-456" });
    const payload = ctx.eventBus.events[0]!.payload as Record<string, unknown>;
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("file not found");
  });

  test("defaults success to false when omitted", async () => {
    const ctx = setupHandlers();
    await invoke(ctx, "command.result", { commandId: "cmd-789" });
    const payload = ctx.eventBus.events[0]!.payload as Record<string, unknown>;
    expect(payload.success).toBe(false);
  });

  test("rejects missing commandId", async () => {
    const ctx = setupHandlers();
    try {
      await invoke(ctx, "command.result", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });
});

// ---------------------------------------------------------------------------
// research.start
// ---------------------------------------------------------------------------

describe("research.start", () => {
  test("starts research and returns id", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "research.start", {
      query: "best vector search for SQLite",
    })) as Record<string, unknown>;

    expect(result.status).toBe("started");
    expect(typeof result.researchId).toBe("string");
    expect(ctx.eventBus.events).toHaveLength(1);
    expect(ctx.eventBus.events[0]!.type).toBe("research:started");
  });

  test("passes sources and maxSources", async () => {
    const ctx = setupHandlers();
    await invoke(ctx, "research.start", {
      query: "test",
      sources: ["github", "arxiv"],
      maxSources: 5,
    });
    const payload = ctx.eventBus.events[0]!.payload as Record<string, unknown>;
    expect(payload.sources).toEqual(["github", "arxiv"]);
    expect(payload.maxSources).toBe(5);
  });

  test("rejects missing query", async () => {
    const ctx = setupHandlers();
    try {
      await invoke(ctx, "research.start", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });

  test("rejects empty query", async () => {
    const ctx = setupHandlers();
    try {
      await invoke(ctx, "research.start", { query: "" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });
});

// ---------------------------------------------------------------------------
// research.status
// ---------------------------------------------------------------------------

describe("research.status", () => {
  test("returns status for given research id", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "research.status", {
      researchId: "res-abc",
    })) as Record<string, unknown>;
    expect(result.researchId).toBe("res-abc");
    expect(result.status).toBe("unknown");
  });

  test("rejects missing researchId", async () => {
    const ctx = setupHandlers();
    try {
      await invoke(ctx, "research.status", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });
});

// ---------------------------------------------------------------------------
// research.list
// ---------------------------------------------------------------------------

describe("research.list", () => {
  test("returns stub results with default limit", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "research.list", {})) as Record<string, unknown>;
    expect(result.results).toEqual([]);
    expect(result.limit).toBe(20);
  });

  test("respects custom limit", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "research.list", { limit: 5 })) as Record<string, unknown>;
    expect(result.limit).toBe(5);
  });

  test("rejects limit too high", async () => {
    const ctx = setupHandlers();
    try {
      await invoke(ctx, "research.list", { limit: 999 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });
});

// ---------------------------------------------------------------------------
// profile.get
// ---------------------------------------------------------------------------

describe("profile.get", () => {
  test("returns stub profile", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "profile.get", {})) as Record<string, unknown>;
    expect(result.profile).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// metrics.rateLimits
// ---------------------------------------------------------------------------

describe("metrics.rateLimits", () => {
  test("returns note when rateLimitTracker is undefined", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "metrics.rateLimits", {})) as Record<string, unknown>;
    expect(result.accounts).toEqual([]);
    expect(result.note).toBeDefined();
  });

  test("returns account statuses when tracker is provided", async () => {
    const mockStatuses = [{ account: "primary", remaining: 100 }];
    const ctx = setupHandlers({
      rateLimitTracker: {
        getAllAccountStatuses: () => mockStatuses,
      } as unknown as BuiltinHandlerDeps["rateLimitTracker"],
    });
    const result = (await invoke(ctx, "metrics.rateLimits", {})) as Record<string, unknown>;
    expect(result.accounts).toEqual(mockStatuses);
  });
});

// ---------------------------------------------------------------------------
// approval.list
// ---------------------------------------------------------------------------

describe("approval.list", () => {
  test("returns stub items with default status", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "approval.list", {})) as Record<string, unknown>;
    expect(result.items).toEqual([]);
    expect(result.status).toBe("all");
  });

  test("respects status filter", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "approval.list", { status: "pending" })) as Record<string, unknown>;
    expect(result.status).toBe("pending");
  });

  test("rejects invalid status value", async () => {
    const ctx = setupHandlers();
    try {
      await invoke(ctx, "approval.list", { status: "invalid" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });
});

// ---------------------------------------------------------------------------
// approval.respond
// ---------------------------------------------------------------------------

describe("approval.respond", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = setupHandlers();
  });

  test("approves with valid params", async () => {
    const result = (await invoke(ctx, "approval.respond", {
      approvalId: "appr-1",
      action: "approve",
    })) as Record<string, unknown>;

    expect(result.processed).toBe(true);
    expect(result.approvalId).toBe("appr-1");
    expect(result.action).toBe("approve");
  });

  test("denies with reason", async () => {
    const result = (await invoke(ctx, "approval.respond", {
      approvalId: "appr-2",
      action: "deny",
      reason: "too risky",
    })) as Record<string, unknown>;

    expect(result.action).toBe("deny");
  });

  test("publishes approval event to EventBus", async () => {
    await invoke(ctx, "approval.respond", {
      approvalId: "appr-3",
      action: "approve",
      reason: "looks good",
    }, "reviewer");

    expect(ctx.eventBus.events).toHaveLength(1);
    expect(ctx.eventBus.events[0]!.type).toBe("user:approval");
    const payload = ctx.eventBus.events[0]!.payload as Record<string, unknown>;
    expect(payload.approvalId).toBe("appr-3");
    expect(payload.action).toBe("approve");
    expect(payload.respondedBy).toBe("reviewer");
  });

  test("pushes resolution to subscribers", async () => {
    await invoke(ctx, "approval.respond", {
      approvalId: "appr-4",
      action: "deny",
    });

    expect(ctx.pushEvents).toHaveLength(1);
    expect(ctx.pushEvents[0]!.type).toBe("push.approvalResolved");
    expect(ctx.pushEvents[0]!.data.approvalId).toBe("appr-4");
    expect(ctx.pushEvents[0]!.data.action).toBe("deny");
  });

  test("rejects missing approvalId", async () => {
    try {
      await invoke(ctx, "approval.respond", { action: "approve" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });

  test("rejects invalid action", async () => {
    try {
      await invoke(ctx, "approval.respond", { approvalId: "x", action: "maybe" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });
});

// ---------------------------------------------------------------------------
// automation.create
// ---------------------------------------------------------------------------

describe("automation.create", () => {
  test("creates automation and publishes event", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "automation.create", {
      input: "Turn on porch lights at sunset",
    }, "user-1")) as Record<string, unknown>;

    expect(result.created).toBe(true);
    expect(typeof result.automationId).toBe("string");
    expect(ctx.eventBus.events).toHaveLength(1);
    expect(ctx.eventBus.events[0]!.type).toBe("system:config_changed");
    const payload = ctx.eventBus.events[0]!.payload as Record<string, unknown>;
    expect(payload.action).toBe("create_automation");
    expect(payload.input).toBe("Turn on porch lights at sunset");
  });

  test("passes deliverTo", async () => {
    const ctx = setupHandlers();
    await invoke(ctx, "automation.create", {
      input: "test",
      deliverTo: "telegram",
    });
    const payload = ctx.eventBus.events[0]!.payload as Record<string, unknown>;
    expect(payload.deliverTo).toBe("telegram");
  });

  test("rejects missing input", async () => {
    const ctx = setupHandlers();
    try {
      await invoke(ctx, "automation.create", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });

  test("rejects empty input", async () => {
    const ctx = setupHandlers();
    try {
      await invoke(ctx, "automation.create", { input: "" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });
});

// ---------------------------------------------------------------------------
// automation.list
// ---------------------------------------------------------------------------

describe("automation.list", () => {
  test("returns stub scenes with default enabledOnly", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "automation.list", {})) as Record<string, unknown>;
    expect(result.scenes).toEqual([]);
    expect(result.enabledOnly).toBe(false);
  });

  test("passes enabledOnly param", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "automation.list", { enabledOnly: true })) as Record<string, unknown>;
    expect(result.enabledOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// automation.delete
// ---------------------------------------------------------------------------

describe("automation.delete", () => {
  test("deletes automation and publishes event", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "automation.delete", {
      automationId: "auto-xyz",
    }, "user-1")) as Record<string, unknown>;

    expect(result.deleted).toBe(true);
    expect(result.automationId).toBe("auto-xyz");
    expect(ctx.eventBus.events).toHaveLength(1);
    const payload = ctx.eventBus.events[0]!.payload as Record<string, unknown>;
    expect(payload.action).toBe("delete_automation");
    expect(payload.automationId).toBe("auto-xyz");
  });

  test("rejects missing automationId", async () => {
    const ctx = setupHandlers();
    try {
      await invoke(ctx, "automation.delete", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcValidationError);
    }
  });
});

// ---------------------------------------------------------------------------
// system.health
// ---------------------------------------------------------------------------

describe("system.health", () => {
  test("returns health status with uptime", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "system.health", {})) as Record<string, unknown>;
    expect(result.status).toBe("healthy");
    expect(typeof result.uptimeMs).toBe("number");
    expect((result.uptimeMs as number) > 0).toBe(true);
    expect(result.includeMetrics).toBe(false);
  });

  test("passes includeMetrics flag", async () => {
    const ctx = setupHandlers();
    const result = (await invoke(ctx, "system.health", { includeMetrics: true })) as Record<string, unknown>;
    expect(result.includeMetrics).toBe(true);
  });

  test("returns zero uptime when not running", async () => {
    const ctx = setupHandlers({ isRunning: () => false });
    const result = (await invoke(ctx, "system.health", {})) as Record<string, unknown>;
    expect(result.uptimeMs).toBe(0);
  });
});
