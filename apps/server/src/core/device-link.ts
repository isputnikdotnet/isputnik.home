import { customAlphabet, nanoid } from "nanoid";
import { db } from "../db.js";
import { sha256 } from "../crypto.js";
import { isPrivateIp } from "./cidr.js";
import { deviceLinkAllowedFrom, isTrustedIp } from "./security.js";

// Link a device: signing a TV, wall display or kiosk in by scanning a QR code with
// a phone that is already signed in, instead of typing a password with a remote
// control. The OAuth 2.0 device-authorization shape (RFC 8628), narrowed to one
// household. Table DDL and the reasoning behind its columns are in schema.sql.
//
// Service functions live here and are unit-tested directly; the routes in
// device-link-routes.ts are thin wrappers adding rate limits, the password gate,
// logging and alerts — the same split as mfa.ts / mfa-routes.ts.
//
// The security model in one line: holding a code proves nothing. The code names a
// pending request; approving it takes a signed-in account and that account's
// password, and the request can only be created from inside the house (see
// deviceLinkAllowedFrom in security.ts). What the flow is really defending against
// is a stranger starting a request remotely and talking a household member into
// approving it — hence that check, and hence the confirmation screen showing the
// code to compare against the one on the screen across the room.

/** How long a request may sit unapproved. Long enough to walk to another room. */
const EXPIRY_MINUTES = 10;

// Once approved, the device has this long to actually collect its session. It polls
// every few seconds so it will normally take milliseconds; the window exists so an
// approval a moment before expiry isn't wasted, and it is short because an approved
// request is a session waiting to be picked up by whoever holds the device code.
const REDEEM_GRACE_MINUTES = 5;

/** Wrong passwords on the confirmation screen before the request is dead. */
const MAX_ATTEMPTS = 5;

/** What the device is told to wait between polls. */
export const POLL_INTERVAL_SECONDS = 3;

// The unambiguous alphabet the MFA backup codes use — no 0/O, 1/I/L — for the same
// reason, doubled here: this code is read off a television from across a room.
// 8 characters over 31 symbols is a little under 40 bits.
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const USER_CODE_LENGTH = 8;
const userCodeBody = customAlphabet(USER_CODE_ALPHABET, USER_CODE_LENGTH);

export type LinkRequestStatus = "pending" | "approved" | "denied" | "consumed";

export interface LinkRequestRow {
  id: string;
  device_code_hash: string;
  user_code: string;
  status: LinkRequestStatus;
  created_at: string;
  expires_at: string;
  attempts: number;
  user_agent: string | null;
  ip_address: string | null;
  approved_by: string | null;
  approved_at: string | null;
  session_id: string | null;
  /** 1 when the request came from outside the house — see device_link_windows. */
  remote: 0 | 1;
}

export interface NewLinkRequest {
  id: string;
  /** The device's secret. Returned once, never stored — only its hash is. */
  deviceCode: string;
  /** Canonical (bare) form, for lookups and URLs. */
  userCode: string;
  /** Grouped form, for reading aloud and off a screen. */
  userCodeDisplay: string;
  expiresAt: string;
}

/** "K7M4PQ2N" → "K7M4-PQ2N". Display only; the stored form is always bare. */
export function formatUserCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

// Strip formatting so a code matches whether the user types the dash or not, and in
// any case. Same treatment normalizeBackupCode gives an MFA backup code — and
// deliberately no character substitution: 0/O and 1/I/L are absent from the
// alphabet, so a code containing one was mistyped, and quietly "correcting" it
// would turn a typo into a lookup for a different device's code.
export function normalizeUserCode(input: string): string {
  return input.replace(/[^0-9a-z]/gi, "").toUpperCase();
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * Open a request. The caller supplies what it knows about the asking device; both
 * are recorded to be shown on the confirmation screen and neither is trusted —
 * `userAgent` is client-supplied text, so it is capped here and rendered as text
 * there. There is deliberately no client-supplied device *name*: the owner names
 * the device afterwards, from their own device list.
 */
export function createLinkRequest(
  opts: { userAgent?: string | null; ip?: string | null; remote?: boolean } = {}
): NewLinkRequest {
  const id = nanoid(16);
  const deviceCode = nanoid(48);
  const expiresAt = minutesFromNow(EXPIRY_MINUTES);
  const userAgent = opts.userAgent ? opts.userAgent.slice(0, 200) : null;

  const insert = db.prepare(`
    INSERT INTO device_link_requests (id, device_code_hash, user_code, expires_at, user_agent, ip_address, remote)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // user_code is UNIQUE and short, so a collision with another live request is
  // rare but not impossible. Retry rather than handing the household an error for
  // something it can neither understand nor act on.
  let userCode = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    userCode = userCodeBody();
    try {
      insert.run(id, sha256(deviceCode), userCode, expiresAt, userAgent, opts.ip ?? null, opts.remote ? 1 : 0);
      return { id, deviceCode, userCode, userCodeDisplay: formatUserCode(userCode), expiresAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (!message.includes("UNIQUE") || attempt === 4) throw err;
    }
  }
  // Unreachable: the loop either returns or rethrows on its last turn.
  throw new Error("Could not allocate a device code");
}

// Has this code ever named a request here — live, spent, or long over? The
// difference between a guess and a family member being slow, which decides whether
// a miss counts against the caller's IP. Same distinction isUnknownApiToken draws
// for OPDS tokens and share links.
export function userCodeExists(code: string): boolean {
  const normalized = normalizeUserCode(code);
  if (normalized.length !== USER_CODE_LENGTH) return false;
  return Boolean(db.prepare("SELECT 1 FROM device_link_requests WHERE user_code = ?").get(normalized));
}

// A live request by its short code: pending, unexpired, and not talked to death on
// the confirmation screen. The single place "is this request still open?" is
// decided, so no caller can accidentally answer it differently.
export function findPendingByUserCode(code: string): LinkRequestRow | null {
  const normalized = normalizeUserCode(code);
  if (normalized.length !== USER_CODE_LENGTH) return null;
  const row = db.prepare(`
    SELECT * FROM device_link_requests
    WHERE user_code = ?
      AND status = 'pending'
      AND datetime(expires_at) > datetime('now')
      AND attempts < ?
  `).get(normalized, MAX_ATTEMPTS) as LinkRequestRow | undefined;
  return row ?? null;
}

/**
 * A wrong password on the confirmation screen. Returns the attempts remaining; at
 * zero the request is finished, and findPendingByUserCode stops returning it.
 */
export function noteFailedApproval(id: string): number {
  db.prepare("UPDATE device_link_requests SET attempts = attempts + 1 WHERE id = ?").run(id);
  const row = db.prepare("SELECT attempts FROM device_link_requests WHERE id = ?").get(id) as
    | { attempts: number }
    | undefined;
  return Math.max(0, MAX_ATTEMPTS - (row?.attempts ?? MAX_ATTEMPTS));
}

// Approve / deny are conditional on the row still being pending, so two phones
// racing on the same code cannot both win, and neither can revive a request that
// expired between the screen loading and the button being pressed.
export function approveLinkRequest(id: string, userId: string): boolean {
  return db.prepare(`
    UPDATE device_link_requests
       SET status = 'approved',
           approved_by = ?,
           approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?
       AND status = 'pending'
       AND datetime(expires_at) > datetime('now')
  `).run(userId, id).changes > 0;
}

export function denyLinkRequest(id: string): boolean {
  return db.prepare("UPDATE device_link_requests SET status = 'denied' WHERE id = ? AND status = 'pending'")
    .run(id).changes > 0;
}

export type PollOutcome =
  /** No such device code has ever existed here — a guess, or a scan. */
  | { status: "unknown" }
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  /** Already redeemed (or claimed by a racing poll of this same device). */
  | { status: "consumed" }
  /** Approved AND claimed by this call: the caller now owes it a session. */
  | { status: "approved"; row: LinkRequestRow };

/**
 * The device asking "am I in yet?".
 *
 * An `approved` outcome is returned to exactly one caller: the status moves to
 * `consumed` in the same breath. That makes redemption single-use under a double
 * poll without the route having to remember to do anything, and it means a caller
 * holding this result has already spent it — it must issue the session and call
 * attachSession, or the request is burnt and the device starts over. Burnt is the
 * safe direction, so this is deliberate.
 */
export function pollLinkRequest(rawDeviceCode: string): PollOutcome {
  if (!rawDeviceCode) return { status: "unknown" };
  const row = db.prepare("SELECT * FROM device_link_requests WHERE device_code_hash = ?")
    .get(sha256(rawDeviceCode)) as LinkRequestRow | undefined;
  if (!row) return { status: "unknown" };

  if (row.status === "denied") return { status: "denied" };
  if (row.status === "consumed") return { status: "consumed" };

  if (row.status === "pending") {
    return isPast(row.expires_at) ? { status: "expired" } : { status: "pending" };
  }

  // Approved. The clock that matters now is the redemption grace, not the original
  // expiry — the approval already happened, and the device is only collecting.
  if (row.approved_at && isPast(addMinutes(row.approved_at, REDEEM_GRACE_MINUTES))) {
    return { status: "expired" };
  }

  const claimed = db.prepare(
    "UPDATE device_link_requests SET status = 'consumed' WHERE id = ? AND status = 'approved'"
  ).run(row.id).changes > 0;
  return claimed ? { status: "approved", row } : { status: "consumed" };
}

/** Record which session a claimed request became, for the audit trail. */
export function attachSession(id: string, sessionId: string): void {
  db.prepare("UPDATE device_link_requests SET session_id = ? WHERE id = ?").run(sessionId, id);
}

// Nothing else in this app purges anything — expired sessions are simply ignored by
// the auth check — but those are a handful per household and these are one per
// attempt, including every abandoned one. Called at startup; an hour of slack past
// expiry keeps a just-finished request around long enough to be looked at.
export function sweepLinkRequests(): number {
  return db.prepare("DELETE FROM device_link_requests WHERE datetime(expires_at) < datetime('now', '-1 hour')")
    .run().changes;
}

// ── Registration windows (linking from outside the house) ────────────────────
//
// Linking is refused from outside by default, and the app doesn't offer it there.
// The exception is a window: an administrator turns it on for ONE person for an
// hour, and the first device they link closes it. That shape is deliberate — the
// setting it replaces (deviceLinkScope: "any") is a door with no name on it and no
// closing time.
//
// Windows are per user because nothing in this flow can identify a device before
// it exists: the request is created by an anonymous caller. So the window is
// checked twice, in two different senses — "is anyone allowed to ask from out
// there?" when the request is created, and "is it YOU who is allowed?" at
// approval, which is the step that has an identity and a password behind it.

// How long a window may stay open. The admin picks, within a range whose upper
// bound is the point: an hour is long enough to walk someone through setting up a
// screen, and short enough that forgetting about it costs nothing. There is no way
// to ask for a day.
export const MIN_WINDOW_MINUTES = 1;
export const MAX_WINDOW_MINUTES = 60;
export const DEFAULT_WINDOW_MINUTES = 60;

/** Clamp to the range and to whole minutes; anything unusable falls to the default. */
export function normalizeWindowMinutes(minutes: number | undefined | null): number {
  if (!Number.isFinite(minutes ?? NaN)) return DEFAULT_WINDOW_MINUTES;
  return Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, Math.round(minutes as number)));
}

export interface LinkWindowRow {
  id: string;
  user_id: string;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  session_id: string | null;
  revoked_at: string | null;
}

// Liveness is derived every time, never stored, for the same reason the request
// table has no 'expired' status: a stored state has to be swept to become true.
// One clause, used by every question below, so they can't drift apart.
const LIVE_WINDOW = `
  used_at IS NULL
  AND revoked_at IS NULL
  AND datetime(expires_at) > datetime('now')
`;

/**
 * Open a window for one person, for `minutes` (clamped to 1–60, defaulting to 60).
 * Replaces any window they already have rather than stacking a second one, so "how
 * long have I got?" has exactly one answer.
 */
export function openLinkWindow(userId: string, createdBy: string | null, minutes?: number): LinkWindowRow {
  const id = nanoid(16);
  const life = normalizeWindowMinutes(minutes);
  db.transaction(() => {
    db.prepare(
      `UPDATE device_link_windows SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_id = ? AND ${LIVE_WINDOW}`
    ).run(userId);
    db.prepare(
      "INSERT INTO device_link_windows (id, user_id, created_by, expires_at) VALUES (?, ?, ?, ?)"
    ).run(id, userId, createdBy, minutesFromNow(life));
  })();
  return db.prepare("SELECT * FROM device_link_windows WHERE id = ?").get(id) as LinkWindowRow;
}

/** This person's live window, or null. The "is it YOU?" half, asked at approval. */
export function liveWindowFor(userId: string): LinkWindowRow | null {
  return (db
    .prepare(`SELECT * FROM device_link_windows WHERE user_id = ? AND ${LIVE_WINDOW}`)
    .get(userId) as LinkWindowRow | undefined) ?? null;
}

/**
 * Is anyone at all allowed to ask from outside right now? The "may this request
 * even be created?" half — the device is anonymous at that point, so this is the
 * most that can be known. Being generous here costs little: a request nobody with
 * a window approves is inert and expires in ten minutes having done nothing.
 */
export function anyLiveWindow(): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM device_link_windows WHERE ${LIVE_WINDOW} LIMIT 1`).get());
}

/** A device linked against this window: it is spent. */
export function closeLinkWindow(id: string, sessionId: string | null): void {
  db.prepare(
    `UPDATE device_link_windows
        SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), session_id = ?
      WHERE id = ? AND used_at IS NULL`
  ).run(sessionId, id);
}

/** The admin closing one early. Returns false when there was nothing open. */
export function revokeLinkWindow(userId: string): boolean {
  return db.prepare(
    `UPDATE device_link_windows SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_id = ? AND ${LIVE_WINDOW}`
  ).run(userId).changes > 0;
}

/** Every window open right now, for the admin's user list. */
export function listLiveWindows(): LinkWindowRow[] {
  return db.prepare(`SELECT * FROM device_link_windows WHERE ${LIVE_WINDOW}`).all() as LinkWindowRow[];
}

/** Spent and expired windows, swept beside the requests at startup. */
export function sweepLinkWindows(): number {
  return db.prepare(
    "DELETE FROM device_link_windows WHERE datetime(expires_at) < datetime('now', '-1 day')"
  ).run().changes;
}

// ── May this device ask to be linked? ────────────────────────────────────────

/**
 * The whole question, in one place: where the caller is, whether the deployment
 * can tell, and whether a window is open.
 *
 * This layers over deviceLinkAllowedFrom rather than living inside it. security.ts
 * is platform infrastructure with no product knowledge — it knows about trusted
 * networks and proxy configuration, and it should not learn about registration
 * windows. It also cannot: device-link.ts already imports it, so the dependency
 * only runs one way without a cycle.
 *
 * A live window overrides BOTH refusals, including the misconfigured-proxy one.
 * That refusal exists because "local" is unknowable in that state; a window says
 * location does not matter for the next hour, which makes the question moot. The
 * startup warning and the Policies-page warning both remain.
 */
export type DeviceLinkAccess =
  | { allowed: true; remote: boolean }
  | { allowed: false; reason: "scope" | "proxy" };

export function deviceLinkAccess(ip: string | null | undefined, headers: Record<string, unknown>): DeviceLinkAccess {
  const local = deviceLinkAllowedFrom(ip, headers);
  if (local.allowed) return { allowed: true, remote: false };
  if (anyLiveWindow()) return { allowed: true, remote: true };
  return local;
}

// ── Describing a device to its owner ─────────────────────────────────────────

// A user agent is a long, hostile string that means nothing to a household. This
// renders the two facts someone can actually check against the thing in front of
// them — roughly which browser, roughly which machine — and is deliberately
// shallow: it is a label on a confirmation screen, not analytics, and being
// approximately right beats a parser that has to be maintained. Order matters
// (Edge and Chrome both say "Chrome"); anything unrecognised says so plainly.
const BROWSERS: [RegExp, string][] = [
  [/\bEdg[eA-Z]?\//, "Edge"],
  [/\bOPR\/|\bOpera\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\//, "Firefox"],
  [/\bChrome\//, "Chrome"],
  [/\bSafari\//, "Safari"]
];

const PLATFORMS: [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"]
];

// What KIND of thing this is, for counting rather than describing: a household
// wants "two displays, three phones" without reading a user agent. Same shallow
// spirit as the tables above — a linked display is known from the session kind,
// the rest is a guess from the agent, and anything unclear says so.
export type DeviceType = "display" | "phone" | "tablet" | "computer" | "unknown";

export function deviceType(userAgent: string | null | undefined, kind: "browser" | "device" = "browser"): DeviceType {
  if (kind === "device") return "display";
  if (!userAgent) return "unknown";
  const android = /Android/i.test(userAgent);
  const mobile = /Mobile/i.test(userAgent);
  // Android says "Android" on both a phone and a tablet; only a phone adds
  // "Mobile", which is the one distinction worth making without a real parser.
  if (/iPad|Tablet|Kindle|Silk/i.test(userAgent) || (android && !mobile)) return "tablet";
  if (/iPhone|iPod|Windows Phone/i.test(userAgent) || android || mobile) return "phone";
  if (/Windows|Mac OS X|Macintosh|CrOS|Linux/i.test(userAgent)) return "computer";
  return "unknown";
}

function firstMatch(ua: string, table: [RegExp, string][]): string | null {
  for (const [pattern, name] of table) if (pattern.test(ua)) return name;
  return null;
}

export function describeUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return "An unknown device";
  const browser = firstMatch(userAgent, BROWSERS);
  const platform = firstMatch(userAgent, PLATFORMS);
  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform ?? "An unknown device";
}

// Where the asking device is, in words the household uses. Deliberately only two
// answers plus the bare address: this server makes no outbound calls, so there is
// no geolocation to be had, and inventing a friendlier label than the truth is
// exactly the wrong move on a screen whose whole job is "does this look right?".
export function describeNetwork(ip: string | null | undefined): string {
  if (!ip) return "An unknown network";
  if (isTrustedIp(ip)) return "A trusted network";
  if (isPrivateIp(ip)) return "Your home network";
  return ip;
}

function isPast(iso: string): boolean {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? true : at <= Date.now();
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}
