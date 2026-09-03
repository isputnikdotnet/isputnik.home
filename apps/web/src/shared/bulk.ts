// Bulk actions go to the server in batches. Every bulk endpoint caps its `ids`
// array (200 — bounded work per request, bounded body), while a gallery
// selection has no ceiling at all: selecting 204 photos and setting a place used
// to fail on the cap with the validator's own words ("Too big: expected array to
// have <=200 items"), having changed nothing.
//
// So the caller sends what it has and this splits it. Batches run one after
// another rather than at once: the same endpoint doing per-item permission
// lookups and writes, hit ten times in parallel, is a worse deal for a home
// server than ten quick requests in a row.

/** What one request may carry — matches the cap every bulk endpoint declares. */
export const BULK_BATCH_SIZE = 200;

/** Thrown when a batch fails after earlier ones already went through, so the
 *  caller can say how much of the selection actually changed rather than
 *  implying none of it did. */
export class PartialBulkError extends Error {
  constructor(message: string, readonly applied: number, readonly cause: unknown) {
    super(message);
    this.name = "PartialBulkError";
  }
}

export function bulkBatches<T>(items: T[], size = BULK_BATCH_SIZE): T[][] {
  if (items.length <= size) return items.length > 0 ? [items] : [];
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

/** Run `send` over the ids in batches, adding up the counters each call returns
 *  ({ updated, forbidden, … }). A batch that fails stops the run and reports how
 *  many ids had already been sent successfully. */
export async function sendInBatches<T extends Record<string, number>>(
  ids: string[],
  send: (batch: string[]) => Promise<T>
): Promise<T> {
  const batches = bulkBatches(ids);
  const totals = {} as Record<string, number>;
  let applied = 0;

  for (const batch of batches) {
    let result: T;
    try {
      result = await send(batch);
    } catch (err) {
      if (applied === 0) throw err;
      throw new PartialBulkError(err instanceof Error ? err.message : String(err), applied, err);
    }
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === "number") totals[key] = (totals[key] ?? 0) + value;
    }
    applied += batch.length;
  }

  return totals as T;
}
