// How each phone's backup is going (docs/photo-sync-plan.md, phase 4): last contact,
// the last photo received, files and bytes in the last 24 hours and in all, and the
// last problem and when.
//
// Cheap on the /dav hot path: nothing here runs for a request that went well.
// Last contact is the token's own last_seen_at (bumped by authenticatePhone), and
// what arrived is read from photo_sync_files when someone looks. Only a problem is
// written, and the same problem from the same phone at most once a minute — a phone
// outside the networks retries every file, and that must not become a write each.
// Repeated MKCOLs (405) and 204 duplicates are normal traffic and never reach here.
//
// The problem is stored as a code and a detail that is never a file name: the file
// type (".dng"), or the address a refused request came from. The admin's views read
// only the device-level codes (ADMIN_PROBLEMS); the owner sees all of them. Device-
// level problems also go to the activity log, at most once an hour per phone and
// problem, with the phone as the target.
//
// Phase 5: a problem is over once the phone backs up again — `resolved_at` is set by
// the first request that went well after it (any contact, for a network refusal; a
// stored or already-held file, for the rest), and the log says so for the problems an
// admin sees. One indexed read per request finds whether there is anything to clear,
// and a phone known to be clear is remembered so even that is skipped. A phone that
// has not been in touch for STALE_DAYS is "stale" — said on its card, on the member's
// page and on Security › Phone sync. Refused passwords inside a network (a revoked
// phone still trying, or one that matches no phone) are logged, once an hour each.
import { db, logActivity } from "../../../../db.js";
import { sha256 } from "../../../../crypto.js";

/** What went wrong. The web app words each one (profile.phones.problem.*). */
export type PhoneProblem =
  | "not_listed"        // from outside every phone-sync network (detail: the address)
  | "proxy"             // behind a proxy home can't believe
  | "type"              // file type the library doesn't take (detail: ".dng")
  | "too_large"         // over the library's upload cap
  | "quota"             // the member's size limit
  | "disk_full"
  | "incomplete"        // the upload stopped part-way
  | "checksum"          // length or checksum didn't match
  | "library_unavailable"
  | "server_error";

/** Problems that are about the phone or the server, not about any photo — the admin may see these. */
export const ADMIN_PROBLEMS: ReadonlySet<PhoneProblem> = new Set(["not_listed", "proxy", "quota", "disk_full", "library_unavailable"]);

const WRITE_EVERY_MS = 60_000;
const LOG_EVERY_MS = 60 * 60_000;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** No contact for this long and a phone's card says so. */
export const STALE_DAYS = 7;
/** Problems a phone's next contact clears (the rest wait for a file to go through). */
const CONTACT_CLEARS: ReadonlySet<string> = new Set(["not_listed", "proxy"]);

const lastWrite = new Map<string, number>();
/** Phones known to have no open problem — skips the read on the hot path. */
const knownClear = new Set<string>();
const lastPasswordLog = new Map<string, number>();

/** Tests only: forget the once-a-minute memory. */
export function resetPhoneStatusThrottleForTests(): void {
  lastWrite.clear();
  knownClear.clear();
  lastPasswordLog.clear();
}

const LOG_WORDS: Partial<Record<PhoneProblem, string>> = {
  not_listed: "was refused: not from a phone-sync network",
  proxy: "was refused: the server is behind a proxy it does not trust",
  quota: "could not back up: the personal library has reached its size limit",
  disk_full: "could not back up: the server's disk is full",
  library_unavailable: "could not back up: the library's folder is unavailable"
};

/** Notes a problem for a phone. Throttled; never throws (status must not break a sync). */
export function recordPhoneProblem(
  phone: { deviceId: string; userId: string; label: string | null },
  problem: PhoneProblem,
  detail: string | null,
  ip: string | null
): void {
  const key = `${phone.deviceId}:${problem}:${detail ?? ""}`;
  const now = Date.now();
  const before = lastWrite.get(key);
  if (before !== undefined && now - before < WRITE_EVERY_MS) return;
  lastWrite.set(key, now);
  if (lastWrite.size > 5000) lastWrite.clear();
  knownClear.delete(phone.deviceId);
  try {
    const previous = db.prepare("SELECT last_error_code, last_error_at, resolved_at FROM photo_sync_device_status WHERE device_id = ?")
      .get(phone.deviceId) as { last_error_code: string; last_error_at: string; resolved_at: string | null } | undefined;
    db.prepare(`
      INSERT INTO photo_sync_device_status (device_id, last_error_code, last_error_detail, last_error_at, resolved_at)
      VALUES (?, ?, ?, ${NOW}, NULL)
      ON CONFLICT(device_id) DO UPDATE SET
        last_error_code = excluded.last_error_code, last_error_detail = excluded.last_error_detail,
        last_error_at = excluded.last_error_at, resolved_at = NULL
    `).run(phone.deviceId, problem, detail);

    const words = LOG_WORDS[problem];
    // The same problem again within the hour is one story — unless it was over in between.
    const repeat = previous?.last_error_code === problem && !previous.resolved_at &&
      now - Date.parse(previous.last_error_at) < LOG_EVERY_MS;
    if (words && !repeat) {
      logActivity({
        event: `photo_sync.${problem === "not_listed" || problem === "proxy" ? "refused" : "failed"}`,
        actorUserId: phone.userId,
        targetType: "photo_sync_device",
        targetId: phone.deviceId,
        detail: `Phone "${phone.label ?? "Phone"}" ${words}.`,
        ipAddress: ip
      });
    }
  } catch {
    /* status is a convenience; the request's own answer is what matters */
  }
}

/** A request that went well: ends the phone's open problem, if any. `contact` is any
 *  request that got through the checks (it ends a network refusal); `file` is a file
 *  stored or already held (it ends any problem). Never throws. */
export function resolvePhoneProblem(
  phone: { deviceId: string; userId: string; label: string | null },
  by: "contact" | "file",
  ip: string | null
): void {
  if (knownClear.has(phone.deviceId)) return;
  try {
    const open = db.prepare("SELECT last_error_code FROM photo_sync_device_status WHERE device_id = ? AND resolved_at IS NULL")
      .get(phone.deviceId) as { last_error_code: PhoneProblem } | undefined;
    if (!open) {
      if (knownClear.size > 5000) knownClear.clear();
      knownClear.add(phone.deviceId);
      return;
    }
    if (by === "contact" && !CONTACT_CLEARS.has(open.last_error_code)) return;
    db.prepare(`UPDATE photo_sync_device_status SET resolved_at = ${NOW} WHERE device_id = ? AND resolved_at IS NULL`).run(phone.deviceId);
    knownClear.add(phone.deviceId);
    // A problem after this one is news: the once-a-minute memory must not swallow it.
    for (const key of lastWrite.keys()) if (key.startsWith(`${phone.deviceId}:`)) lastWrite.delete(key);
    if (ADMIN_PROBLEMS.has(open.last_error_code)) {
      logActivity({
        event: "photo_sync.recovered",
        actorUserId: phone.userId,
        targetType: "photo_sync_device",
        targetId: phone.deviceId,
        detail: `Phone "${phone.label ?? "Phone"}" is backing up again.`,
        ipAddress: ip
      });
    }
  } catch {
    /* status is a convenience */
  }
}

/** A password refused from inside a phone-sync network: a revoked phone still trying
 *  (its owner and the admin should know which), or a password that matches no phone.
 *  No password at all is a client's normal first request, and is not noted. Logged
 *  once an hour per phone or address; never throws. */
export function notePhonePasswordRefused(raw: string, ip: string | null): void {
  try {
    const revoked = raw.startsWith("isp_photo-sync_")
      ? db.prepare(`
          SELECT id, user_id, label FROM api_tokens
          WHERE token_hash = ? AND scope = 'photo-sync' AND revoked_at IS NOT NULL
        `).get(sha256(raw)) as { id: string; user_id: string; label: string | null } | undefined
      : undefined;
    const key = revoked ? `token:${revoked.id}` : `ip:${ip ?? ""}`;
    const now = Date.now();
    const before = lastPasswordLog.get(key);
    if (before !== undefined && now - before < LOG_EVERY_MS) return;
    if (lastPasswordLog.size > 5000) lastPasswordLog.clear();
    lastPasswordLog.set(key, now);
    logActivity({
      event: "photo_sync.refused",
      actorUserId: revoked?.user_id ?? null,
      targetType: revoked ? "photo_sync_device" : null,
      targetId: revoked?.id ?? null,
      detail: revoked
        ? `Phone "${revoked.label ?? "Phone"}" was refused: its password was revoked. Add the phone again to get a new one.`
        : "A phone was refused: its password matches no phone.",
      ipAddress: ip
    });
  } catch {
    /* status is a convenience */
  }
}

/** A request refused by network carries a token that was never resolved (on purpose:
 *  nothing outside the networks learns whether a token is good). For the owner's
 *  status, find the live phone it belongs to without bumping last contact. */
export function phoneOfRawToken(raw: string): { deviceId: string; userId: string; label: string | null } | null {
  if (!raw.startsWith("isp_photo-sync_")) return null;
  const row = db.prepare(`
    SELECT id, user_id, label FROM api_tokens
    WHERE token_hash = ? AND scope = 'photo-sync' AND revoked_at IS NULL
  `).get(sha256(raw)) as { id: string; user_id: string; label: string | null } | undefined;
  return row ? { deviceId: row.id, userId: row.user_id, label: row.label } : null;
}

export interface PhoneStatus {
  lastContact: string | null;
  lastReceived: string | null;
  day: { files: number; bytes: number };
  total: { files: number; bytes: number };
  /** `current` until the phone backs up again; after that it is an earlier problem. */
  problem: { code: PhoneProblem; detail: string | null; at: string; current: boolean } | null;
  /** No contact (or, never seen, no first contact) for STALE_DAYS. */
  stale: boolean;
}

/** Whether a phone has been out of touch for STALE_DAYS. */
export function isPhoneStale(phone: { last_seen_at: string | null; created_at: string }, now = Date.now()): boolean {
  const since = Date.parse(phone.last_seen_at ?? phone.created_at);
  return Number.isFinite(since) && now - since >= STALE_DAYS * 86_400_000;
}

/** Status of each of the given phones, by id. `forAdmin` keeps only device-level problems. */
export function phoneStatuses(phones: Array<{ id: string; last_seen_at: string | null; created_at: string }>, forAdmin = false): Map<string, PhoneStatus> {
  const out = new Map<string, PhoneStatus>();
  if (phones.length === 0) return out;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const counts = db.prepare(`
    SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes,
      COALESCE(SUM(CASE WHEN received_at > ? THEN 1 ELSE 0 END), 0) AS day_files,
      COALESCE(SUM(CASE WHEN received_at > ? THEN size ELSE 0 END), 0) AS day_bytes,
      MAX(received_at) AS last_received
    FROM photo_sync_files WHERE device_id = ?
  `);
  const problems = db.prepare("SELECT last_error_code, last_error_detail, last_error_at, resolved_at FROM photo_sync_device_status WHERE device_id = ?");
  for (const phone of phones) {
    const c = counts.get(since, since, phone.id) as { files: number; bytes: number; day_files: number; day_bytes: number; last_received: string | null };
    const p = problems.get(phone.id) as { last_error_code: PhoneProblem; last_error_detail: string | null; last_error_at: string; resolved_at: string | null } | undefined;
    const shown = p && (!forAdmin || ADMIN_PROBLEMS.has(p.last_error_code));
    out.set(phone.id, {
      lastContact: phone.last_seen_at,
      lastReceived: c.last_received,
      day: { files: c.day_files, bytes: c.day_bytes },
      total: { files: c.files, bytes: c.bytes },
      // A network refusal is also over once the phone got through after it (a contact
      // never bumps last_seen_at while refused) — which covers one from before resolved_at.
      problem: shown ? {
        code: p.last_error_code, detail: p.last_error_detail, at: p.last_error_at,
        current: !p.resolved_at && !(CONTACT_CLEARS.has(p.last_error_code) && phone.last_seen_at != null && phone.last_seen_at > p.last_error_at)
      } : null,
      stale: isPhoneStale(phone)
    });
  }
  return out;
}
