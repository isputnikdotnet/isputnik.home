// Phones — one `photo-sync` device token per phone (docs/photo-sync-plan.md, decision 6,
// phase 2).
//
// A token is minted by core/api-tokens.ts (hashed at rest, shown once) with scope
// `photo-sync`, the phone's name as its label, and `library_id` binding it to its
// owner's personal library. It is the Basic-auth password; the user name is the
// member's login, for display only. The account password is never accepted.
//
// Every request re-checks everything (`authenticatePhone`): the token is live, its
// member is active, the library it is bound to is still their live personal library,
// and the request comes from a phone-sync network. So a revoked phone, a removed
// member, an orphaned or deleted library, or a network taken off the list stops the
// phone at once. Revoking on those events too (below) keeps the Phones list honest.
import type { FastifyRequest } from "fastify";
import { db, logActivity, type User } from "../../../../db.js";
import { sha256 } from "../../../../crypto.js";
import { createApiToken, isUnknownApiToken } from "../../../../core/api-tokens.js";
import { flagAbusiveRequest } from "../../../../core/security-alerts.js";
import { personalLibraryIdOf } from "../personal/personal-libraries.js";
import { syncGateVerdict, syncNetworkOf } from "./networks.js";
import { notePhonePasswordRefused, phoneOfRawToken, recordPhoneProblem, resolvePhoneProblem } from "./status.js";
import type { ApiTokenRow } from "../../../../db/rows.js";

export const PHONE_SCOPE = "photo-sync";
/** Phones one member may have at a time. */
export const MAX_PHONES = 20;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export class PhoneError extends Error {
  constructor(message: string, readonly statusCode = 409, readonly code = "refused") {
    super(message);
  }
}

export type Phone = Pick<ApiTokenRow, "id" | "label" | "created_at" | "last_seen_at" | "last_ip">;

/** A member's live phones, newest first. Never the secret. */
export function listPhones(userId: string): Phone[] {
  return db.prepare(`
    SELECT id, label, created_at, last_seen_at, last_ip FROM api_tokens
    WHERE user_id = ? AND scope = ? AND revoked_at IS NULL
    ORDER BY created_at DESC
  `).all(userId, PHONE_SCOPE) as Phone[];
}

/** Every member's live phones, for the admin's Security › Phone sync — with whose each
 *  one is and the library it backs up into. Never the secret. */
export function listAllPhones(): Array<Phone & { user_id: string; user_name: string; library_id: string | null }> {
  return db.prepare(`
    SELECT t.id, t.label, t.created_at, t.last_seen_at, t.last_ip, t.user_id, t.library_id, u.display_name AS user_name
    FROM api_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.scope = ? AND t.revoked_at IS NULL
    ORDER BY u.display_name COLLATE NOCASE, t.created_at DESC
  `).all(PHONE_SCOPE) as Array<Phone & { user_id: string; user_name: string; library_id: string | null }>;
}

/** Add a phone: a token bound to the member's live personal library. Returns the raw
 *  token, which the caller shows once. */
export function addPhone(user: { id: string }, label: string, ip: string | null): { id: string; raw: string; libraryId: string } {
  const libraryId = personalLibraryIdOf(user.id);
  if (!libraryId) throw new PhoneError("Turn on your personal library before adding a phone.", 409, "no_library");
  const name = label.trim();
  if (!name) throw new PhoneError("Give the phone a name.", 400, "no_label");
  const count = (db.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND scope = ? AND revoked_at IS NULL")
    .get(user.id, PHONE_SCOPE) as { n: number }).n;
  if (count >= MAX_PHONES) throw new PhoneError(`You can have at most ${MAX_PHONES} phones. Remove one first.`, 409, "too_many");
  const taken = db.prepare("SELECT 1 FROM api_tokens WHERE user_id = ? AND scope = ? AND revoked_at IS NULL AND label = ? COLLATE NOCASE")
    .get(user.id, PHONE_SCOPE, name);
  if (taken) throw new PhoneError("You already have a phone with that name.", 409, "label_taken");

  const { id, raw } = createApiToken(user.id, name, PHONE_SCOPE, libraryId);
  logActivity({
    event: "photo_sync.phone_added",
    actorUserId: user.id,
    targetType: "user",
    targetId: user.id,
    detail: `Added a phone for backup ("${name}").`,
    ipAddress: ip
  });
  return { id, raw, libraryId };
}

/** The member revokes one of their phones, or an admin does from the member's page
 *  (actorId). Always allowed — revoking protects. */
export function revokePhone(userId: string, id: string, ip: string | null, actorId: string = userId): boolean {
  const row = db.prepare("SELECT label FROM api_tokens WHERE id = ? AND user_id = ? AND scope = ? AND revoked_at IS NULL")
    .get(id, userId, PHONE_SCOPE) as Pick<ApiTokenRow, "label"> | undefined;
  if (!row) return false;
  db.prepare(`UPDATE api_tokens SET revoked_at = ${NOW} WHERE id = ?`).run(id);
  logActivity({
    event: "photo_sync.phone_revoked",
    actorUserId: actorId,
    targetType: "user",
    targetId: userId,
    detail: `Revoked a phone${row.label ? ` ("${row.label}")` : ""}${actorId === userId ? "" : " for a member"}.`,
    ipAddress: ip
  });
  return true;
}

/** Every live phone of a member — they were removed. Returns how many. */
export function revokePhonesOfUser(userId: string): number {
  return db.prepare(`UPDATE api_tokens SET revoked_at = ${NOW} WHERE user_id = ? AND scope = ? AND revoked_at IS NULL`)
    .run(userId, PHONE_SCOPE).changes;
}

/** Every live phone bound to a library — it was orphaned, handed over or deleted. */
export function revokePhonesOfLibrary(libraryId: string): number {
  return db.prepare(`UPDATE api_tokens SET revoked_at = ${NOW} WHERE library_id = ? AND scope = ? AND revoked_at IS NULL`)
    .run(libraryId, PHONE_SCOPE).changes;
}

// ── Per request (phase 3's /dav routes call this) ────────────────────────────

export interface PhoneIdentity {
  user: User;
  deviceId: string;
  label: string | null;
  libraryId: string;
}

export type PhoneAuthResult =
  | { ok: true; phone: PhoneIdentity }
  /** `network`: refused by where it comes from (403, no challenge — a password won't
   *  help). `credentials`: no, unknown, revoked or unusable token (401 + challenge). */
  | { ok: false; reason: "network" | "credentials" };

/** The password of a Basic `Authorization` header, or null. The user name is ignored. */
export function basicPassword(header: unknown): string | null {
  if (typeof header !== "string" || !header.toLowerCase().startsWith("basic ")) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon >= 0 ? decoded.slice(colon + 1) : null;
}

/** Resolve a raw token to a live phone: live token of the scope, active member, bound
 *  to that member's live personal library. Bumps last_seen_at / last_ip on success, and
 *  logs a first contact, or a contact from another phone-sync network than the last
 *  (Wi-Fi to the VPN, say) — the history an admin reads in Logs (phase 5). */
export function resolvePhoneToken(raw: string, ip: string | null): PhoneIdentity | null {
  if (!raw.startsWith(`isp_${PHONE_SCOPE}_`)) return null;
  const hash = sha256(raw);
  const row = db.prepare(`
    SELECT users.*, api_tokens.id AS token_id, api_tokens.label AS token_label, api_tokens.library_id AS token_library,
      api_tokens.last_ip AS token_last_ip, api_tokens.last_seen_at AS token_last_seen
    FROM api_tokens
    JOIN users ON users.id = api_tokens.user_id
    JOIN libraries ON libraries.id = api_tokens.library_id
    WHERE api_tokens.token_hash = ?
      AND api_tokens.scope = ?
      AND api_tokens.revoked_at IS NULL
      AND (api_tokens.expires_at IS NULL OR api_tokens.expires_at > ${NOW})
      AND users.deleted_at IS NULL AND users.is_active = 1
      AND libraries.personal_user_id = api_tokens.user_id
      AND libraries.personal_orphaned_at IS NULL
      AND libraries.type = 'gallery'
  `).get(hash, PHONE_SCOPE) as (User & {
    token_id: string; token_label: string | null; token_library: string; token_last_ip: string | null; token_last_seen: string | null;
  }) | undefined;
  if (!row) return null;
  db.prepare(`UPDATE api_tokens SET last_seen_at = ${NOW}, last_ip = ? WHERE id = ?`).run(ip, row.token_id);
  const { token_id, token_label, token_library, token_last_ip, token_last_seen, ...user } = row;
  if (!token_last_seen || token_last_ip !== ip) notePhoneNetwork(row.id, token_id, token_label, token_last_seen ? token_last_ip : null, ip);
  return { user: user as User, deviceId: token_id, label: token_label, libraryId: token_library };
}

function notePhoneNetwork(userId: string, deviceId: string, label: string | null, previousIp: string | null, ip: string | null): void {
  const now = syncNetworkOf(ip);
  const before = previousIp ? syncNetworkOf(previousIp) : null;
  if (previousIp && before?.id === now?.id) return;
  const where = now ? `${now.label ?? now.cidr} (${ip})` : String(ip);
  logActivity({
    event: "photo_sync.connected",
    actorUserId: userId,
    targetType: "photo_sync_device",
    targetId: deviceId,
    detail: previousIp
      ? `Phone "${label ?? "Phone"}" now connects from ${where}.`
      : `Phone "${label ?? "Phone"}" made its first contact, from ${where}.`,
    ipAddress: ip
  });
}

/** The whole check for one sync request: where from, then which phone. The network is
 *  checked first so nothing outside a listed network learns whether a token is good
 *  (it is resolved only inside one); a token matching nothing at all counts as abuse
 *  against the source address, as on OPDS (a revoked one is a phone not yet told, and
 *  is not). */
export function authenticatePhone(request: FastifyRequest): PhoneAuthResult {
  const raw = basicPassword(request.headers.authorization);
  const verdict = syncGateVerdict(request);
  if (!verdict.allowed) {
    // Refused either way; a guessed token from outside still counts as abuse.
    if (raw && isUnknownApiToken(raw)) flagAbusiveRequest(request, "token");
    // A live phone refused for where it is: its owner sees why on the Phones list
    // (the answer to the request is the same 403 either way). Sync turned off
    // altogether is said on that page already.
    if (raw && verdict.reason !== "off") {
      const phone = phoneOfRawToken(raw);
      if (phone) recordPhoneProblem(phone, verdict.reason === "proxy" ? "proxy" : "not_listed", request.ip ?? null, request.ip ?? null);
    }
    return { ok: false, reason: "network" };
  }
  if (!raw) return { ok: false, reason: "credentials" };
  const phone = resolvePhoneToken(raw, request.ip ?? null);
  if (!phone) {
    if (isUnknownApiToken(raw)) flagAbusiveRequest(request, "token");
    notePhonePasswordRefused(raw, request.ip ?? null);
    return { ok: false, reason: "credentials" };
  }
  // Got through: a network refusal it had is over.
  resolvePhoneProblem({ deviceId: phone.deviceId, userId: phone.user.id, label: phone.label }, "contact", request.ip ?? null);
  return { ok: true, phone };
}
