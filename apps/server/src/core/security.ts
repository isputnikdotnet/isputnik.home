import { nanoid } from "nanoid";
import { db } from "../db.js";
import { ipInAnyCidr, ipNetworkKey } from "./cidr.js";

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
  alertNewIpSignIn: boolean; // email on a sign-in from a network not seen before
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  lockoutThreshold: 5,
  lockoutMinutes: 30,
  ipFailThreshold: 20,
  ipFailWindowMinutes: 15,
  ipAutoblockMinutes: 60,
  alertNewIpSignIn: false
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

// The scheme a proxy says the visitor actually used, or null when nothing says.
// X-Forwarded-Proto accumulates left-to-right through a chain ("https,http"), and
// the FIRST entry is the one the client spoke — the only one that matters here.
export function forwardedProto(headers: Record<string, unknown>): string | null {
  const raw = headers["x-forwarded-proto"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const first = value.split(",")[0]?.trim().toLowerCase();
  return first === "http" || first === "https" ? first : null;
}

// The Host header, accepted only if it is a bare hostname with an optional port.
// It is client-supplied, so it must never be pasted into a redirect unchecked: a
// value like "evil.com" or one carrying userinfo/backslashes would turn this
// server into an open redirect that points off-site from our own domain. Anything
// that isn't plainly a host is refused, and the caller then does not redirect.
export function safeRedirectHost(host: unknown): string | null {
  if (typeof host !== "string") return null;
  return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? host : null;
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

// ── Known sign-in networks ───────────────────────────────────────────────────

// Record the network a successful sign-in came from and report whether it is new
// for this account. Keyed on the coarse network (see ipNetworkKey) so a rotating
// home or mobile address isn't a "new location" on every reconnect. Called on
// every sign-in whatever the alert policy says, so turning the alert on later
// doesn't fire for devices already in use.
export function noteSignInNetwork(userId: string, ip: string | null | undefined): { isNew: boolean; key: string } | null {
  if (!ip) return null;
  const key = ipNetworkKey(ip) ?? ip;
  const seen = db
    .prepare("SELECT 1 FROM known_login_networks WHERE user_id = ? AND network_key = ?")
    .get(userId, key);
  db.prepare(
    `INSERT INTO known_login_networks (user_id, network_key, last_ip)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, network_key) DO UPDATE SET
       last_ip = excluded.last_ip,
       last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  ).run(userId, key, ip);
  return { isNew: !seen, key };
}

// Backfill known networks from sign-in history (live sessions and successful
// login attempts). Run when an admin first enables the alert so existing devices
// don't each trigger one. Returns how many networks were newly recorded.
export function seedKnownLoginNetworks(): number {
  const rows = db
    .prepare(
      `SELECT user_id, ip_address FROM sessions WHERE ip_address IS NOT NULL
       UNION
       SELECT u.id AS user_id, a.ip_address FROM login_attempts a
         JOIN users u ON LOWER(u.email) = a.email
        WHERE a.successful = 1 AND a.ip_address IS NOT NULL`
    )
    .all() as { user_id: string; ip_address: string }[];
  const insert = db.prepare(
    "INSERT OR IGNORE INTO known_login_networks (user_id, network_key, last_ip) VALUES (?, ?, ?)"
  );
  let added = 0;
  for (const row of rows) {
    const key = ipNetworkKey(row.ip_address) ?? row.ip_address;
    added += insert.run(row.user_id, key, row.ip_address).changes;
  }
  return added;
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
// successful sign-in (a success clears the slate). "Failed" covers a rejected
// password and a rejected second factor alike; a success row is only written once
// a sign-in is complete, so an MFA account's password step can't clear the slate
// mid-challenge (see auth-routes/mfa-routes).
export function accountFailureCount(email: string): number {
  const value = email.toLowerCase();
  const { lockoutMinutes } = getSecurityPolicy();
  const row = db
    .prepare(
      // The window is a time range, but "since the last success" is an ordering
      // question, so it compares rowid rather than created_at. The timestamp has
      // millisecond resolution and datetime() truncates to whole seconds, either of
      // which can tie — and a tie here would silently drop failures from the count.
      // This table is append-only apart from clearAccountLockout, which deletes only
      // failures, so a later insert always has the higher rowid.
      `SELECT COUNT(*) AS count FROM login_attempts
       WHERE email = ?
         AND successful = 0
         AND datetime(created_at) > datetime('now', ?)
         AND rowid > COALESCE(
           (SELECT MAX(rowid) FROM login_attempts WHERE email = ? AND successful = 1),
           0
         )`
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

// ── Second-factor failures ───────────────────────────────────────────────────

// A rejected second factor is a much stronger signal than a rejected password:
// the password already worked, so someone is holding a working credential. Each
// challenge caps its own attempts, but nothing counted them across challenges —
// re-entering the password just mints a new one. Counted off the activity log
// rows the MFA route already writes, so there's no extra table and the tally
// survives a restart.
export const MFA_FAILURE_ALERT_THRESHOLD = 3;
export const MFA_FAILURE_WINDOW_MINUTES = 15;

export function recentMfaFailureCount(userId: string, windowMinutes = MFA_FAILURE_WINDOW_MINUTES): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM activity_logs
        WHERE event = 'auth.mfa_failed'
          AND target_id = ?
          AND datetime(created_at) > datetime('now', ?)`
    )
    .get(userId, `-${windowMinutes} minutes`) as { count: number };
  return row.count;
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

// A request that can only be a guess or a scan: a scanner probe path, or a share
// / API token that matches nothing at all. Recorded as a failed attempt with no
// email, so it feeds ONLY the per-IP auto-block below — accountFailureCount
// filters on email, so an anonymous hit can never help lock a real account.
export function recordAbuseAttempt(ip: string | null | undefined): void {
  if (!ip) return;
  recordLoginAttempt(null, ip, false);
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
