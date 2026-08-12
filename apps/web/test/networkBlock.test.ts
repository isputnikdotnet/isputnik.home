import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, isAccessOrMissingApiError, isBlockedByNetwork } from "../src/api";

// A corporate proxy (Zscaler, in the case that prompted this) answers /api/* with its
// own HTML caution page. Everything below is about telling that apart from the server
// legitimately refusing — which it always does in JSON.
const gatewayBlock = (status = 403) =>
  new Response("<html><body>Access Denied</body></html>", {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });

const serverRefusal = (status = 403) =>
  new Response(JSON.stringify({ error: "Forbidden" }), {
    status,
    headers: { "content-type": "application/json" }
  });

const mockFetch = vi.mocked(globalThis.fetch);
// Braces matter: an arrow returning the mock hands Vitest a "teardown function" it
// then calls with no arguments — which trips the unmocked-fetch guard in setup.ts.
beforeEach(() => { mockFetch.mockReset(); });

describe("isBlockedByNetwork", () => {
  it("flags a gateway status carrying HTML", () => {
    for (const status of [403, 407, 451, 511]) {
      expect(isBlockedByNetwork(gatewayBlock(status))).toBe(true);
    }
  });

  it("leaves the server's own JSON refusals alone", () => {
    expect(isBlockedByNetwork(serverRefusal(403))).toBe(false);
    expect(isBlockedByNetwork(serverRefusal(401))).toBe(false);
    expect(isBlockedByNetwork(new Response("{}", { status: 200 }))).toBe(false);
  });

  it("does not claim a proxy for an HTML 502 — that is the server being down", () => {
    expect(isBlockedByNetwork(gatewayBlock(502))).toBe(false);
  });
});

describe("api() behind a filtering proxy", () => {
  it("explains the block instead of reporting a generic failure", async () => {
    mockFetch.mockResolvedValueOnce(gatewayBlock());

    const error = await api("/api/auth/login", { method: "POST", body: "{}" }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).blockedByNetwork).toBe(true);
    expect((error as ApiError).message).toMatch(/proxy|filter|portal/i);
  });

  it("does not read a block as an access denial, so offline copies still show", async () => {
    mockFetch.mockResolvedValueOnce(gatewayBlock());
    const blocked = await api("/api/books/1").catch((e) => e);

    mockFetch.mockResolvedValueOnce(serverRefusal());
    const refused = await api("/api/books/1").catch((e) => e);

    expect(isAccessOrMissingApiError(blocked)).toBe(false);
    expect(isAccessOrMissingApiError(refused)).toBe(true);
  });
});
