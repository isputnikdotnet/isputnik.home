import type Database from "better-sqlite3";

// 4.6: the Photo Inbox stops having library access rules (docs/system-data-plan.md,
// phase 4, decision 21). Who may review it is a reviewer list stored under its own
// object in `assignments` (gallery/inbox-reviewers.ts). Every grant on the Inbox
// library carries across so nobody who could see it loses it: manager becomes
// "can keep or discard", viewer, member and contributor become "can add details",
// and the Everyone grant maps the same way onto the Everyone group. Admins review
// anyway, so their grants are not listed. A deny has no reviewer equivalent and is
// dropped. Then the library's own assignments and owner go.
//
// Self-contained on purpose: a migration must not import app code that later changes.
export const version = 76;

const OBJECT_TYPE = "photo_inbox";
const OBJECT_ID = "reviewers";

type Grant = { subject_type: string; subject_id: string; role: string; created_by: string | null };

export function up(db: Database.Database): void {
  const table = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  if (!table("libraries") || !table("assignments")) return;
  const columns = (name: string) => new Set((db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name));
  const libraryColumns = columns("libraries");
  if (!libraryColumns.has("role")) return;

  const inbox = db.prepare("SELECT id FROM libraries WHERE role = 'inbox'").get() as { id: string } | undefined;
  if (!inbox) return;

  const hasCreatedBy = columns("assignments").has("created_by");
  const grants = db.prepare(`SELECT subject_type, subject_id, role, ${hasCreatedBy ? "created_by" : "NULL AS created_by"} FROM assignments WHERE object_type = 'library' AND object_id = ?`)
    .all(inbox.id) as Grant[];
  const usersHaveRole = table("users") && columns("users").has("role");
  const isAdmin = (userId: string) => usersHaveRole
    && (db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined)?.role === "admin";

  const current = db.prepare("SELECT role FROM assignments WHERE object_type = ? AND object_id = ? AND subject_type = ? AND subject_id = ?");
  const insert = db.prepare(hasCreatedBy
    ? "INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role, created_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET role = excluded.role"
    : "INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role) VALUES (?, ?, ?, ?, ?) ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET role = excluded.role");

  for (const grant of grants) {
    if (grant.role === "deny") continue;
    if (grant.subject_type === "user" && isAdmin(grant.subject_id)) continue;
    const role = grant.role === "manager" ? "manager" : "contributor";
    const existing = current.get(OBJECT_TYPE, OBJECT_ID, grant.subject_type, grant.subject_id) as { role: string } | undefined;
    if (existing?.role === "manager") continue;
    const args = [grant.subject_type, grant.subject_id, OBJECT_TYPE, OBJECT_ID, role];
    insert.run(...(hasCreatedBy ? [...args, grant.created_by] : args));
  }

  db.prepare("DELETE FROM assignments WHERE object_type = 'library' AND object_id = ?").run(inbox.id);
  if (libraryColumns.has("owner_id") && libraryColumns.has("owner_type")) {
    db.prepare("UPDATE libraries SET owner_id = NULL, owner_type = NULL WHERE id = ?").run(inbox.id);
  }
}
