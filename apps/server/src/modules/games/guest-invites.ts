// Guest links into the games (docs/games-platform-plan.md → Guests): a member
// invites someone with no account here to ONE online match. The link carries a
// random token; opening it sets a guest cookie, and from then on the gateway
// forwards a guest identity — role "guest", an id of this server's choosing,
// the name the inviter typed — scoped to that one match by a header the games
// server honours. Everything about the guest lives in this table: the home
// server owns identity, the games server only ever sees what the gateway signs.
//
// Only sha256(token) is stored, as for sessions, share links and API tokens;
// the link is shown once, and "renew" mints a new token (the old link dies, the
// guest id and the match stay). A revoked or expired row answers nothing.
import { customAlphabet, nanoid } from "nanoid";
import { config } from "../../config.js";
import { db, logActivity, type User } from "../../db.js";
import { sha256 } from "../../crypto.js";
import { hostCookieName } from "../../core/cookies.js";
import type { GamesGuestInviteRow } from "../../db/rows.js";
import type { ForwardedRequest } from "./gateway.js";

/** The cookie a guest's browser carries after opening the link: the raw token. */
export const GUEST_COOKIE = hostCookieName("isputnik_guest", config.cookieSecure);

/** Where a link points: /games/guest/<token>, a route of this server (a literal,
 *  not GAMES_PREFIX: gateway.ts imports this module, so this one only type-imports it). */
export const GUEST_LINK_PATH = "/games/guest";

/** How long a link lives; the games' own unanswered invitations expire in 14 days too. */
export const GUEST_INVITE_DAYS = 14;

/** The games server tells a guest's id by this prefix (its identity.ts agrees). */
export const GUEST_ID_PREFIX = "guest_";

/** Rows that are over (revoked, or expired) are kept this long for the list, then swept. */
const KEEP_ENDED_DAYS = 30;

/** A row minted but never bound to a match (the games call failed mid-way) is swept after this. */
const UNBOUND_MINUTES = 10;

/** How often a proxied request refreshes last_seen_at: a match page polls every
 *  few seconds, and one write a minute says enough. */
const SEEN_EVERY_SECONDS = 60;

// 32 characters over 62 symbols: ~190 bits, the same budget as an API token.
const tokenBody = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 32);
const guestIdBody = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export type GuestInviteState = "live" | "expired" | "revoked" | "pending";

/** What the inviter and the admin see of a link — never the token. */
export interface GuestInvite {
  id: string;
  guestId: string;
  guestName: string;
  game: string;
  matchId: string | null;
  createdBy: { id: string; name: string };
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  openedCount: number;
  firstOpenedAt: string | null;
  lastSeenAt: string | null;
  lastIp: string | null;
  state: GuestInviteState;
}

/** The identity the gateway forwards for a guest's request. */
export interface GuestIdentity {
  inviteId: string;
  guestId: string;
  guestName: string;
  matchId: string;
  game: string;
  expiresAt: string;
  /** The inviter's interface language: the guest has none of their own on record. */
  lang: string;
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function stateOf(row: Pick<GamesGuestInviteRow, "revoked_at" | "expires_at" | "match_id">): GuestInviteState {
  if (row.revoked_at) return "revoked";
  if (!row.match_id) return "pending";
  return row.expires_at > new Date().toISOString() ? "live" : "expired";
}

type ListedRow = GamesGuestInviteRow & { creator_name: string | null };

function publicInvite(row: ListedRow): GuestInvite {
  return {
    id: row.id,
    guestId: row.guest_id,
    guestName: row.guest_name,
    game: row.game,
    matchId: row.match_id,
    createdBy: { id: row.created_by, name: row.creator_name ?? row.created_by },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    openedCount: row.opened_count,
    firstOpenedAt: row.first_opened_at,
    lastSeenAt: row.last_seen_at,
    lastIp: row.last_ip,
    state: stateOf(row)
  };
}

const SELECT = `
  SELECT games_guest_invites.*, users.display_name AS creator_name
  FROM games_guest_invites
  LEFT JOIN users ON users.id = games_guest_invites.created_by
`;

/** The link a guest opens. APP_URL is the operator's statement of how the app is reached. */
export function guestLinkUrl(token: string): string {
  return `${config.appUrl.replace(/\/+$/, "")}${GUEST_LINK_PATH}/${token}`;
}

/** A well-formed guest id, as this server mints them. */
export function isGuestId(id: string): boolean {
  return id.startsWith(GUEST_ID_PREFIX) && /^guest_[0-9a-z]{12}$/.test(id);
}

/** The guest's name as it will be shown: one line, trimmed, bounded. */
export function normalizeGuestName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * Step one of minting: the row, without its match yet. The caller creates the
 * match on the games server with `guestId` as the opponent, then binds it
 * (bindGuestInvite) — or discards the row (discardGuestInvite) if that failed.
 * The raw token is returned once and never stored.
 */
export function mintGuestInvite(input: { userId: string; guestName: string; game: string }): { id: string; guestId: string; token: string; expiresAt: string } {
  sweepGuestInvites();
  const id = nanoid(16);
  const guestId = `${GUEST_ID_PREFIX}${guestIdBody()}`;
  const token = tokenBody();
  const expiresAt = daysFromNow(GUEST_INVITE_DAYS);
  db.prepare(`
    INSERT INTO games_guest_invites (id, token_hash, guest_id, guest_name, game, created_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, sha256(token), guestId, input.guestName, input.game, input.userId, expiresAt);
  return { id, guestId, token, expiresAt };
}

export function bindGuestInvite(id: string, matchId: string): void {
  db.prepare("UPDATE games_guest_invites SET match_id = ? WHERE id = ?").run(matchId, id);
}

export function discardGuestInvite(id: string): void {
  db.prepare("DELETE FROM games_guest_invites WHERE id = ?").run(id);
}

export function getGuestInvite(id: string): GuestInvite | null {
  const row = db.prepare(`${SELECT} WHERE games_guest_invites.id = ?`).get(id) as ListedRow | undefined;
  return row ? publicInvite(row) : null;
}

/** A guest's identity for a raw token (the cookie's value), or null when the
 *  link is unknown, revoked, expired, never bound, or its inviter is gone. */
export function resolveGuestToken(token: string | undefined): GuestIdentity | null {
  if (!token || token.length > 64) return null;
  const row = db.prepare(`
    SELECT games_guest_invites.*, users.language AS creator_lang
    FROM games_guest_invites
    JOIN users ON users.id = games_guest_invites.created_by
    WHERE games_guest_invites.token_hash = ?
      AND games_guest_invites.revoked_at IS NULL
      AND games_guest_invites.match_id IS NOT NULL
      AND games_guest_invites.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND users.deleted_at IS NULL
      AND users.is_active = 1
  `).get(sha256(token)) as (GamesGuestInviteRow & { creator_lang: string }) | undefined;
  if (!row) return null;
  return { inviteId: row.id, guestId: row.guest_id, guestName: row.guest_name, matchId: row.match_id!, game: row.game, expiresAt: row.expires_at, lang: row.creator_lang };
}

/** Whether a token names a row at all, live or not: an unknown token is a guess
 *  (counted against its source address); a dead one is a guest with an old link. */
export function guestTokenKnown(token: string): boolean {
  if (!token || token.length > 64) return false;
  const hash = sha256(token);
  return Boolean(db.prepare("SELECT 1 FROM games_guest_invites WHERE token_hash = ? OR previous_token_hash = ?").get(hash, hash));
}

/** The link was opened: count it, and record where from. */
export function noteGuestOpened(inviteId: string, ip: string | null): void {
  db.prepare(`
    UPDATE games_guest_invites
    SET opened_count = opened_count + 1,
        first_opened_at = COALESCE(first_opened_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        last_ip = ?
    WHERE id = ?
  `).run(ip, inviteId);
}

/** A proxied request from the guest: refresh last_seen_at, at most once a minute. */
export function touchGuest(inviteId: string, ip: string | null): void {
  db.prepare(`
    UPDATE games_guest_invites
    SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_ip = ?
    WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))
  `).run(ip, inviteId, `-${SEEN_EVERY_SECONDS} seconds`);
}

/** A fresh token and a fresh fortnight for the same guest and match; the old link dies. */
export function renewGuestInvite(id: string): { token: string; expiresAt: string } | null {
  const token = tokenBody();
  const expiresAt = daysFromNow(GUEST_INVITE_DAYS);
  const result = db.prepare(`
    UPDATE games_guest_invites
    SET previous_token_hash = token_hash, token_hash = ?, expires_at = ?, revoked_at = NULL, revoked_by = NULL
    WHERE id = ? AND match_id IS NOT NULL
  `).run(sha256(token), expiresAt, id);
  return result.changes ? { token, expiresAt } : null;
}

export function revokeGuestInvite(id: string, byUserId: string): boolean {
  const result = db.prepare(`
    UPDATE games_guest_invites SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_by = ?
    WHERE id = ? AND revoked_at IS NULL
  `).run(byUserId, id);
  return result.changes > 0;
}

/** A member's own links, or every member's for an admin; optionally one match's. */
export function listGuestInvites(filter: { userId?: string; matchId?: string }): GuestInvite[] {
  sweepGuestInvites();
  const conditions: string[] = ["games_guest_invites.match_id IS NOT NULL"];
  const params: string[] = [];
  if (filter.userId) {
    conditions.push("games_guest_invites.created_by = ?");
    params.push(filter.userId);
  }
  if (filter.matchId) {
    conditions.push("games_guest_invites.match_id = ?");
    params.push(filter.matchId);
  }
  const rows = db.prepare(`${SELECT} WHERE ${conditions.join(" AND ")} ORDER BY games_guest_invites.created_at DESC`).all(...params) as ListedRow[];
  return rows.map(publicInvite);
}

/** Housekeeping on the way past: rows that are long over, and rows that never got a match. */
export function sweepGuestInvites(): void {
  db.prepare(`
    DELETE FROM games_guest_invites
    WHERE (revoked_at IS NOT NULL AND revoked_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))
       OR (expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))
       OR (match_id IS NULL AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))
  `).run(`-${KEEP_ENDED_DAYS} days`, `-${KEEP_ENDED_DAYS} days`, `-${UNBOUND_MINUTES} minutes`);
}

/** The headers that tell the games server a guest is asking: the same set a
 *  member gets, with role "guest" and the one match the identity is good for. */
export function guestIdentityHeaders(guest: GuestIdentity, secret: string, forwarded: ForwardedRequest): Record<string, string> {
  return {
    "x-isputnik-gateway": secret,
    "x-isputnik-user-id": guest.guestId,
    "x-isputnik-user-name": encodeURIComponent(guest.guestName),
    "x-isputnik-user-role": "guest",
    "x-isputnik-user-lang": guest.lang,
    "x-isputnik-user-theme": "system",
    "x-isputnik-guest-match": guest.matchId,
    "x-isputnik-client-ip": forwarded.ip,
    "x-isputnik-request-id": forwarded.requestId
  };
}

/** One line in the activity log for everything a link goes through; the actor is
 *  the member acting, or nobody when it is the guest opening the link. */
export function logGuestInviteEvent(
  event: "created" | "opened" | "renewed" | "revoked",
  invite: { id: string; guestName: string; game: string },
  actor: User | null,
  ip: string | null,
  extra = ""
): void {
  const who = actor ? actor.display_name : "The guest";
  const what = {
    created: `${who} invited ${invite.guestName} to a ${invite.game} match by guest link.`,
    opened: `${invite.guestName} opened the guest link to the ${invite.game} match.`,
    renewed: `${who} made a new guest link for ${invite.guestName} (${invite.game}); the old link no longer works.`,
    revoked: `${who} revoked the guest link for ${invite.guestName} (${invite.game}).`
  }[event];
  logActivity({
    event: `games.guest_invite.${event}`,
    actorUserId: actor?.id ?? null,
    targetType: "games_guest_invite",
    targetId: invite.id,
    detail: extra ? `${what} ${extra}` : what,
    ipAddress: ip
  });
}

// ── The page a dead link gets ───────────────────────────────────────────────
// A browser navigating with an expired, revoked or unknown link would otherwise
// see a line of JSON. The sign-in screen is wrong for them — they have no
// account — so this says the one useful thing: ask whoever sent the link for a
// new one. Inline styles, like the blocked page: it must stand on its own.

const INVALID_LINK_COPY: Record<string, { title: string; body: string; hint: string }> = {
  en: {
    title: "This game link no longer works",
    body: "The invitation may have expired, or the person who sent it may have withdrawn it.",
    hint: "Ask them for a new link."
  },
  ru: {
    title: "Эта ссылка на игру больше не работает",
    body: "Срок приглашения мог истечь, или отправитель его отозвал.",
    hint: "Попросите прислать новую ссылку."
  }
};

export function invalidLinkPage(lang: string): string {
  const copy = INVALID_LINK_COPY[lang] ?? INVALID_LINK_COPY.en;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html>
<html lang="${lang === "ru" ? "ru" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(copy.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f4f4f5; color: #18181b;
  }
  main { max-width: 26rem; padding: 2.5rem 1.5rem; text-align: center; }
  .badge {
    width: 3.5rem; height: 3.5rem; margin: 0 auto 1.25rem; border-radius: 50%;
    display: grid; place-items: center; font-size: 1.6rem;
    background: #e4e4e7; color: #3f3f46;
  }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 0.75rem; line-height: 1.55; color: #52525b; }
  @media (prefers-color-scheme: dark) {
    body { background: #18181b; color: #fafafa; }
    .badge { background: #27272a; color: #d4d4d8; }
    p { color: #a1a1aa; }
  }
</style>
</head>
<body>
<main>
  <div class="badge" aria-hidden="true">&#x1F517;</div>
  <h1>${esc(copy.title)}</h1>
  <p>${esc(copy.body)}</p>
  <p>${esc(copy.hint)}</p>
</main>
</body>
</html>`;
}

/** The language for a page a guest sees: the inviter's when the link is known, else the browser's. */
export function pageLanguage(acceptLanguage: string | undefined, preferred?: string): string {
  if (preferred && INVALID_LINK_COPY[preferred]) return preferred;
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().slice(0, 2).toLowerCase();
  return first && INVALID_LINK_COPY[first] ? first : "en";
}
