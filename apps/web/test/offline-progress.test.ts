import { describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));
// No IndexedDB under jsdom: the local row is skipped, which is the private-mode
// path the helper already tolerates, and lets these tests see the server write alone.
vi.mock("../src/offline/downloads", () => ({ openOfflineDb: () => null }));

const { api } = await import("../src/api");
const { persistProgress } = await import("../src/offline/progress");
const mockApi = vi.mocked(api);

// The position saved as the page is left used to go out as a bare fetch with no
// CSRF header, so the server refused it and a book forgot where it was stopped.
// Every save now goes through api(), and the request leaves before the helper's
// first await so a keepalive save survives the page being torn down.
//
// The mock is never reset or cleared between tests: under vitest 5 a mock whose
// first recorded call rejects is reported as a failure even when the rejection is
// handled, so each test looks at the calls it added rather than at a clean slate.

const lastCall = () => mockApi.mock.calls.at(-1) as [string, RequestInit & { keepalive?: boolean }];

describe("persistProgress", () => {
  it("sends the position through api() as a PATCH, floored, with keepalive when asked", async () => {
    mockApi.mockResolvedValue({});
    const before = mockApi.mock.calls.length;
    await persistProgress("bk", "f1", 129.98, { keepalive: true });
    expect(mockApi.mock.calls.length).toBe(before + 1);
    const [path, init] = lastCall();
    expect(path).toBe("/api/library/books/bk/progress");
    expect(init.method).toBe("PATCH");
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual({ fileId: "f1", positionSeconds: 129 });
  });

  it("dispatches the server write synchronously, before anything is awaited", () => {
    mockApi.mockResolvedValue({});
    const before = mockApi.mock.calls.length;
    void persistProgress("bk", "f1", 10);
    expect(mockApi.mock.calls.length).toBe(before + 1);
    expect(lastCall()[1].keepalive).toBe(false);
  });

  it("swallows a refused write instead of throwing", async () => {
    mockApi.mockRejectedValue(new Error("403"));
    await expect(persistProgress("bk", "f1", 10)).resolves.toBeUndefined();
  });
});
