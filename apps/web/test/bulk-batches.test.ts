import { describe, expect, it } from "vitest";
import { BULK_BATCH_SIZE, PartialBulkError, bulkBatches, sendInBatches } from "../src/shared/bulk";

// The bug this exists for: a selection of 204 photos sent to an endpoint that
// accepts 200, failing on the cap having changed nothing.
describe("bulkBatches", () => {
  it("leaves a selection that already fits in one batch", () => {
    expect(bulkBatches(["a", "b"])).toEqual([["a", "b"]]);
  });

  it("splits 204 into 200 + 4", () => {
    const ids = Array.from({ length: 204 }, (_, i) => `id-${i}`);
    const batches = bulkBatches(ids);
    expect(batches.map((batch) => batch.length)).toEqual([200, 4]);
    expect(batches.flat()).toEqual(ids);
  });

  it("has nothing to send for an empty selection", () => {
    expect(bulkBatches([])).toEqual([]);
  });

  it("splits exactly on the boundary without an empty tail", () => {
    const ids = Array.from({ length: BULK_BATCH_SIZE * 2 }, (_, i) => `id-${i}`);
    expect(bulkBatches(ids).map((batch) => batch.length)).toEqual([BULK_BATCH_SIZE, BULK_BATCH_SIZE]);
  });
});

describe("sendInBatches", () => {
  it("adds up the counters every batch returns", async () => {
    const ids = Array.from({ length: 204 }, (_, i) => `id-${i}`);
    const sent: number[] = [];
    const totals = await sendInBatches(ids, async (batch) => {
      sent.push(batch.length);
      return { updated: batch.length, forbidden: 1 };
    });
    expect(sent).toEqual([200, 4]);
    expect(totals).toEqual({ updated: 204, forbidden: 2 });
  });

  it("sends the batches one after another, not all at once", async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `id-${i}`);
    let inFlight = 0;
    let peak = 0;
    await sendInBatches(ids, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { updated: 1 };
    });
    expect(peak).toBe(1);
  });

  it("passes the failure straight through when nothing was applied", async () => {
    await expect(sendInBatches(["a"], async () => { throw new Error("nope"); }))
      .rejects.toThrowError("nope");
  });

  it("says how much went through when a later batch fails", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    let calls = 0;
    const failure = sendInBatches(ids, async (batch) => {
      calls += 1;
      if (calls === 2) throw new Error("server said no");
      return { updated: batch.length };
    });
    await expect(failure).rejects.toBeInstanceOf(PartialBulkError);
    await failure.catch((err: PartialBulkError) => {
      expect(err.applied).toBe(200);
      expect(err.message).toBe("server said no");
    });
  });
});
