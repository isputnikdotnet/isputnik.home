import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { CATEGORY_SEED, ALIAS_SEED } from "./categories-seed.js";

export type Role = "admin" | "member";
export const THEME_PREFERENCES = ["system", "light", "dark", "plain-light", "plain-dark", "expanse"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
const THEME_SQL_VALUES = THEME_PREFERENCES.map((theme) => `'${theme}'`).join(", ");

export interface User {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: Role;
  theme: ThemePreference;
  protected_from_delete: 0 | 1;
  is_active: 0 | 1;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ActivityInput {
  event: string;
  actorUserId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail: string;
  ipAddress?: string | null;
}

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
if (config.thumbnailPath) {
  fs.mkdirSync(config.thumbnailPath, { recursive: true });
}

// Apply a staged restore (set by the Backup screen) before opening the DB. We
// can't swap the file while better-sqlite3 holds it open, so a restore is staged
// as "<dbPath>.restore" and applied here on the next startup. The current DB is
// copied into the backups folder first as an automatic safety snapshot.
(function applyPendingRestore() {
  const restoreFile = `${config.dbPath}.restore`;
  if (!fs.existsSync(restoreFile)) {
    return;
  }
  try {
    if (fs.existsSync(config.dbPath)) {
      fs.mkdirSync(config.backupPath, { recursive: true });
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      fs.copyFileSync(config.dbPath, path.join(config.backupPath, `isputnik-${stamp}.sqlite`));
    }
    for (const ext of ["-wal", "-shm"]) {
      fs.rmSync(`${config.dbPath}${ext}`, { force: true });
    }
    fs.renameSync(restoreFile, config.dbPath);
  } catch (err) {
    // If the restore can't be applied, leave the current DB untouched and drop
    // the staging file so we don't loop on every boot.
    try { fs.rmSync(restoreFile, { force: true }); } catch { /* ignore */ }
    console.error("Pending restore failed; kept current database.", err);
  }
})();

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN (${THEME_SQL_VALUES})),
    protected_from_delete INTEGER NOT NULL DEFAULT 0 CHECK (protected_from_delete IN (0, 1)),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    device_name TEXT,
    ip_address TEXT,
    revoked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    used_by TEXT REFERENCES users(id),
    revoked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    event TEXT NOT NULL,
    actor_user_id TEXT REFERENCES users(id),
    target_type TEXT,
    target_id TEXT,
    detail TEXT NOT NULL,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS storage_roots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS libraries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    source_path TEXT NOT NULL,
    settings_json TEXT NOT NULL DEFAULT '{}',
    scan_status TEXT NOT NULL DEFAULT 'idle' CHECK (scan_status IN ('idle', 'scanning', 'error')),
    last_scanned_at TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    folder_path TEXT NOT NULL,
    series_id TEXT,
    series_position REAL,
    -- 'scan' = series auto-managed by the scanner; 'manual' = curated by a user and
    -- left untouched by rescans (see writeBookScan / series routes).
    series_source TEXT NOT NULL DEFAULT 'scan' CHECK (series_source IN ('scan', 'manual')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'error')),
    discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    UNIQUE (library_id, folder_path)
  );

  CREATE TABLE IF NOT EXISTS book_metadata (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL UNIQUE REFERENCES books(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'scan' CHECK (source IN ('scan', 'manual')),
    title TEXT,
    sort_title TEXT,
    description TEXT,
    year_published INTEGER,
    language TEXT,
    duration_seconds INTEGER,
    cover_storage_key TEXT,
    isbn TEXT,
    asin TEXT,
    publisher TEXT,
    openlibrary_id TEXT,
    category_id TEXT REFERENCES categories(id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS authors (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_name TEXT,
    bio TEXT,
    cover_storage_key TEXT,
    openlibrary_id TEXT,
    UNIQUE (library_id, name)
  );

  CREATE TABLE IF NOT EXISTS series (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_name TEXT,
    UNIQUE (library_id, name)
  );

  CREATE TABLE IF NOT EXISTS book_authors (
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'author' CHECK (role IN ('author', 'narrator')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (book_id, author_id, role)
  );

  -- Fixed, app-defined navigation categories (audiobook-specific). Seeded below.
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    icon TEXT,
    image_storage_key TEXT
  );

  -- Keyword -> category map used by the scanner to assign a primary category.
  CREATE TABLE IF NOT EXISTS category_aliases (
    id TEXT PRIMARY KEY,
    keyword TEXT NOT NULL UNIQUE,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    priority INTEGER NOT NULL DEFAULT 0
  );

  -- Global, freeform, cross-library-type tags.
  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Polymorphic tag links so any entity type (book, photo, note, ...) can be tagged.
  CREATE TABLE IF NOT EXISTS taggables (
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    PRIMARY KEY (tag_id, entity_type, entity_id)
  );
  CREATE INDEX IF NOT EXISTS idx_taggables_entity ON taggables(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_category_aliases_cat ON category_aliases(category_id);

  CREATE TABLE IF NOT EXISTS book_files (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    mime_type TEXT,
    track_number INTEGER,
    chapter_title TEXT,
    duration_seconds INTEGER,
    size INTEGER,
    modified_at TEXT,
    content_hash TEXT,
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'missing')),
    discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    UNIQUE (book_id, relative_path)
  );

  -- Companion documents bundled with an audiobook (PDF/EPUB siblings in the book
  -- folder). Assets of the book, not catalogued ebooks — see Documents/audiobook-library.md.
  CREATE TABLE IF NOT EXISTS book_documents (
    id            TEXT PRIMARY KEY,
    book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    format        TEXT NOT NULL,
    mime_type     TEXT,
    size          INTEGER,
    status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'missing')),
    discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at    TEXT,
    UNIQUE (book_id, relative_path)
  );
  CREATE INDEX IF NOT EXISTS idx_book_documents_book ON book_documents(book_id);

  CREATE TABLE IF NOT EXISTS playback_progress (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    current_file_id TEXT REFERENCES book_files(id) ON DELETE SET NULL,
    position_seconds INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER,
    percent_complete REAL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    UNIQUE (user_id, book_id)
  );

  CREATE TABLE IF NOT EXISTS reading_progress (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES book_documents(id) ON DELETE CASCADE,
    cfi TEXT NOT NULL,
    percent_complete REAL,
    label TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    UNIQUE (user_id, book_id, document_id)
  );

  CREATE TABLE IF NOT EXISTS book_bookmarks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    file_id TEXT REFERENCES book_files(id) ON DELETE SET NULL,
    position_seconds INTEGER NOT NULL DEFAULT 0,
    book_position_seconds INTEGER,
    label TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS book_saves (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, book_id)
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_at TEXT,
    locked_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    failed_at TEXT,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS user_groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id  TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'manager')),
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
  CREATE INDEX IF NOT EXISTS idx_group_members_user  ON group_members(user_id);


  -- Unified access model (see Documents/permissions.md). One row = "this subject
  -- (user or group) holds this role on this object". object_id/subject_id are
  -- polymorphic (no FK); app code resolves and cleans them. The library owner is just
  -- a 'manager' row; public access is the Everyone group's row.
  CREATE TABLE IF NOT EXISTS assignments (
    subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'group')),
    subject_id   TEXT NOT NULL,
    object_type  TEXT NOT NULL,
    object_id    TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('viewer', 'member', 'contributor', 'manager', 'deny')),
    created_by   TEXT REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (subject_type, subject_id, object_type, object_id)
  );
  CREATE INDEX IF NOT EXISTS idx_assignments_object  ON assignments(object_type, object_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_subject ON assignments(subject_type, subject_id);

  -- Item-level sharing, module-agnostic via (module, resource_id). See Documents/sharing.md.
  -- User-to-user shares: grant a specific account read access to one item.
  CREATE TABLE IF NOT EXISTS shares (
    id          TEXT PRIMARY KEY,
    module      TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission  TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'edit', 'manage')),
    created_by  TEXT NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at  TEXT,
    revoked_at  TEXT,
    UNIQUE (module, resource_id, user_id)
  );

  -- Guest link shares: anyone with the (hashed) token, until expiry. Required expiry.
  CREATE TABLE IF NOT EXISTS share_links (
    id          TEXT PRIMARY KEY,
    module      TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    permission  TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'edit', 'manage')),
    label       TEXT,
    expires_at  TEXT NOT NULL,
    created_by  TEXT NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_shares_resource      ON shares(module, resource_id);
  CREATE INDEX IF NOT EXISTS idx_shares_user          ON shares(user_id);
  CREATE INDEX IF NOT EXISTS idx_share_links_token    ON share_links(token_hash);
  CREATE INDEX IF NOT EXISTS idx_share_links_resource ON share_links(module, resource_id);
  -- "My shares" listing filters module + created_by + revoked_at, ordered by created_at.
  CREATE INDEX IF NOT EXISTS idx_share_links_owner    ON share_links(module, created_by, revoked_at, created_at);

  -- Author/narrator name aliases. Merging a person records a variant -> canonical
  -- mapping; the scanner resolves names through this before creating author rows,
  -- so merges survive rescans. Alias is case-insensitive.
  CREATE TABLE IF NOT EXISTS person_aliases (
    id             TEXT PRIMARY KEY,
    alias          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    canonical_name TEXT NOT NULL,
    created_by     TEXT REFERENCES users(id),
    created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_person_aliases_alias ON person_aliases(alias);

  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
  CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
  CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_libraries_type ON libraries(type);
  CREATE INDEX IF NOT EXISTS idx_books_library ON books(library_id, status);
  CREATE INDEX IF NOT EXISTS idx_books_series ON books(series_id);
  CREATE INDEX IF NOT EXISTS idx_book_files_book ON book_files(book_id, track_number);
  CREATE INDEX IF NOT EXISTS idx_book_authors_book ON book_authors(book_id);
  CREATE INDEX IF NOT EXISTS idx_book_authors_author ON book_authors(author_id);
  CREATE INDEX IF NOT EXISTS idx_progress_user ON playback_progress(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_progress_book ON playback_progress(book_id);
  CREATE INDEX IF NOT EXISTS idx_reading_progress_user ON reading_progress(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reading_progress_book ON reading_progress(book_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, run_at);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_user_book ON book_bookmarks(user_id, book_id);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_book ON book_bookmarks(book_id);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_user_updated ON book_bookmarks(user_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_saves_user ON book_saves(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_saves_book ON book_saves(book_id);

  -- User-curated collections ("playlists"). Generic across all library types and
  -- Notes: membership is polymorphic via (entity_type, entity_id) — the same
  -- convention as taggables/shares. Playback (continuous auto-advance) is a
  -- player-layer behaviour applied only to time-based entity types (audiobooks),
  -- not a property of the storage. Items reference resources by id with no FK, so
  -- module code must remove collection_items when a resource is deleted or purged.
  CREATE TABLE IF NOT EXISTS collections (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS collection_items (
    id            TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    entity_type   TEXT NOT NULL,
    entity_id     TEXT NOT NULL,
    position      REAL NOT NULL,
    added_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (collection_id, entity_type, entity_id)
  );

  CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_collection_items_collection ON collection_items(collection_id, position);
  CREATE INDEX IF NOT EXISTS idx_collection_items_entity ON collection_items(entity_type, entity_id);
`);

const usersTable = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'users'").get() as { sql: string } | undefined;
if (usersTable?.sql && !usersTable.sql.includes("'expanse'")) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN TRANSACTION;

    CREATE TABLE users_new (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN (${THEME_SQL_VALUES})),
      protected_from_delete INTEGER NOT NULL DEFAULT 0 CHECK (protected_from_delete IN (0, 1)),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT
    );

    INSERT INTO users_new (
      id,
      email,
      password_hash,
      display_name,
      role,
      theme,
      protected_from_delete,
      is_active,
      created_at,
      updated_at,
      deleted_at
    )
    SELECT
      id,
      email,
      password_hash,
      display_name,
      role,
      CASE WHEN theme = 'hard-orbit' THEN 'expanse' ELSE theme END,
      protected_from_delete,
      is_active,
      created_at,
      updated_at,
      deleted_at
    FROM users;

    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;

    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

const bookMetaColumns = db.prepare("PRAGMA table_info(book_metadata)").all() as { name: string }[];
if (!bookMetaColumns.some((column) => column.name === "asin")) {
  db.exec("ALTER TABLE book_metadata ADD COLUMN asin TEXT");
}
if (!bookMetaColumns.some((column) => column.name === "publisher")) {
  db.exec("ALTER TABLE book_metadata ADD COLUMN publisher TEXT");
}
if (!bookMetaColumns.some((column) => column.name === "category_id")) {
  db.exec("ALTER TABLE book_metadata ADD COLUMN category_id TEXT REFERENCES categories(id)");
}

const bookColumns = db.prepare("PRAGMA table_info(books)").all() as { name: string }[];
if (!bookColumns.some((column) => column.name === "series_source")) {
  // Existing rows default to 'scan'; users re-pin manual series afterwards.
  db.exec("ALTER TABLE books ADD COLUMN series_source TEXT NOT NULL DEFAULT 'scan'");
}

const seriesColumns = db.prepare("PRAGMA table_info(series)").all() as { name: string }[];
if (!seriesColumns.some((column) => column.name === "description")) {
  db.exec("ALTER TABLE series ADD COLUMN description TEXT");
}
if (!seriesColumns.some((column) => column.name === "cover_storage_key")) {
  db.exec("ALTER TABLE series ADD COLUMN cover_storage_key TEXT");
}

const libraryColumns = db.prepare("PRAGMA table_info(libraries)").all() as { name: string }[];
if (!libraryColumns.some((column) => column.name === "owner_id")) {
  db.exec("ALTER TABLE libraries ADD COLUMN owner_id TEXT");
}
if (!libraryColumns.some((column) => column.name === "owner_type")) {
  db.exec("ALTER TABLE libraries ADD COLUMN owner_type TEXT CHECK (owner_type IN ('user', 'group'))");
}
// Per-library mode + write policies (see Documents/permissions.md). JSON blob:
// { mode: 'managed'|'external', allowUpload, allowDelete, maxUploadMB }.
if (!libraryColumns.some((column) => column.name === "policy_json")) {
  db.exec("ALTER TABLE libraries ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}'");
}
// Legacy access columns superseded by the unified `assignments` table — visibility is
// the presence of an Everyone grant, public_role is that grant's role. Drop them.
if (libraryColumns.some((column) => column.name === "visibility")) {
  db.exec("DROP INDEX IF EXISTS idx_libraries_visibility");
  db.exec("ALTER TABLE libraries DROP COLUMN visibility");
}
if (libraryColumns.some((column) => column.name === "public_role")) {
  db.exec("ALTER TABLE libraries DROP COLUMN public_role");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_libraries_owner ON libraries(owner_id)");

// System/built-in groups marker (Everyone, System Admins). 'normal' for user groups.
const groupColumns = db.prepare("PRAGMA table_info(user_groups)").all() as { name: string }[];
if (!groupColumns.some((column) => column.name === "kind")) {
  db.exec("ALTER TABLE user_groups ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'system'))");
}

// library_members was superseded by the unified `assignments` table; its data was
// backfilled into assignments in an earlier build. Drop the leftover table.
db.exec("DROP TABLE IF EXISTS library_members");

// Deprecated taxonomy tables — scans write categories/tags instead, and narrators
// live in `authors` with book_authors.role = 'narrator'. Never read by the app.
db.exec("DROP TABLE IF EXISTS book_genres");
db.exec("DROP TABLE IF EXISTS genres");
db.exec("DROP TABLE IF EXISTS narrators");

// The "special libraries" / sections feature was removed. Drop its table and
// strip the deprecated section_id / overrides keys from each library's settings.
{
  const libraries = db.prepare("SELECT id, settings_json FROM libraries WHERE type = 'audiobook'")
    .all() as { id: string; settings_json: string | null }[];
  const updateSettings = db.prepare("UPDATE libraries SET settings_json = ? WHERE id = ?");
  for (const library of libraries) {
    try {
      const settings = JSON.parse(library.settings_json || "{}") as Record<string, unknown>;
      if ("section_id" in settings || "overrides" in settings) {
        delete settings.section_id;
        delete settings.overrides;
        updateSettings.run(JSON.stringify(settings), library.id);
      }
    } catch {
      // leave unparseable settings untouched
    }
  }
  db.exec("DROP TABLE IF EXISTS library_sections");
}

const categoryColumns = db.prepare("PRAGMA table_info(categories)").all() as { name: string }[];
if (categoryColumns.length > 0 && !categoryColumns.some((column) => column.name === "icon")) {
  db.exec("ALTER TABLE categories ADD COLUMN icon TEXT");
}
if (categoryColumns.length > 0 && !categoryColumns.some((column) => column.name === "image_storage_key")) {
  db.exec("ALTER TABLE categories ADD COLUMN image_storage_key TEXT");
}

// v2 taxonomy split the old combined Biographies & History bucket into
// Biographies & Memoirs plus History. Keep the old row/id for existing refs.
{
  const legacy = db.prepare("SELECT id FROM categories WHERE key = 'bio_history'").get() as { id: string } | undefined;
  const target = db.prepare("SELECT id FROM categories WHERE key = 'biographies_memoirs'").get() as { id: string } | undefined;
  if (legacy && !target) {
    db.prepare(`
      UPDATE categories
      SET
        key = 'biographies_memoirs',
        name = CASE WHEN name = 'Biographies & History' THEN 'Biographies & Memoirs' ELSE name END,
        sort_order = CASE WHEN sort_order = 5 THEN 9 ELSE sort_order END,
        icon = CASE WHEN icon IS NULL OR icon = 'landmark' THEN 'mic' ELSE icon END
      WHERE id = ?
    `).run(legacy.id);
  } else if (legacy && target) {
    db.transaction(() => {
      db.prepare("UPDATE book_metadata SET category_id = ? WHERE category_id = ?").run(target.id, legacy.id);
      db.prepare("UPDATE category_aliases SET category_id = ? WHERE category_id = ?").run(target.id, legacy.id);
      db.prepare("DELETE FROM categories WHERE id = ?").run(legacy.id);
    })();
  }
}

// Seed the navigation categories and alias keywords. Normal startup seeding is
// fill-gaps only so admin edits survive restarts. Versioned taxonomy migrations
// below can still adjust known defaults once when the category model changes.
{
  const insertCategory = db.prepare(
    "INSERT INTO categories (id, key, name, sort_order, icon, image_storage_key) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING"
  );
  // Backfill the default icon only where one was never set (preserves admin choices).
  const backfillIcon = db.prepare("UPDATE categories SET icon = ? WHERE key = ? AND icon IS NULL");
  const deletedCategoryKeysRow = db.prepare("SELECT value FROM app_settings WHERE key = 'deleted_category_keys'")
    .get() as { value: string } | undefined;
  let deletedCategoryKeys = new Set<string>();
  if (deletedCategoryKeysRow) {
    try {
      const parsed = JSON.parse(deletedCategoryKeysRow.value) as unknown;
      if (Array.isArray(parsed)) {
        deletedCategoryKeys = new Set(parsed.filter((key): key is string => typeof key === "string"));
      }
    } catch {
      deletedCategoryKeys = new Set<string>();
    }
  }
  const categoryIdByKey = new Map<string, string>();
  const seedCategories = db.transaction(() => {
    for (const category of CATEGORY_SEED) {
      const existing = db.prepare("SELECT id FROM categories WHERE key = ?").get(category.key) as { id: string } | undefined;
      if (!existing && deletedCategoryKeys.has(category.key)) {
        continue;
      }
      const id = existing?.id ?? nanoid(16);
      insertCategory.run(id, category.key, category.name, category.sortOrder, category.icon, category.defaultImageStorageKey ?? null);
      backfillIcon.run(category.icon, category.key);
      categoryIdByKey.set(category.key, id);
    }
  });
  seedCategories();

  const insertAlias = db.prepare(
    "INSERT INTO category_aliases (id, keyword, category_id, priority) VALUES (?, ?, ?, ?) ON CONFLICT(keyword) DO NOTHING"
  );
  const seedAliases = db.transaction(() => {
    for (const alias of ALIAS_SEED) {
      const categoryId = categoryIdByKey.get(alias.category);
      if (categoryId) {
        insertAlias.run(nanoid(16), alias.keyword, categoryId, alias.priority);
      }
    }
  });
  seedAliases();

  const taxonomyVersion = "2026-06-expanded-categories";
  const storedTaxonomyVersion = db.prepare("SELECT value FROM app_settings WHERE key = ?")
    .get("category_taxonomy_version") as { value: string } | undefined;
  if (storedTaxonomyVersion?.value !== taxonomyVersion) {
    const updateCategoryOrder = db.prepare("UPDATE categories SET sort_order = ? WHERE key = ?");
    const upsertAlias = db.prepare(`
      INSERT INTO category_aliases (id, keyword, category_id, priority)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(keyword) DO UPDATE SET
        category_id = excluded.category_id,
        priority = excluded.priority
    `);
    const saveTaxonomyVersion = db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `);
    db.transaction(() => {
      for (const category of CATEGORY_SEED) {
        updateCategoryOrder.run(category.sortOrder, category.key);
      }
      for (const alias of ALIAS_SEED) {
        const categoryId = categoryIdByKey.get(alias.category);
        if (categoryId) {
          upsertAlias.run(nanoid(16), alias.keyword, categoryId, alias.priority);
        }
      }
      saveTaxonomyVersion.run("category_taxonomy_version", taxonomyVersion);
    })();
  }
}

// One-time: split legacy combined tags into separate ones. Early scans stored a
// whole comma-separated genre string as a single tag (e.g. "Diets, Nutrition &
// Healthy Eating, Alternative & Complementary Medicine"). Split on comma/semicolon
// only — "&" stays — re-link each book to the parts, then drop the combined tag.
{
  const flagKey = "tags_split_combined_v1";
  const alreadyDone = db.prepare("SELECT 1 FROM app_settings WHERE key = ?").get(flagKey);
  if (!alreadyDone) {
    // Mirror of categorize.ts normalizeText so split tags dedupe against existing ones.
    const slug = (value: string) =>
      value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
        .replace(/[/_|]+/g, " ").replace(/\s+/g, " ").trim();
    const combined = db.prepare(
      "SELECT id, display_name FROM tags WHERE display_name LIKE '%,%' OR display_name LIKE '%;%'"
    ).all() as { id: string; display_name: string }[];

    db.transaction(() => {
      for (const tag of combined) {
        const parts = tag.display_name.split(/\s*[,;]\s*/).map((p) => p.trim()).filter(Boolean);
        if (parts.length <= 1) continue;

        const links = db.prepare("SELECT entity_type, entity_id FROM taggables WHERE tag_id = ?")
          .all(tag.id) as { entity_type: string; entity_id: string }[];
        for (const link of links) {
          for (const part of parts) {
            const key = slug(part);
            if (!key) continue;
            let row = db.prepare("SELECT id FROM tags WHERE key = ?").get(key) as { id: string } | undefined;
            if (!row) {
              db.prepare("INSERT INTO tags (id, key, display_name) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING")
                .run(nanoid(16), key, part);
              row = db.prepare("SELECT id FROM tags WHERE key = ?").get(key) as { id: string };
            }
            db.prepare("INSERT OR IGNORE INTO taggables (tag_id, entity_type, entity_id) VALUES (?, ?, ?)")
              .run(row.id, link.entity_type, link.entity_id);
          }
        }
        db.prepare("DELETE FROM taggables WHERE tag_id = ?").run(tag.id);
        db.prepare("DELETE FROM tags WHERE id = ?").run(tag.id);
      }
      db.prepare(`
        INSERT INTO app_settings (key, value, updated_at) VALUES (?, 'done', CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = 'done', updated_at = CURRENT_TIMESTAMP
      `).run(flagKey);
    })();
  }
}

export function hasUsers() {
  const row = db.prepare("SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL").get() as { count: number };
  return row.count > 0;
}

export function logActivity(input: ActivityInput) {
  db.prepare(`
    INSERT INTO activity_logs (id, event, actor_user_id, target_type, target_id, detail, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    nanoid(16),
    input.event,
    input.actorUserId ?? null,
    input.targetType ?? null,
    input.targetId ?? null,
    input.detail,
    input.ipAddress ?? null
  );
}

export function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    theme: user.theme,
    protectedFromDelete: Boolean(user.protected_from_delete),
    isActive: Boolean(user.is_active),
    createdAt: user.created_at,
    deletedAt: user.deleted_at
  };
}
