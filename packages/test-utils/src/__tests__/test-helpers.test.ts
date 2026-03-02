import { describe, expect, test } from "bun:test";
import { collectAsync, eventually, sleep, waitFor } from "../test-helpers.ts";

describe("sleep", () => {
  test("resolves after delay", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

describe("collectAsync", () => {
  test("collects items from async iterable", async () => {
    async function* gen(): AsyncGenerator<number> {
      yield 1;
      yield 2;
      yield 3;
    }
    const items = await collectAsync(gen());
    expect(items).toEqual([1, 2, 3]);
  });

  test("returns empty array for empty iterable", async () => {
    async function* gen(): AsyncGenerator<never> {
      // empty
    }
    const items = await collectAsync(gen());
    expect(items).toEqual([]);
  });
});

describe("waitFor", () => {
  test("resolves when condition is met", async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 50);
    await waitFor(() => ready, { timeoutMs: 1_000 });
    expect(ready).toBe(true);
  });

  test("throws on timeout", async () => {
    await expect(waitFor(() => false, { timeoutMs: 100, message: "test timeout" })).rejects.toThrow(
      "waitFor timeout: test timeout",
    );
  });
});

describe("eventually", () => {
  test("resolves when fn returns truthy", async () => {
    let counter = 0;
    await eventually(
      () => {
        counter++;
        return counter >= 3;
      },
      { timeoutMs: 1_000 },
    );
    expect(counter).toBeGreaterThanOrEqual(3);
  });
});
