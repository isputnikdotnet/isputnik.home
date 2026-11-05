// Turning a personal library on, adopting an existing library as one, orphaning one
// when its member is removed, and handing an orphaned one to someone else
// (docs/photo-sync-plan.md, decisions 3, 4 and 11; open questions 7 and 8).
import fs from "node:fs";
import path from "node:path";
import { db, logActivity } from "../../../../db.js";
import { deleteAssignmentsForObject } from "../../../../core/permissions.js";
import { createLibraryRecord } from "../../shared/library-crud.js";
import { enqueueGalleryScan, processGalleryScanQueue } from "../scanner.js";
import { personalLibraryIdOf } from "./personal-libraries.js";
import { revokePhonesOfLibrary } from "../sync/devices.js";
import { getPersonalSettings, isAllowedPersonalLibrary, personalParentFolder, sizeLimitBytes } from "./settings.js";
import type { LibraryRow, UserRow } from "../../../../db/rows.js";

export class PersonalLibraryError extends Error {
  constructor(message: string, readonly statusCode = 409, readonly code = "refused") {
    super(message);
  }
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** Bytes and items in a library: its live (not deleted) gallery items. */
export function librarySize(libraryId: string): { bytes: number; items: number } {
  const row = db.prepare(`
    SELECT COUNT(li.id) AS items, COALESCE(SUM(COALESCE(gd.size, 0)), 0) AS bytes
    FROM library_items li LEFT JOIN gallery_details gd ON gd.item_id = li.id
    WHERE li.library_id = ? AND li.deleted_at IS NULL
  `).get(libraryId) as { items: number; bytes: number };
  return { bytes: row.bytes, items: row.items };
}

type Member = Pick<UserRow, "id" | "display_name" | "is_active" | "deleted_at">;

function activeMember(userId: string): Member {
  const user = db.prepare("SELECT id, display_name, is_active, deleted_at FROM users WHERE id = ?").get(userId) as Member | undefined;
  if (!user || user.deleted_at || !user.is_active) throw new PersonalLibraryError("Member not found.", 404, "no_member");
  return user;
}

/** A folder name from a person's name: no path separators or characters Windows
 *  refuses, no leading dot, never empty. */
function folderNameFor(name: string): string {
  const cleaned = [...name].map((ch) => (ch.charCodeAt(0) < 32 ? " " : ch)).join("")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return cleaned || "Member";
}

function uniqueFolder(parent: string, base: string): string {
  let candidate = path.join(parent, base);
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(parent, `${base} (${n})`);
  return candidate;
}

/** Item shares and guest links on a library's photos that someone other than `keep`
 *  made. Album shares need nothing: they reach a photo only through what their
 *  creator may curate, which ends when the library becomes personal. */
function revokeItemSharesExcept(libraryId: string, keep: string | null): void {
  const items = "SELECT id FROM library_items WHERE library_id = ?";
  const by = keep ? "AND created_by != ?" : "";
  const params = keep ? [libraryId, keep] : [libraryId];
  db.prepare(`UPDATE shares SET revoked_at = ${NOW} WHERE module = 'gallery' AND revoked_at IS NULL AND resource_id IN (${items}) ${by}`).run(...params);
  db.prepare(`UPDATE share_links SET revoked_at = ${NOW} WHERE module = 'gallery' AND revoked_at IS NULL AND resource_id IN (${items}) ${by}`).run(...params);
}

/** Make a library someone's: the marker, the logical owner, nobody's grants, no face
 *  scanning (decision 5), no item shares but their own, and no phones but theirs (a
 *  handed-over library's were revoked when it was orphaned; this makes sure). */
function markPersonal(libraryId: string, userId: string, adopted: boolean): void {
  db.prepare("UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE library_id = ? AND user_id != ? AND revoked_at IS NULL").run(libraryId, userId);
  db.prepare(`
    UPDATE libraries SET personal_user_id = ?, personal_orphaned_at = NULL,
      personal_adopted_at = ${adopted ? NOW : "NULL"},
      owner_id = ?, owner_type = 'user', updated_at = ${NOW}
    WHERE id = ?
  `).run(userId, userId, libraryId);
  deleteAssignmentsForObject("library", libraryId);
  db.prepare("DELETE FROM app_settings WHERE key = ?").run(`face_recognition.lib.${libraryId}`);
  revokeItemSharesExcept(libraryId, userId);
}

// ── Turn on (the member, from Profile) ───────────────────────────────────────

export function turnOnPersonalLibrary(user: { id: string; role: string }, name: string | undefined, ip: string | null): string {
  const settings = getPersonalSettings();
  if (!isAllowedPersonalLibrary(user, settings)) {
    throw new PersonalLibraryError("Personal libraries are not available to you.", 403, "not_allowed");
  }
  if (personalLibraryIdOf(user.id)) throw new PersonalLibraryError("You already have a personal library.", 409, "exists");
  const parent = personalParentFolder(settings);
  if (!parent) throw new PersonalLibraryError("No folder is set for personal libraries.", 409, "no_folder");
  const member = activeMember(user.id);

  const wanted = (name?.trim() || `${member.display_name}'s library`).slice(0, 120);
  const libraryName = wanted.length >= 2 ? wanted : `${wanted} library`;
  let folder: string;
  try {
    fs.mkdirSync(parent, { recursive: true });
    folder = uniqueFolder(parent, folderNameFor(member.display_name));
    fs.mkdirSync(folder);
  } catch {
    throw new PersonalLibraryError("The folder for personal libraries can't be written to.", 409, "folder_unwritable");
  }

  const created = createLibraryRecord({
    type: "gallery",
    data: { name: libraryName, sourcePath: folder, visibility: "private", mode: "managed" },
    userId: user.id,
    ip: ip ?? ""
  });
  if ("error" in created) {
    try { fs.rmdirSync(folder); } catch { /* left for the admin */ }
    throw new PersonalLibraryError(created.error, created.status, "create_failed");
  }
  db.transaction(() => markPersonal(created.libraryId, user.id, false))();

  enqueueGalleryScan(created.libraryId);
  void processGalleryScanQueue();
  logActivity({
    event: "library.personal.created",
    actorUserId: user.id,
    targetType: "library",
    targetId: created.libraryId,
    detail: "Turned on a personal library.",
    ipAddress: ip
  });
  return created.libraryId;
}

// ── Adopt (an admin, from Library › Storage) ─────────────────────────────────

/** Make an existing gallery library a member's personal library. Takes effect at once
 *  (open question 8): every grant to anyone else goes, and the admin can no longer
 *  open it. */
export function adoptPersonalLibrary(libraryId: string, userId: string, actorId: string, ip: string | null): void {
  const library = db.prepare("SELECT id, name, type, role, personal_user_id FROM libraries WHERE id = ?")
    .get(libraryId) as Pick<LibraryRow, "id" | "name" | "type" | "role" | "personal_user_id"> | undefined;
  if (!library || library.type !== "gallery") throw new PersonalLibraryError("Gallery library not found.", 404, "no_library");
  if (library.role) throw new PersonalLibraryError("A system library can't become a personal library.", 409, "system_library");
  if (library.personal_user_id) throw new PersonalLibraryError("This already is a personal library.", 409, "already_personal");
  const member = activeMember(userId);
  if (personalLibraryIdOf(member.id)) {
    throw new PersonalLibraryError(`${member.display_name} already has a personal library.`, 409, "member_has_one");
  }

  db.transaction(() => markPersonal(library.id, member.id, true))();
  logActivity({
    event: "library.personal.adopted",
    actorUserId: actorId,
    targetType: "library",
    targetId: library.id,
    detail: `Made "${library.name}" ${member.display_name}'s personal library; every other grant to it was removed.`,
    ipAddress: ip
  });
}

// ── Orphan (member removed) and hand over ────────────────────────────────────

/** Decision 11: the member was removed, so their personal library is kept, belongs to
 *  nobody, and its item shares and phones end. Nothing is deleted. */
export function orphanPersonalLibraryOf(userId: string, actorId: string | null, ip: string | null): string | null {
  const libraryId = personalLibraryIdOf(userId);
  if (!libraryId) return null;
  db.transaction(() => {
    db.prepare(`UPDATE libraries SET personal_orphaned_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`).run(libraryId);
    revokeItemSharesExcept(libraryId, null);
    revokePhonesOfLibrary(libraryId);
  })();
  logActivity({
    event: "library.personal.orphaned",
    actorUserId: actorId,
    targetType: "library",
    targetId: libraryId,
    detail: "The member was removed; their personal library was kept, with no owner.",
    ipAddress: ip
  });
  return libraryId;
}

/** Open question 7: an orphaned personal library may go to another member who has
 *  none. It stays private — theirs now. */
export function handOverPersonalLibrary(libraryId: string, toUserId: string, actorId: string, ip: string | null): void {
  const library = db.prepare("SELECT id, personal_user_id, personal_orphaned_at FROM libraries WHERE id = ?")
    .get(libraryId) as Pick<LibraryRow, "id" | "personal_user_id" | "personal_orphaned_at"> | undefined;
  if (!library?.personal_user_id) throw new PersonalLibraryError("Library not found.", 404, "no_library");
  if (!library.personal_orphaned_at) {
    throw new PersonalLibraryError("Only a personal library whose member was removed can be handed over.", 409, "not_orphaned");
  }
  const member = activeMember(toUserId);
  if (personalLibraryIdOf(member.id)) {
    throw new PersonalLibraryError(`${member.display_name} already has a personal library.`, 409, "member_has_one");
  }

  db.transaction(() => markPersonal(library.id, member.id, true))();
  logActivity({
    event: "library.personal.handed_over",
    actorUserId: actorId,
    targetType: "library",
    targetId: library.id,
    detail: `Handed an orphaned personal library to ${member.display_name}.`,
    ipAddress: ip
  });
}

// ── Size ─────────────────────────────────────────────────────────────────────

/** For an upload into a personal library: the member's size limit and what is used,
 *  or null when there is no limit or the library is not personal. */
export function personalQuota(libraryId: string): { limitBytes: number; usedBytes: number } | null {
  const marker = db.prepare("SELECT personal_user_id FROM libraries WHERE id = ?").get(libraryId) as Pick<LibraryRow, "personal_user_id"> | undefined;
  if (!marker?.personal_user_id) return null;
  const limit = sizeLimitBytes();
  if (limit == null) return null;
  return { limitBytes: limit, usedBytes: librarySize(libraryId).bytes };
}

// ── Views ────────────────────────────────────────────────────────────────────

export type PersonalUnavailableReason = "off" | "not_allowed" | "no_folder";

/** Profile › My library. */
export function myLibraryView(user: { id: string }) {
  const settings = getPersonalSettings();
  const libraryId = personalLibraryIdOf(user.id);
  let library: { id: string; name: string; adoptedAt: string | null; sizeBytes: number; items: number } | null = null;
  if (libraryId) {
    const row = db.prepare("SELECT id, name, personal_adopted_at FROM libraries WHERE id = ?")
      .get(libraryId) as Pick<LibraryRow, "id" | "name" | "personal_adopted_at">;
    const size = librarySize(libraryId);
    library = { id: row.id, name: row.name, adoptedAt: row.personal_adopted_at, sizeBytes: size.bytes, items: size.items };
  }
  let unavailable: PersonalUnavailableReason | null = null;
  if (!settings.enabled) unavailable = "off";
  else if (!isAllowedPersonalLibrary(user, settings)) unavailable = "not_allowed";
  else if (!personalParentFolder(settings)) unavailable = "no_folder";
  return { library, canTurnOn: !library && unavailable === null, unavailable, sizeLimitBytes: sizeLimitBytes(settings) };
}

/** Library › Storage: every personal library, whose it is, its size and how many phones
 *  back up into it — nothing else. */
export function personalLibrariesForAdmin() {
  const rows = db.prepare(`
    SELECT l.id, l.name, l.personal_user_id, l.personal_orphaned_at, l.personal_adopted_at, l.created_at,
      u.display_name AS owner_name,
      (SELECT COUNT(*) FROM api_tokens t WHERE t.library_id = l.id AND t.scope = 'photo-sync' AND t.revoked_at IS NULL) AS phones
    FROM libraries l LEFT JOIN users u ON u.id = l.personal_user_id
    WHERE l.personal_user_id IS NOT NULL
    ORDER BY l.personal_orphaned_at IS NOT NULL, u.display_name COLLATE NOCASE
  `).all() as (Pick<LibraryRow, "id" | "name" | "personal_orphaned_at" | "personal_adopted_at" | "created_at">
    & { personal_user_id: string; owner_name: string | null; phones: number })[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ownerId: row.personal_user_id,
    ownerName: row.owner_name ?? "",
    orphanedAt: row.personal_orphaned_at,
    adoptedAt: row.personal_adopted_at,
    createdAt: row.created_at,
    sizeBytes: librarySize(row.id).bytes,
    phones: row.phones
  }));
}
