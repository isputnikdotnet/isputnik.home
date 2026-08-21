import { db, logActivity } from "../db.js";
import { getSecurityPolicy } from "./security.js";

// AbuseIPDB reputation for IPs local detection has already flagged. Deliberately
// NOT a per-request control: a lookup happens only when an IP gets auto-blocked
// (a handful a day at worst) or when an admin asks from the Blocked IPs page, is
// cached for 24 hours, and does nothing at all until an admin has pasted an API
// key into Security → Policies — so no visitor address ever leaves the house by
// default. Local detection stays the trigger; reputation is enrichment, plus the
// one escalation below.

export interface IpReputation {
  ip_address: string;
  score: number | null; // abuseConfidenceScore 0..100
  total_reports: number | null;
  last_reported_at: string | null;
  country_code: string | null;
  isp: string | null;
  checked_at: string;
}

const REPUTATION_COLUMNS = "ip_address, score, total_reports, last_reported_at, country_code, isp, checked_at";

const CACHE_HOURS = 24;

export function getCachedReputation(ip: string): IpReputation | null {
  const row = db
    .prepare(`SELECT ${REPUTATION_COLUMNS} FROM ip_reputation WHERE ip_address = ?`)
    .get(ip) as IpReputation | undefined;
  return row ?? null;
}

// Cache-only bulk read for tables that show reputation beside many addresses at
// once (the Dashboard's Logins table). Never calls out — an address the admin
// hasn't asked about stays unqueried, which is the whole point of this module.
export function getCachedReputations(ips: string[]): IpReputation[] {
  if (!ips.length) return [];
  const placeholders = ips.map(() => "?").join(", ");
  return db
    .prepare(`SELECT ${REPUTATION_COLUMNS} FROM ip_reputation WHERE ip_address IN (${placeholders})`)
    .all(...ips) as IpReputation[];
}

function isFresh(reputation: IpReputation): boolean {
  return Date.now() - new Date(reputation.checked_at).getTime() < CACHE_HOURS * 3_600_000;
}

// Query AbuseIPDB for one address, through the cache. Never throws — a network
// or API failure returns whatever cache exists (stale beats nothing for a badge)
// or null. Fixed, operator-configured host: this is not a user-supplied URL, so
// the SSRF-pinning dispatcher remote-image.ts needs does not apply here.
export async function checkIpReputation(ip: string, opts: { force?: boolean } = {}): Promise<IpReputation | null> {
  const key = getSecurityPolicy().abuseIpdbKey;
  if (!key) return null;
  const cached = getCachedReputation(ip);
  if (cached && !opts.force && isFresh(cached)) return cached;
  try {
    const response = await fetch(
      `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`,
      { headers: { Key: key, Accept: "application/json" }, signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) return cached;
    const body = (await response.json()) as {
      data?: {
        abuseConfidenceScore?: number;
        totalReports?: number;
        lastReportedAt?: string | null;
        countryCode?: string | null;
        isp?: string | null;
      };
    };
    const data = body?.data;
    if (!data || typeof data.abuseConfidenceScore !== "number") return cached;
    db.prepare(
      `INSERT INTO ip_reputation (ip_address, score, total_reports, last_reported_at, country_code, isp, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(ip_address) DO UPDATE SET
         score = excluded.score,
         total_reports = excluded.total_reports,
         last_reported_at = excluded.last_reported_at,
         country_code = excluded.country_code,
         isp = excluded.isp,
         checked_at = excluded.checked_at`
    ).run(
      ip,
      data.abuseConfidenceScore,
      data.totalReports ?? null,
      data.lastReportedAt ?? null,
      data.countryCode ?? null,
      data.isp ?? null
    );
    return getCachedReputation(ip);
  } catch {
    return cached;
  }
}

// The one action reputation is allowed to take: an IP that local detection just
// auto-blocked AND AbuseIPDB reports as high-confidence abusive loses its expiry.
// Guarded to automatic, still-expiring rows so a repeat can't append the reason
// twice, and to auto rows only so an admin's manual decision is never rewritten.
// Returns what happened so the caller can raise the admin alert.
export async function maybeEscalateByReputation(ip: string): Promise<{ score: number } | null> {
  const policy = getSecurityPolicy();
  if (!policy.abuseIpdbKey || !policy.reputationAutoEscalate) return null;
  const reputation = await checkIpReputation(ip);
  const score = reputation?.score;
  if (typeof score !== "number" || score < policy.reputationEscalateThreshold) return null;
  const escalated =
    db
      .prepare(
        `UPDATE blocked_ips
            SET expires_at = NULL,
                reason = COALESCE(reason, 'Automatic') || ?
          WHERE ip_address = ? AND auto = 1 AND expires_at IS NOT NULL`
      )
      .run(` — known abusive IP (AbuseIPDB ${score}%)`, ip).changes > 0;
  if (!escalated) return null;
  logActivity({
    event: "security.ip_block_escalated",
    detail: `Made the automatic block on ${ip} permanent: AbuseIPDB abuse confidence ${score}%.`,
    ipAddress: ip
  });
  return { score };
}
