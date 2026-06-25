import { nanoid } from "nanoid";
import { db } from "../db.js";
import { ipInAnyCidr } from "./cidr.js";

// Brute-force defense and source-IP access control. Pure data/logic over the
// login_attempts / blocked_ips / trusted_networks tables; the login route and a
// global request hook call into it (see auth-routes.ts and index.ts). Platform
// infrastructure with no product knowledge, so it lives in core/.

export interface SecurityPolicy {
  lockoutThreshold: number; // failed sign-ins before an account locks
  lockoutMinutes: number; // …and how long it stays locked
  ipFailThreshold: number; // failures from one IP before an auto-block
  ipFailWindowMinutes: number; // …counted within this window
  ipAutoblockMinutes: number; // …how long the auto-block lasts
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  lockoutThreshold: 5,
  lockoutMinutes: 30,
  ipFailThreshold: 20,
  ipFailWindowMinutes: 15,
  ipAutoblockMinutes: 60
};

const POLICY_KEY = "security_policy";

// Thresholds are admin-tunable at runtime (Control panel → Security), stored as a
// JSON blob in app_settings and merged over the defaults so a partial/old blob
// still resolves every field.
export function getSecurityPolicy(): SecurityPolicy {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(POLICY_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_SECURITY_POLICY };
  try {
    return { ...DEFAULT_SECURITY_POLICY, ...(JSON.parse(row.value) as Partial<SecurityPolicy>) };
  } catch {
    return { ...DEFAULT_SECURITY_POLICY };
  }
}

export function setSecurityPolicy(policy: SecurityPolicy, userId: string | null): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_by = excluded.updated_by,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(POLICY_KEY, JSON.stringify(policy), userId);
}

// True when the request carries a proxy's forwarding header. Used to warn when
// TRUST_PROXY_HOPS is unset — then request.ip is the proxy, not the client, which
// breaks the per-IP controls below. Node lowercases header names.
export function hasForwardedHeader(headers: Record<string, unknown>): boolean {
  return Boolean(headers["x-forwarded-for"] || headers["forwarded"]);
}

// The configured reverse-proxy hop count from TRUST_PROXY_HOPS (0 = trust nothing,
// i.e. request.ip is the direct socket). Read live so admin UI can surface it.
export function getTrustProxyHops(): number {
  const value = Number(process.env.TRUST_PROXY_HOPS);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

// Runtime signal: has any request arrived with a proxy forwarding header? Lets the
// admin see "a proxy is in front" even when TRUST_PROXY_HOPS hasn't been set.
let forwardedHeaderSeen = false;
export function noteForwardedHeader(): void {
  forwardedHeaderSeen = true;
}
export function wasForwardedHeaderSeen(): boolean {
  return forwardedHeaderSeen;
}

// ── Trusted zones ────────────────────────────────────────────────────────────

export interface TrustedNetwork {
  id: string;
  cidr: string;
  label: string | null;
  created_at: string;
}

function trustedCidrs(): string[] {
  return (db.prepare("SELECT cidr FROM trusted_networks").all() as { cidr: string }[]).map((row) => row.cidr);
}

// A request from a trusted network is exempt from rate limits, lockout, and MFA.
export function isTrustedIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const cidrs = trustedCidrs();
  return cidrs.length > 0 && ipInAnyCidr(ip, cidrs);
}

export function listTrustedNetworks(): TrustedNetwork[] {
  return db
    .prepare("SELECT id, cidr, label, created_at FROM trusted_networks ORDER BY datetime(created_at) DESC")
    .all() as TrustedNetwork[];
}

export function addTrustedNetwork(cidr: string, label: string | null, userId: string | null): string {
  const id = nanoid(16);
  db.prepare("INSERT INTO trusted_networks (id, cidr, label, created_by) VALUES (?, ?, ?, ?)").run(
    id,
    cidr,
    label,
    userId
  );
  return id;
}

export function removeTrustedNetwork(id: string): boolean {
  return db.prepare("DELETE FROM trusted_networks WHERE id = ?").run(id).changes > 0;
}

// ── Login attempts & account lockout ─────────────────────────────────────────

export function recordLoginAttempt(email: string | null, ip: string | null, successful: boolean): void {
  db.prepare("INSERT INTO login_attempts (id, email, ip_address, successful) VALUES (?, ?, ?, ?)").run(
    nanoid(16),
    email ? email.toLowerCase() : null,
    ip ?? null,
    successful ? 1 : 0
  );
}

// Failed sign-ins for this email, within the lockout window and since the last
// successful sign-in (a success clears the slate).
export function accountFailureCount(email: string): number {
  const value = email.toLowerCase();
  const { lockoutMinutes } = getSecurityPolicy();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM login_attempts
       WHERE email = ?
         AND successful = 0
         AND datetime(created_at) > datetime('now', ?)
         AND datetime(created_at) > datetime(COALESCE(
           (SELECT MAX(created_at) FROM login_attempts WHERE email = ? AND successful = 1),
           '1970-01-01'
         ))`
    )
    .get(value, `-${lockoutMinutes} minutes`, value) as { count: number };
  return row.count;
}

export function isAccountLocked(email: string): boolean {
  return accountFailureCount(email) >= getSecurityPolicy().lockoutThreshold;
}

// Admin rescue: clear an account's failed-sign-in tally so it's no longer locked,
// without waiting out the window. The lock is derived purely from these rows (see
// accountFailureCount), so deleting the failures unlocks it. Returns how many were
// cleared. Successful attempts are left intact.
export function clearAccountLockout(email: string): number {
  return db
    .prepare("DELETE FROM login_attempts WHERE email = ? AND successful = 0")
    .run(email.toLowerCase()).changes;
}

// ── IP blocking ──────────────────────────────────────────────────────────────

export interface BlockedIp {
  ip_address: string;
  reason: string | null;
  auto: 0 | 1;
  created_at: string;
  expires_at: string | null;
}

export function isIpBlocked(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const row = db
    .prepare(
      "SELECT 1 FROM blocked_ips WHERE ip_address = ? AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))"
    )
    .get(ip);
  return Boolean(row);
}

export function blockIp(
  ip: string,
  opts: { reason?: string | null; auto?: boolean; minutes?: number | null; userId?: string | null } = {}
): void {
  const expiresAt = opts.minutes ? new Date(Date.now() + opts.minutes * 60_000).toISOString() : null;
  db.prepare(
    `INSERT INTO blocked_ips (ip_address, reason, auto, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(ip_address) DO UPDATE SET
       reason = excluded.reason,
       auto = excluded.auto,
       expires_at = excluded.expires_at,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  ).run(ip, opts.reason ?? null, opts.auto ? 1 : 0, expiresAt, opts.userId ?? null);
}

export function unblockIp(ip: string): boolean {
  return db.prepare("DELETE FROM blocked_ips WHERE ip_address = ?").run(ip).changes > 0;
}

export function listBlockedIps(): BlockedIp[] {
  return db
    .prepare(
      "SELECT ip_address, reason, auto, created_at, expires_at FROM blocked_ips ORDER BY datetime(created_at) DESC"
    )
    .all() as BlockedIp[];
}

function recentIpFailures(ip: string, windowMinutes: number): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM login_attempts WHERE ip_address = ? AND successful = 0 AND datetime(created_at) > datetime('now', ?)"
    )
    .get(ip, `-${windowMinutes} minutes`) as { count: number };
  return row.count;
}

// Auto-block an IP that has crossed the failure threshold. Returns true when it
// newly blocks, so the caller can raise an alert exactly once.
export function maybeAutoBlockIp(ip: string | null | undefined): boolean {
  if (!ip || isIpBlocked(ip)) return false;
  const policy = getSecurityPolicy();
  if (recentIpFailures(ip, policy.ipFailWindowMinutes) < policy.ipFailThreshold) return false;
  blockIp(ip, {
    reason: `Automatic: ${policy.ipFailThreshold}+ failed sign-ins in ${policy.ipFailWindowMinutes} min`,
    auto: true,
    minutes: policy.ipAutoblockMinutes
  });
  return true;
}
