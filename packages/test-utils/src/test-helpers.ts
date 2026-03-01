/**
 * Common async test helpers: waitFor, sleep, collectAsync, eventually.
 */

/**
 * Wait for a condition to become true, checking periodically.
 * Throws if the condition is not met within the timeout.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options?: { timeoutMs?: number; intervalMs?: number; message?: string },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const intervalMs = options?.intervalMs ?? 50;
  const message = options?.message ?? "Condition not met within timeout";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timeout: ${message}`);
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collect all items from an async iterable into an array.
 */
export async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

/**
 * Assert that a function eventually resolves to a truthy value.
 */
export async function eventually(
  fn: () => unknown | Promise<unknown>,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  await waitFor(async () => {
    const result = await fn();
    return Boolean(result);
  }, options);
}
