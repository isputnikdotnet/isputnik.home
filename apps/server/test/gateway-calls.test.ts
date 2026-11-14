// The gateway's requests to each container, counted per day for Diagnostics'
// Other containers (modules/apps/calls.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { callsToday, recordCall, resetCallCounts } from "../src/modules/apps/calls.js";

beforeEach(() => resetCallCounts());

describe("calls to a container", () => {
  it("counts each request, and a 5xx as failed", () => {
    const at = new Date(2026, 10, 14, 10, 0, 0);
    recordCall("video", 200, at);
    recordCall("video", 404, at);
    recordCall("video", 502, new Date(2026, 10, 14, 10, 5, 0));
    const count = callsToday("video", new Date(2026, 10, 14, 11, 0, 0));
    expect(count).toMatchObject({ day: "2026-11-14", count: 3, failed: 1, lastFailedStatus: 502 });
    expect(count.lastFailedAt).toBe(new Date(2026, 10, 14, 10, 5, 0).toISOString());
    // Another container is counted apart.
    expect(callsToday("games", at)).toMatchObject({ count: 0, failed: 0 });
  });

  it("starts again each day, counting from midnight", () => {
    recordCall("video", 500, new Date(2026, 10, 14, 23, 59, 0));
    const next = callsToday("video", new Date(2026, 10, 15, 8, 0, 0));
    expect(next).toMatchObject({ day: "2026-11-15", count: 0, failed: 0, lastFailedAt: null });
    expect(next.since).toBe(new Date(2026, 10, 15).toISOString());
  });
});
