import path from "node:path";
import type Database from "better-sqlite3";

// 4.6: the Photo Inbox and App files become system libraries, marked by
// `libraries.role` (docs/system-data-plan.md, phase 1). Until now the Inbox was
// `policy_json.inbox` on any number of gallery libraries, and App files was the
// library the `house_library` setting named. The role takes over both, one
// library each, and the Inbox flag is stripped from every policy so nothing can
// read the old answer. The `house_library` row is left in place, unread.
//
// When several libraries were flagged as an Inbox, the one inside the App storage
// folder keeps the role (that is the one the Storage page showed), else the oldest;
// the others become ordinary gallery libraries.
export const version = 75;

type LibraryRow = { id: string; type: string; source_path: string; policy_json: string; created_at: string; role?: string | null };

function readJson(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function insideFolder(candidate: string, folder: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const child = norm(candidate);
  const parent = norm(folder);
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(libraries)").all() as { name: string }[]).map((c) => c.name)
  );
  if (columns.size === 0) return;
  if (!columns.has("role")) {
    db.exec("ALTER TABLE libraries ADD COLUMN role TEXT CHECK (role IN ('inbox', 'app-files'))");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_libraries_role ON libraries(role) WHERE role IS NOT NULL");
  // A hand-made test table without these has no Inbox to carry over.
  if (!columns.has("type") || !columns.has("policy_json")) return;

  const hasSettings = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'").get());
  const setting = (key: string): Record<string, unknown> => {
    if (!hasSettings) return {};
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return readJson(row?.value);
  };

  // Column by column: a migration test's hand-made table may lack the ones this
  // only uses to choose between several Inboxes.
  const sourcePath = columns.has("source_path") ? "source_path" : "'' AS source_path";
  const createdAt = columns.has("created_at") ? "created_at" : "'' AS created_at";
  const galleries = db.prepare(`SELECT id, type, ${sourcePath}, policy_json, ${createdAt}, role FROM libraries WHERE type = 'gallery' ORDER BY created_at, rowid`)
    .all() as LibraryRow[];

  // The Inbox: only when nothing holds the role yet, so a rerun changes nothing.
  if (!galleries.some((row) => row.role === "inbox")) {
    const flagged = galleries.filter((row) => readJson(row.policy_json).inbox === true);
    if (flagged.length > 0) {
      const appStorage = setting("app_storage").path;
      const inApp = typeof appStorage === "string" && appStorage.trim()
        ? flagged.find((row) => insideFolder(row.source_path, appStorage))
        : undefined;
      const chosen = inApp ?? flagged[0];
      db.prepare("UPDATE libraries SET role = 'inbox' WHERE id = ?").run(chosen.id);
      chosen.role = "inbox";
    }
  }

  // App files: the nominated library, unless it is (now) the Inbox.
  if (!galleries.some((row) => row.role === "app-files")) {
    const nominated = setting("house_library").libraryId;
    const house = typeof nominated === "string" ? galleries.find((row) => row.id === nominated) : undefined;
    if (house && !house.role) {
      db.prepare("UPDATE libraries SET role = 'app-files' WHERE id = ?").run(house.id);
    }
  }

  // Nothing reads the flag any more; leave no second answer behind.
  const strip = db.prepare("UPDATE libraries SET policy_json = ? WHERE id = ?");
  for (const row of galleries) {
    const policy = readJson(row.policy_json);
    if (!("inbox" in policy)) continue;
    delete policy.inbox;
    strip.run(JSON.stringify(policy), row.id);
  }
}
