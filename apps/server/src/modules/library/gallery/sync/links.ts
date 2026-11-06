// Phone links (docs/photo-sync-plan.md, phase 6): the libraries a phone's photos may
// already be in. A family that backed its phones up some other way (Immich, say) has
// those photos in an ordinary gallery library already; switching PhotoSync on would
// send every one of them again. An admin links the phone to that library on the
// library's Phone backups tab, and put.ts then treats a photo already there (same
// bytes) as "already have it": recorded against that item, nothing stored.
//
// Per phone and per library, set by an admin — not a member setting. A link counts
// only while the phone's owner can open the library: a photo "already there" in a
// library they can't see would simply vanish from their side. Linkable: gallery
// libraries that are neither personal nor a system library (Inbox, App files).
// A link counts from then on; nothing already stored moves.
import { db, logActivity } from "../../../../db.js";
import { canUserAccessLibrary } from "../../shared/library-access.js";
import { validateLibrarySource } from "../../shared/library-source.js";
import { PHONE_SCOPE } from "./devices.js";
import type { LibraryRow } from "../../../../db/rows.js";

export class PhoneLinkError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = "refused") {
    super(message);
  }
}

type LinkableRow = Pick<LibraryRow, "id" | "name" | "source_path">;

/** A library phones may be linked to, or null. */
export function linkableLibrary(libraryId: string): LinkableRow | null {
  return (db.prepare(`
    SELECT id, name, source_path FROM libraries
    WHERE id = ? AND type = 'gallery' AND personal_user_id IS NULL AND role IS NULL
  `).get(libraryId) as LinkableRow | undefined) ?? null;
}

interface LivePhoneRow {
  id: string;
  label: string | null;
  user_id: string;
  user_name: string;
  user_role: string;
}

function livePhones(): LivePhoneRow[] {
  return db.prepare(`
    SELECT t.id, t.label, t.user_id, u.display_name AS user_name, u.role AS user_role
    FROM api_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.scope = ? AND t.revoked_at IS NULL AND u.deleted_at IS NULL AND u.is_active = 1
    ORDER BY u.display_name COLLATE NOCASE, t.label COLLATE NOCASE
  `).all(PHONE_SCOPE) as LivePhoneRow[];
}

export interface LibraryPhone {
  id: string;
  label: string | null;
  member: { id: string; name: string };
  linked: boolean;
  /** The phone's owner can open the library — only then does a link count. */
  canOpen: boolean;
}

/** The library's Phone backups tab: every live phone whose owner can open it, and any
 *  phone linked to it whose owner no longer can (shown as not counting). */
export function phonesForLibrary(libraryId: string): LibraryPhone[] {
  const linked = new Set((db.prepare("SELECT device_id FROM photo_sync_library_links WHERE library_id = ?").all(libraryId) as { device_id: string }[])
    .map((row) => row.device_id));
  const out: LibraryPhone[] = [];
  for (const phone of livePhones()) {
    const canOpen = canUserAccessLibrary({ id: libraryId }, phone.user_id, phone.user_role);
    const isLinked = linked.has(phone.id);
    if (!canOpen && !isLinked) continue;
    out.push({ id: phone.id, label: phone.label, member: { id: phone.user_id, name: phone.user_name }, linked: isLinked, canOpen });
  }
  return out;
}

/** Replace the library's linked phones. A phone being added must be live and its owner
 *  able to open the library; a link left in place that no longer counts may stay (it
 *  counts again if access comes back) or be dropped. */
export function setLibraryPhones(libraryId: string, deviceIds: string[], actor: { id: string }, ip: string | null): LibraryPhone[] {
  const library = linkableLibrary(libraryId);
  if (!library) throw new PhoneLinkError("Phones can be linked only to a shared photo library.", 404, "not_linkable");
  const phones = new Map(livePhones().map((phone) => [phone.id, phone]));
  const before = new Set((db.prepare("SELECT device_id FROM photo_sync_library_links WHERE library_id = ?").all(libraryId) as { device_id: string }[])
    .map((row) => row.device_id));
  const wanted = new Set(deviceIds);
  const added: LivePhoneRow[] = [];
  for (const id of wanted) {
    if (before.has(id)) continue;
    const phone = phones.get(id);
    if (!phone) throw new PhoneLinkError("That phone is no longer set up for backup.", 400, "no_phone");
    if (!canUserAccessLibrary({ id: libraryId }, phone.user_id, phone.user_role)) {
      throw new PhoneLinkError(`${phone.user_name} can't open this library, so their phone can't be linked to it.`, 400, "cannot_open");
    }
    added.push(phone);
  }
  const removed = [...before].filter((id) => !wanted.has(id));
  db.transaction(() => {
    const insert = db.prepare("INSERT OR IGNORE INTO photo_sync_library_links (device_id, library_id, created_by) VALUES (?, ?, ?)");
    for (const phone of added) insert.run(phone.id, libraryId, actor.id);
    const drop = db.prepare("DELETE FROM photo_sync_library_links WHERE device_id = ? AND library_id = ?");
    for (const id of removed) drop.run(id, libraryId);
  })();
  const name = (phone: LivePhoneRow | undefined, id: string) => phone ? `"${phone.label ?? "Phone"}" (${phone.user_name})` : `a removed phone (${id.slice(0, 6)})`;
  for (const phone of added) {
    logActivity({
      event: "photo_sync.linked",
      actorUserId: actor.id,
      targetType: "photo_sync_device",
      targetId: phone.id,
      detail: `Phone ${name(phone, phone.id)} now skips photos already in "${library.name}".`,
      ipAddress: ip
    });
  }
  for (const id of removed) {
    logActivity({
      event: "photo_sync.unlinked",
      actorUserId: actor.id,
      targetType: "photo_sync_device",
      targetId: id,
      detail: `Phone ${name(phones.get(id), id)} no longer skips photos in "${library.name}".`,
      ipAddress: ip
    });
  }
  return phonesForLibrary(libraryId);
}

export interface PhoneLink {
  libraryId: string;
  name: string;
  /** False while the phone's owner can't open the library: the link is kept, not used. */
  counts: boolean;
}

/** Every link, per phone — for Security › Phone sync and the member's phone cards. */
export function linksOfPhones(deviceIds: string[]): Map<string, PhoneLink[]> {
  const out = new Map<string, PhoneLink[]>();
  if (deviceIds.length === 0) return out;
  const rows = db.prepare(`
    SELECT k.device_id, l.id AS library_id, l.name, t.user_id, u.role AS user_role
    FROM photo_sync_library_links k
    JOIN libraries l ON l.id = k.library_id
    JOIN api_tokens t ON t.id = k.device_id
    JOIN users u ON u.id = t.user_id
    WHERE k.device_id IN (${deviceIds.map(() => "?").join(",")})
    ORDER BY l.name COLLATE NOCASE
  `).all(...deviceIds) as Array<{ device_id: string; library_id: string; name: string; user_id: string; user_role: string }>;
  for (const row of rows) {
    const list = out.get(row.device_id) ?? [];
    list.push({ libraryId: row.library_id, name: row.name, counts: canUserAccessLibrary({ id: row.library_id }, row.user_id, row.user_role) });
    out.set(row.device_id, list);
  }
  return out;
}

export interface LinkedTarget {
  libraryId: string;
  root: string;
}

/** The libraries put.ts checks for one phone, beside its personal library: linked, still
 *  linkable, the owner can open it, and its folder is there. */
export function linkedTargetsOf(deviceId: string, user: { id: string; role: string }): LinkedTarget[] {
  const rows = db.prepare(`
    SELECT l.id, l.source_path FROM photo_sync_library_links k
    JOIN libraries l ON l.id = k.library_id
    WHERE k.device_id = ? AND l.type = 'gallery' AND l.personal_user_id IS NULL AND l.role IS NULL
  `).all(deviceId) as Array<Pick<LibraryRow, "id" | "source_path">>;
  const out: LinkedTarget[] = [];
  for (const row of rows) {
    if (!canUserAccessLibrary({ id: row.id }, user.id, user.role)) continue;
    let root: string;
    try { root = validateLibrarySource(row.source_path); } catch { continue; }
    out.push({ libraryId: row.id, root });
  }
  return out;
}
