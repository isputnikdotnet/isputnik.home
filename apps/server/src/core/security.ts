import { nanoid } from "nanoid";
import { db } from "../db.js";
import { ipInAnyCidr } from "./cidr.js";

// Brute-force defense and source-IP access control. Pure data/logic over the
// login_attempts / blocked_ips / trusted_networks tables; the login route and a
// global request hook call into it (see auth-routes.ts and index.ts). Platform
// infrastructure with no product knowledge, so it lives in core/.

export const LOCKOUT_THRESHOLD = 5; // failed sign-ins before an account locks
export const LOCKOUT_MINUTES = 30; // …and how long it stays locked
export const IP_FAIL_THRESHOLD = 20; // failures from one IP before an auto-block
export const IP_FAIL_WINDOW_MINUTES = 15; // …counted within this window
export const IP_AUTOBLOCK_MINUTES = 60; // …how long the auto-block lasts

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
    .get(value, `-${LOCKOUT_MINUTES} minutes`, value) as { count: number };
  return row.count;
}

export function isAccountLocked(email: string): boolean {
  return accountFailureCount(email) >= LOCKOUT_THRESHOLD;
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

function recentIpFailures(ip: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM login_attempts WHERE ip_address = ? AND successful = 0 AND datetime(created_at) > datetime('now', ?)"
    )
    .get(ip, `-${IP_FAIL_WINDOW_MINUTES} minutes`) as { count: number };
  return row.count;
}

// Auto-block an IP that has crossed the failure threshold. Returns true when it
// newly blocks, so the caller can raise an alert exactly once.
export function maybeAutoBlockIp(ip: string | null | undefined): boolean {
  if (!ip || isIpBlocked(ip)) return false;
  if (recentIpFailures(ip) < IP_FAIL_THRESHOLD) return false;
  blockIp(ip, {
    reason: `Automatic: ${IP_FAIL_THRESHOLD}+ failed sign-ins in ${IP_FAIL_WINDOW_MINUTES} min`,
    auto: true,
    minutes: IP_AUTOBLOCK_MINUTES
  });
  return true;
}
