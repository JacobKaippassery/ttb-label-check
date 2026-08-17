/**
 * Bounded-concurrency map with progress reporting.
 *
 * Sarah Chen: large importers drop 200-300 applications at once during peak
 * season and agents currently process them one at a time. Janet in the Seattle
 * office has been asking for batch handling for years.
 *
 * Concurrency is bounded rather than unbounded for two reasons: the Anthropic
 * API enforces per-organization rate limits that unbounded fan-out would
 * trip immediately, and holding 300 decoded images in memory at once is a
 * straightforward way to run a server out of heap.
 *
 * Results are returned in input order regardless of completion order, so an
 * exported CSV lines up row-for-row with the uploaded batch.
 */
export async function mapWithConcurrency<In, Out>(
  items: readonly In[],
  limit: number,
  worker: (item: In, index: number) => Promise<Out>,
  onProgress?: (completed: number, total: number) => void,
): Promise<Array<{ ok: true; value: Out } | { ok: false; error: Error }>> {
  const results = new Array<{ ok: true; value: Out } | { ok: false; error: Error }>(items.length);
  let nextIndex = 0;
  let completed = 0;

  const effectiveLimit = Math.max(1, Math.min(limit, items.length));

  async function run(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index]!, index) };
      } catch (err) {
        results[index] = {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
      completed++;
      onProgress?.(completed, items.length);
    }
  }

  await Promise.all(Array.from({ length: effectiveLimit }, run));
  return results;
}
