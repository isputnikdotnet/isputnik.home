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

const lastWrite = new Map<string, number>();

/** Tests only: forget the once-a-minute memory. */
export function resetPhoneStatusThrottleForTests(): void {
  lastWrite.clear();
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
  try {
    const previous = db.prepare("SELECT last_error_code, last_error_at FROM photo_sync_device_status WHERE device_id = ?")
      .get(phone.deviceId) as { last_error_code: string; last_error_at: string } | undefined;
    db.prepare(`
      INSERT INTO photo_sync_device_status (device_id, last_error_code, last_error_detail, last_error_at)
      VALUES (?, ?, ?, ${NOW})
      ON CONFLICT(device_id) DO UPDATE SET
        last_error_code = excluded.last_error_code, last_error_detail = excluded.last_error_detail,
        last_error_at = excluded.last_error_at
    `).run(phone.deviceId, problem, detail);

    const words = LOG_WORDS[problem];
    const repeat = previous?.last_error_code === problem && now - Date.parse(previous.last_error_at) < LOG_EVERY_MS;
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
  problem: { code: PhoneProblem; detail: string | null; at: string } | null;
}

/** Status of each of the given phones, by id. `forAdmin` keeps only device-level problems. */
export function phoneStatuses(phones: Array<{ id: string; last_seen_at: string | null }>, forAdmin = false): Map<string, PhoneStatus> {
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
  const problems = db.prepare("SELECT last_error_code, last_error_detail, last_error_at FROM photo_sync_device_status WHERE device_id = ?");
  for (const phone of phones) {
    const c = counts.get(since, since, phone.id) as { files: number; bytes: number; day_files: number; day_bytes: number; last_received: string | null };
    const p = problems.get(phone.id) as { last_error_code: PhoneProblem; last_error_detail: string | null; last_error_at: string } | undefined;
    const shown = p && (!forAdmin || ADMIN_PROBLEMS.has(p.last_error_code));
    out.set(phone.id, {
      lastContact: phone.last_seen_at,
      lastReceived: c.last_received,
      day: { files: c.day_files, bytes: c.day_bytes },
      total: { files: c.files, bytes: c.bytes },
      problem: shown ? { code: p.last_error_code, detail: p.last_error_detail, at: p.last_error_at } : null
    });
  }
  return out;
}
