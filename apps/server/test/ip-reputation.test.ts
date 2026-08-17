import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db.js";
import { resetDb } from "./helpers/seed.js";
import { checkIpReputation, getCachedReputation, maybeEscalateByReputation } from "../src/core/ip-reputation.js";
import { blockIp, isIpBlocked, DEFAULT_SECURITY_POLICY, setSecurityPolicy } from "../src/core/security.js";

// A canned AbuseIPDB /check response the fetch stub answers with.
function abuseIpdbResponse(score: number, totalReports = 4213): Response {
  return new Response(
    JSON.stringify({ data: { abuseConfidenceScore: score, totalReports, lastReportedAt: "2026-08-16T00:00:00Z" } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function configure(overrides: Partial<typeof DEFAULT_SECURITY_POLICY> = {}): void {
  setSecurityPolicy({ ...DEFAULT_SECURITY_POLICY, abuseIpdbKey: "test-key", ...overrides }, null);
}

const fetchMock = vi.fn();

beforeEach(() => {
  resetDb();
  db.prepare("DELETE FROM app_settings WHERE key = 'security_policy'").run();
  db.prepare("DELETE FROM ip_reputation").run();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkIpReputation", () => {
  it("does nothing at all without an API key", async () => {
    expect(await checkIpReputation("203.0.113.50")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches once and serves the cache within its window", async () => {
    configure();
    fetchMock.mockResolvedValue(abuseIpdbResponse(100));
    const first = await checkIpReputation("203.0.113.51");
    expect(first?.score).toBe(100);
    expect(first?.total_reports).toBe(4213);

    const second = await checkIpReputation("203.0.113.51");
    expect(second?.score).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches past the cache when forced", async () => {
    configure();
    fetchMock.mockResolvedValueOnce(abuseIpdbResponse(40)).mockResolvedValueOnce(abuseIpdbResponse(95));
    await checkIpReputation("203.0.113.52");
    const forced = await checkIpReputation("203.0.113.52", { force: true });
    expect(forced?.score).toBe(95);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refetches once the cache goes stale", async () => {
    configure();
    fetchMock.mockResolvedValue(abuseIpdbResponse(80));
    await checkIpReputation("203.0.113.53");
    const dayAgo = new Date(Date.now() - 25 * 3_600_000).toISOString();
    db.prepare("UPDATE ip_reputation SET checked_at = ? WHERE ip_address = '203.0.113.53'").run(dayAgo);
    await checkIpReputation("203.0.113.53");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never throws — a failed lookup answers with the stale cache, or null", async () => {
    configure();
    fetchMock.mockRejectedValue(new Error("network down"));
    expect(await checkIpReputation("203.0.113.54")).toBeNull();

    // Seed a stale row: the next failing lookup should still hand it back.
    db.prepare(
      "INSERT INTO ip_reputation (ip_address, score, total_reports, checked_at) VALUES ('203.0.113.54', 77, 9, ?)"
    ).run(new Date(Date.now() - 25 * 3_600_000).toISOString());
    expect((await checkIpReputation("203.0.113.54"))?.score).toBe(77);
  });

  it("keeps the cache clean when the API answers nonsense", async () => {
    configure();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await checkIpReputation("203.0.113.55")).toBeNull();
    expect(getCachedReputation("203.0.113.55")).toBeNull();
  });
});

describe("maybeEscalateByReputation", () => {
  it("makes a fresh auto-block permanent when the score crosses the threshold", async () => {
    configure();
    fetchMock.mockResolvedValue(abuseIpdbResponse(100));
    blockIp("203.0.113.60", { reason: "Automatic: 20 scanner probes in 15 min", auto: true, minutes: 60 });

    expect(await maybeEscalateByReputation("203.0.113.60")).toEqual({ score: 100 });

    const row = db
      .prepare("SELECT reason, auto, expires_at FROM blocked_ips WHERE ip_address = '203.0.113.60'")
      .get() as { reason: string; auto: number; expires_at: string | null };
    expect(row.expires_at).toBeNull();
    // No admin acted, so the row stays Automatic — unlike makeIpBlockPermanent.
    expect(row.auto).toBe(1);
    expect(row.reason).toBe("Automatic: 20 scanner probes in 15 min — known abusive IP (AbuseIPDB 100%)");
    expect(isIpBlocked("203.0.113.60")).toBe(true);

    const log = db
      .prepare("SELECT detail FROM activity_logs WHERE event = 'security.ip_block_escalated' AND ip_address = '203.0.113.60'")
      .get() as { detail: string } | undefined;
    expect(log?.detail).toBe("Made the automatic block on 203.0.113.60 permanent: AbuseIPDB abuse confidence 100%.");

    // Running again finds nothing left to escalate — the reason can't double up.
    expect(await maybeEscalateByReputation("203.0.113.60")).toBeNull();
  });

  it("leaves a low-scoring block on its normal cooldown", async () => {
    configure();
    fetchMock.mockResolvedValue(abuseIpdbResponse(40));
    blockIp("203.0.113.61", { reason: "Automatic: x", auto: true, minutes: 60 });
    expect(await maybeEscalateByReputation("203.0.113.61")).toBeNull();
    const row = db
      .prepare("SELECT expires_at FROM blocked_ips WHERE ip_address = '203.0.113.61'")
      .get() as { expires_at: string | null };
    expect(row.expires_at).not.toBeNull();
  });

  it("never rewrites a manual block", async () => {
    configure();
    fetchMock.mockResolvedValue(abuseIpdbResponse(100));
    blockIp("203.0.113.62", { reason: "Blocked by an administrator", auto: false, minutes: 60 });
    expect(await maybeEscalateByReputation("203.0.113.62")).toBeNull();
    const row = db
      .prepare("SELECT reason, expires_at FROM blocked_ips WHERE ip_address = '203.0.113.62'")
      .get() as { reason: string; expires_at: string | null };
    expect(row.reason).toBe("Blocked by an administrator");
    expect(row.expires_at).not.toBeNull();
  });

  it("respects the escalation switch and the missing key", async () => {
    configure({ reputationAutoEscalate: false });
    fetchMock.mockResolvedValue(abuseIpdbResponse(100));
    blockIp("203.0.113.63", { reason: "Automatic: x", auto: true, minutes: 60 });
    expect(await maybeEscalateByReputation("203.0.113.63")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    setSecurityPolicy({ ...DEFAULT_SECURITY_POLICY, abuseIpdbKey: "" }, null);
    expect(await maybeEscalateByReputation("203.0.113.63")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
