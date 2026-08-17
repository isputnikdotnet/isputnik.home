import { nanoid } from "nanoid";
import { db, logActivity } from "../db.js";
import { ipInAnyCidr, ipNetworkKey, isPrivateIp } from "./cidr.js";

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
  deviceLinkScope: DeviceLinkScope; // where a device may ask to be linked from
  requireMfaOutside: boolean; // every sign-in from outside a trusted network needs a second factor
  abuseIpdbKey: string; // AbuseIPDB API key; "" disables all reputation lookups
  reputationAutoEscalate: boolean; // auto-blocks become permanent when the score crosses…
  reputationEscalateThreshold: number; // …this abuseConfidenceScore (0–100)
  trustedDeletesOnly: boolean; // refuse delete/purge actions from outside trusted networks
}

// Which devices may start a "link a device" request. 'local' is the default and
// the safe one: a wall display is always in the house, and the attack this feature
// invites is a stranger starting a request remotely and talking a household member
// into approving it. 'any' exists for the household that really does want to link
// a device over the internet, and says so deliberately.
export type DeviceLinkScope = "local" | "any";

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  lockoutThreshold: 5,
  lockoutMinutes: 30,
  ipFailThreshold: 20,
  ipFailWindowMinutes: 15,
  ipAutoblockMinutes: 60,
  alertNewIpSignIn: false,
  deviceLinkScope: "local",
  requireMfaOutside: false,
  abuseIpdbKey: "",
  reputationAutoEscalate: true,
  reputationEscalateThreshold: 90,
  trustedDeletesOnly: false
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

// Does the outside-MFA policy force a second factor on this sign-in? True only
// when the toggle is on and the request is not PROVABLY inside a trusted
// network. "Provably" is the point: behind a proxy with TRUST_PROXY_HOPS unset,
// request.ip is the proxy's own address, so a trusted-network match proves
// nothing — that case fails toward requiring the factor, the same direction
// deviceLinkAllowedFrom refuses in, because guessing wrong the other way would
// skip MFA for the whole internet. Per-request headers for the same reason as
// there: the process-wide forwarded-header flag is latching and spoofable.
export function mfaRequiredOutside(ip: string | null | undefined, headers: Record<string, unknown>): boolean {
  if (!getSecurityPolicy().requireMfaOutside) return false;
  if (hasForwardedHeader(headers) && getTrustProxyHops() === 0) return true;
  return !isTrustedIp(ip);
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

// ── Device linking ───────────────────────────────────────────────────────────

// May a device at this address ask to be linked? Answered here rather than at the
// route because the interesting half of it is about the deployment, not the caller.
//
// The 'proxy' refusal is the one worth understanding. Behind a reverse proxy with
// TRUST_PROXY_HOPS unset, request.ip is the proxy's own address — on Docker,
// something like 172.18.0.2 — so isPrivateIp says yes to every visitor on earth
// and a 'local' scope would silently permit the open internet. The server already
// warns about this at startup for the rate limiter and the auto-block, but those
// degrade toward noise; this one would degrade toward an open door, so it refuses
// instead. Fixing TRUST_PROXY_HOPS gets the feature back.
//
// The question is asked of THIS request's headers rather than the process-wide
// "a forwarded header has been seen" flag, which would be both too broad and
// abusable: that flag latches on for the process's lifetime, and any client can
// set X-Forwarded-For, so one curious device on the LAN could switch device
// linking off for the whole household until the next restart. Per-request is also
// simply more accurate — a header on someone else's earlier request says nothing
// about whether request.ip is trustworthy for this one.
export type DeviceLinkVerdict = { allowed: true } | { allowed: false; reason: "scope" | "proxy" };

export function deviceLinkAllowedFrom(
  ip: string | null | undefined,
  headers: Record<string, unknown>
): DeviceLinkVerdict {
  if (hasForwardedHeader(headers) && getTrustProxyHops() === 0) return { allowed: false, reason: "proxy" };
  if (getSecurityPolicy().deviceLinkScope === "any") return { allowed: true };
  if (!ip) return { allowed: false, reason: "scope" };
  return isTrustedIp(ip) || isPrivateIp(ip) ? { allowed: true } : { allowed: false, reason: "scope" };
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

// What a failed row actually was, so the auto-block can say what it counted:
// a real sign-in attempt (password, code, or passkey), a scanner probe path,
// or a share/API token or device code that matched nothing.
export type LoginAttemptKind = "signin" | "probe" | "token";

export function recordLoginAttempt(
  email: string | null,
  ip: string | null,
  successful: boolean,
  kind: LoginAttemptKind = "signin"
): void {
  db.prepare("INSERT INTO login_attempts (id, email, ip_address, successful, kind) VALUES (?, ?, ?, ?, ?)").run(
    nanoid(16),
    email ? email.toLowerCase() : null,
    ip ?? null,
    successful ? 1 : 0,
    kind
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
  // Judged by the same clock isIpBlocked enforces with, so the list can never
  // label a row Expired while requests are still being refused (or vice versa).
  expired: 0 | 1;
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

// True when this request must be refused under the deletions-only-from-trusted-
// networks policy (SecurityPolicy.trustedDeletesOnly, off by default). A DELETE
// route is destructive by definition; routes opt OUT with config.untrustedAllow
// (security-protective revocations a travelling user legitimately needs) and
// non-DELETE destroyers opt IN with config.destructive (Recycle Bin empty,
// duplicate-cleanup deletions, backup restore). Cheap gates first: the policy
// read hits the DB, so ordinary GET/POST traffic never pays for it.
export function deletionBlocked(method: string, routeConfig: unknown, ip: string | null | undefined): boolean {
  const cfg = (routeConfig ?? {}) as { untrustedAllow?: boolean; destructive?: boolean };
  const destructive = cfg.destructive === true || (method === "DELETE" && cfg.untrustedAllow !== true);
  if (!destructive) return false;
  if (!getSecurityPolicy().trustedDeletesOnly) return false;
  return !ip || !isTrustedIp(ip);
}

export function unblockIp(ip: string): boolean {
  return db.prepare("DELETE FROM blocked_ips WHERE ip_address = ?").run(ip).changes > 0;
}

// Strip the expiry from an existing block, keeping its reason and created_at as
// history. The row becomes a manual block owned by the acting admin: retention
// is now an administrative decision, so the list shows "Manual" while the
// preserved "Automatic: …" reason still says where it came from. Works on an
// already-expired row too — making it permanent re-arms the block, which is
// what an admin reviewing the log wants for a repeat offender (unblock is the
// undo, so no conflict ceremony).
export function makeIpBlockPermanent(ip: string, userId?: string | null): boolean {
  return (
    db
      .prepare(
        "UPDATE blocked_ips SET expires_at = NULL, auto = 0, created_by = COALESCE(?, created_by) WHERE ip_address = ?"
      )
      .run(userId ?? null, ip).changes > 0
  );
}

export function listBlockedIps(): BlockedIp[] {
  return db
    .prepare(
      `SELECT ip_address, reason, auto, created_at, expires_at,
              CASE WHEN expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now') THEN 1 ELSE 0 END AS expired
       FROM blocked_ips ORDER BY datetime(created_at) DESC`
    )
    .all() as BlockedIp[];
}

// A request that can only be a guess or a scan: a scanner probe path, or a share
// / API token that matches nothing at all. Recorded as a failed attempt with no
// email, so it feeds ONLY the per-IP auto-block below — accountFailureCount
// filters on email, so an anonymous hit can never help lock a real account.
export function recordAbuseAttempt(ip: string | null | undefined, kind: "probe" | "token"): void {
  if (!ip) return;
  recordLoginAttempt(null, ip, false, kind);
}

export interface IpFailureCounts {
  signin: number;
  probe: number;
  token: number;
  total: number;
}

function recentIpFailures(ip: string, windowMinutes: number): IpFailureCounts {
  const rows = db
    .prepare(
      `SELECT kind, COUNT(*) AS count FROM login_attempts
        WHERE ip_address = ? AND successful = 0 AND datetime(created_at) > datetime('now', ?)
        GROUP BY kind`
    )
    .all(ip, `-${windowMinutes} minutes`) as { kind: LoginAttemptKind; count: number }[];
  const counts: IpFailureCounts = { signin: 0, probe: 0, token: 0, total: 0 };
  for (const row of rows) {
    counts[row.kind] += row.count;
    counts.total += row.count;
  }
  return counts;
}

// "15 scanner probes and 6 failed sign-ins" — one phrase serving the block
// reason, the event log, and the admin email, so all three tell the same story.
export function describeIpFailures(counts: IpFailureCounts): string {
  const phrase = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (counts.probe) parts.push(phrase(counts.probe, "scanner probe", "scanner probes"));
  if (counts.token) parts.push(phrase(counts.token, "guessed token or code", "guessed tokens or codes"));
  if (counts.signin) parts.push(phrase(counts.signin, "failed sign-in", "failed sign-ins"));
  if (parts.length === 0) return "repeated suspicious requests";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export interface AutoBlockOutcome {
  description: string; // e.g. "15 scanner probes and 6 failed sign-ins"
  counts: IpFailureCounts;
}

// Auto-block an IP that has crossed the failure threshold. Returns what was
// counted when it newly blocks — so the caller can raise an alert exactly once,
// and the alert can say what actually happened — or null when nothing changed.
// The event log entry is written here rather than at the call sites, so every
// path that can trigger a block records it the same way.
export function maybeAutoBlockIp(ip: string | null | undefined): AutoBlockOutcome | null {
  if (!ip || isIpBlocked(ip)) return null;
  const policy = getSecurityPolicy();
  const counts = recentIpFailures(ip, policy.ipFailWindowMinutes);
  if (counts.total < policy.ipFailThreshold) return null;
  const description = describeIpFailures(counts);
  blockIp(ip, {
    reason: `Automatic: ${description} in ${policy.ipFailWindowMinutes} min`,
    auto: true,
    minutes: policy.ipAutoblockMinutes
  });
  logActivity({
    event: "security.ip_autoblocked",
    detail: `Blocked ${ip} for ${policy.ipAutoblockMinutes} minutes after ${description} within ${policy.ipFailWindowMinutes} minutes.`,
    ipAddress: ip
  });
  return { description, counts };
}
