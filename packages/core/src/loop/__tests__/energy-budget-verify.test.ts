import { describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import type { EnergyBudgetConfig } from "../energy-budget.ts";
import { EnergyBudget } from "../energy-budget.ts";

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

const TEST_CONFIG: EnergyBudgetConfig = {
	maxTokensPerHour: 100_000,
	categories: {
		user: 0.5, // 50,000 tokens
		tasks: 0.2, // 20,000 tokens
		learning: 0.2, // 20,000 tokens
		dreaming: 0.1, // 10,000 tokens
	},
};

describe("EnergyBudget verification", () => {
	const logger = createSilentLogger();

	test("remaining matches allocated minus consumed per category", () => {
		const budget = new EnergyBudget(TEST_CONFIG, logger);

		// Initial: full budget
		expect(budget.remaining("user")).toBe(50_000);
		expect(budget.remaining("tasks")).toBe(20_000);
		expect(budget.remaining("learning")).toBe(20_000);
		expect(budget.remaining("dreaming")).toBe(10_000);

		// Consume some
		budget.consume("user", 5_000);
		expect(budget.remaining("user")).toBe(45_000);

		budget.consume("tasks", 12_000);
		expect(budget.remaining("tasks")).toBe(8_000);

		budget.consume("learning", 20_000);
		expect(budget.remaining("learning")).toBe(0);
	});

	test("canAfford returns true when budget sufficient", () => {
		const budget = new EnergyBudget(TEST_CONFIG, logger);

		expect(budget.canAfford("tasks", 10_000)).toBe(true);
		expect(budget.canAfford("tasks", 20_000)).toBe(true);
		expect(budget.canAfford("tasks", 20_001)).toBe(false);
	});

	test("canAfford returns false when budget exhausted", () => {
		const budget = new EnergyBudget(TEST_CONFIG, logger);

		budget.consume("learning", 20_000);
		expect(budget.remaining("learning")).toBe(0);
		expect(budget.canAfford("learning", 1)).toBe(false);
		expect(budget.canAfford("learning", 1000)).toBe(false);
	});

	test("canAfford uses default estimate of 1000 when no estimate given", () => {
		const budget = new EnergyBudget(TEST_CONFIG, logger);

		// dreaming has 10,000 allocated
		budget.consume("dreaming", 9_500);
		expect(budget.remaining("dreaming")).toBe(500);

		// No estimate provided: defaults to 1000
		expect(budget.canAfford("dreaming")).toBe(false);

		// With explicit estimate under remaining
		expect(budget.canAfford("dreaming", 500)).toBe(true);
	});

	test("user category ALWAYS returns true from canAfford", () => {
		const budget = new EnergyBudget(TEST_CONFIG, logger);

		// Exhaust user budget entirely
		budget.consume("user", 100_000);
		expect(budget.remaining("user")).toBe(0);

		// canAfford still returns true for user
		expect(budget.canAfford("user")).toBe(true);
		expect(budget.canAfford("user", 999_999)).toBe(true);
	});

	test("totalRemaining sums across all categories", () => {
		const budget = new EnergyBudget(TEST_CONFIG, logger);

		const total = budget.totalRemaining();
		// 50k + 20k + 20k + 10k = 100k
		expect(total).toBe(100_000);

		budget.consume("user", 10_000);
		budget.consume("tasks", 5_000);
		expect(budget.totalRemaining()).toBe(85_000);
	});

	test("consume does not allow remaining to go negative", () => {
		const budget = new EnergyBudget(TEST_CONFIG, logger);

		// Consume more than allocated
		budget.consume("dreaming", 15_000);
		expect(budget.remaining("dreaming")).toBe(0); // floored at 0, not -5000
	});

	test("consume ignores non-finite and negative values", () => {
		const budget = new EnergyBudget(TEST_CONFIG, logger);

		budget.consume("tasks", Number.NaN);
		expect(budget.remaining("tasks")).toBe(20_000);

		budget.consume("tasks", Number.POSITIVE_INFINITY);
		expect(budget.remaining("tasks")).toBe(20_000);

		budget.consume("tasks", -500);
		expect(budget.remaining("tasks")).toBe(20_000);

		budget.consume("tasks", 0);
		expect(budget.remaining("tasks")).toBe(20_000);
	});

	test("getStats returns per-category breakdown", () => {
		const budget = new EnergyBudget(TEST_CONFIG, logger);

		budget.consume("user", 3_000);
		budget.consume("tasks", 7_000);

		const stats = budget.getStats();
		expect(stats).toHaveLength(4); // user, tasks, learning, dreaming (alert excluded with 0 allocation)

		const userStat = stats.find((s) => s.category === "user");
		expect(userStat?.allocated).toBe(50_000);
		expect(userStat?.used).toBe(3_000);
		expect(userStat?.remaining).toBe(47_000);

		const tasksStat = stats.find((s) => s.category === "tasks");
		expect(tasksStat?.allocated).toBe(20_000);
		expect(tasksStat?.used).toBe(7_000);
		expect(tasksStat?.remaining).toBe(13_000);
	});

	test("hourly reset clears usage when hour bucket changes", () => {
		const budget = new EnergyBudget(TEST_CONFIG, logger);

		budget.consume("user", 30_000);
		budget.consume("tasks", 15_000);
		expect(budget.remaining("user")).toBe(20_000);
		expect(budget.remaining("tasks")).toBe(5_000);

		// Simulate hour boundary crossing by manipulating Date.now
		const originalNow = Date.now;
		try {
			// Move time forward by 1 hour + 1ms
			const futureMs = originalNow() + 3_600_001;
			Date.now = () => futureMs;

			// resetIfNewHour is called internally by remaining/canAfford
			expect(budget.remaining("user")).toBe(50_000);
			expect(budget.remaining("tasks")).toBe(20_000);
			expect(budget.canAfford("learning", 20_000)).toBe(true);
		} finally {
			Date.now = originalNow;
		}
	});

	test("updateConfig changes allocations immediately", () => {
		const budget = new EnergyBudget(TEST_CONFIG, logger);

		expect(budget.remaining("user")).toBe(50_000);

		const newConfig: EnergyBudgetConfig = {
			maxTokensPerHour: 200_000,
			categories: { user: 0.5, tasks: 0.2, learning: 0.2, dreaming: 0.1 },
		};

		budget.updateConfig(newConfig);
		expect(budget.remaining("user")).toBe(100_000); // 200k * 0.5
	});

	test("alert category included in stats only when configured", () => {
		const budget = new EnergyBudget(TEST_CONFIG, logger);

		// No alert allocation in TEST_CONFIG
		let stats = budget.getStats();
		const alertStat = stats.find((s) => s.category === "alert");
		expect(alertStat).toBeUndefined();

		// With alert allocation
		const configWithAlert: EnergyBudgetConfig = {
			maxTokensPerHour: 100_000,
			categories: { user: 0.4, tasks: 0.2, learning: 0.2, dreaming: 0.1, alert: 0.1 },
		};
		const budgetWithAlert = new EnergyBudget(configWithAlert, logger);
		stats = budgetWithAlert.getStats();
		const alertStatWithConfig = stats.find((s) => s.category === "alert");
		expect(alertStatWithConfig).toBeDefined();
		expect(alertStatWithConfig?.allocated).toBe(10_000);
	});
});
