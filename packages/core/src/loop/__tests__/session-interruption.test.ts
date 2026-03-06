import { describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import { SessionSupervisor } from "../session-supervisor.ts";

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

describe("Session interruption", () => {
	const logger = createSilentLogger();

	test("findInterruptible returns lowest-priority interruptible session", () => {
		const supervisor = new SessionSupervisor(logger);

		supervisor.register("dream-1", "dream"); // priority 10, interruptible
		supervisor.register("learning-1", "learning"); // priority 30, interruptible
		supervisor.register("task-1", "task"); // priority 60, interruptible

		// When a main session (priority 100) needs room, the dream (lowest) should be interrupted
		const candidate = supervisor.findInterruptible("main");
		expect(candidate).not.toBeNull();
		expect(candidate?.sessionId).toBe("dream-1");
		expect(candidate?.type).toBe("dream");
	});

	test("findInterruptible skips non-interruptible sessions", () => {
		const supervisor = new SessionSupervisor(logger);

		supervisor.register("main-1", "main"); // priority 100, NOT interruptible

		// A voice session (priority 80) should not be able to interrupt main
		const candidate = supervisor.findInterruptible("voice");
		expect(candidate).toBeNull();
	});

	test("findInterruptible returns null when no lower-priority session exists", () => {
		const supervisor = new SessionSupervisor(logger);

		supervisor.register("task-1", "task"); // priority 60, interruptible

		// A learning session (priority 30) cannot interrupt task (priority 60)
		const candidate = supervisor.findInterruptible("learning");
		expect(candidate).toBeNull();
	});

	test("findInterruptible returns null when same priority", () => {
		const supervisor = new SessionSupervisor(logger);

		supervisor.register("task-1", "task"); // priority 60

		// Another task session (same priority 60) cannot interrupt
		const candidate = supervisor.findInterruptible("task");
		expect(candidate).toBeNull();
	});

	test("register and unregister lifecycle", () => {
		const supervisor = new SessionSupervisor(logger);

		expect(supervisor.hasActiveSessions()).toBe(false);

		const reg1 = supervisor.register("sess-1", "task");
		expect(reg1.ok).toBe(true);
		expect(supervisor.hasActiveSessions()).toBe(true);
		expect(supervisor.getActive()).toHaveLength(1);

		const reg2 = supervisor.register("sess-2", "task");
		expect(reg2.ok).toBe(true);
		expect(supervisor.getActive()).toHaveLength(2);

		supervisor.unregister("sess-1");
		expect(supervisor.getActive()).toHaveLength(1);
		expect(supervisor.getActive()[0]?.sessionId).toBe("sess-2");

		supervisor.unregister("sess-2");
		expect(supervisor.hasActiveSessions()).toBe(false);
	});

	test("register rejects duplicate session IDs", () => {
		const supervisor = new SessionSupervisor(logger);

		const reg1 = supervisor.register("dup-id", "task");
		expect(reg1.ok).toBe(true);

		const reg2 = supervisor.register("dup-id", "learning");
		expect(reg2.ok).toBe(false);
		if (!reg2.ok) {
			expect(reg2.error.code).toBe("SESSION_LIMIT_REACHED");
		}
	});

	test("concurrency limits are enforced per type", () => {
		const supervisor = new SessionSupervisor(logger);

		// main: maxConcurrent = 1
		const reg1 = supervisor.register("main-1", "main");
		expect(reg1.ok).toBe(true);

		const reg2 = supervisor.register("main-2", "main");
		expect(reg2.ok).toBe(false);

		// task: maxConcurrent = 3
		supervisor.register("task-1", "task");
		supervisor.register("task-2", "task");
		supervisor.register("task-3", "task");

		const reg3 = supervisor.register("task-4", "task");
		expect(reg3.ok).toBe(false);
		if (!reg3.ok) {
			expect(reg3.error.code).toBe("SESSION_LIMIT_REACHED");
		}
	});

	test("unregistering frees a slot for the same type", () => {
		const supervisor = new SessionSupervisor(logger);

		// Fill the main slot
		supervisor.register("main-1", "main");
		expect(supervisor.canStart("main")).toBe(false);

		// Free it
		supervisor.unregister("main-1");
		expect(supervisor.canStart("main")).toBe(true);

		// Re-register
		const reg = supervisor.register("main-2", "main");
		expect(reg.ok).toBe(true);
	});

	test("countByType returns correct count", () => {
		const supervisor = new SessionSupervisor(logger);

		supervisor.register("task-1", "task");
		supervisor.register("task-2", "task");
		supervisor.register("learning-1", "learning");

		expect(supervisor.countByType("task")).toBe(2);
		expect(supervisor.countByType("learning")).toBe(1);
		expect(supervisor.countByType("dream")).toBe(0);
	});

	test("getActiveByType filters correctly", () => {
		const supervisor = new SessionSupervisor(logger);

		supervisor.register("task-1", "task");
		supervisor.register("task-2", "task");
		supervisor.register("dream-1", "dream");

		const tasks = supervisor.getActiveByType("task");
		expect(tasks).toHaveLength(2);
		expect(tasks.every((s) => s.type === "task")).toBe(true);

		const dreams = supervisor.getActiveByType("dream");
		expect(dreams).toHaveLength(1);
		expect(dreams[0]?.type).toBe("dream");

		const mains = supervisor.getActiveByType("main");
		expect(mains).toHaveLength(0);
	});

	test("interrupt then register allows new session of same type", () => {
		const supervisor = new SessionSupervisor(logger);

		supervisor.register("dream-1", "dream");
		expect(supervisor.canStart("dream")).toBe(false);

		// Simulate interruption: find it, unregister it
		const victim = supervisor.findInterruptible("main");
		expect(victim).not.toBeNull();
		expect(victim?.sessionId).toBe("dream-1");

		supervisor.unregister(victim!.sessionId);
		expect(supervisor.canStart("dream")).toBe(true);

		// Register the new higher-priority session instead
		const reg = supervisor.register("main-1", "main");
		expect(reg.ok).toBe(true);
	});

	test("getRule returns correct concurrency rules", () => {
		const supervisor = new SessionSupervisor(logger);

		const mainRule = supervisor.getRule("main");
		expect(mainRule.maxConcurrent).toBe(1);
		expect(mainRule.interruptible).toBe(false);
		expect(mainRule.priority).toBe(100);

		const dreamRule = supervisor.getRule("dream");
		expect(dreamRule.maxConcurrent).toBe(1);
		expect(dreamRule.interruptible).toBe(true);
		expect(dreamRule.priority).toBe(10);

		const taskRule = supervisor.getRule("task");
		expect(taskRule.maxConcurrent).toBe(3);
		expect(taskRule.interruptible).toBe(true);
		expect(taskRule.priority).toBe(60);
	});

	test("unregister unknown session is a no-op", () => {
		const supervisor = new SessionSupervisor(logger);

		// Should not throw
		supervisor.unregister("nonexistent-id");
		expect(supervisor.hasActiveSessions()).toBe(false);
	});
});
