import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { CATEGORY_SEED, ALIAS_SEED } from "./categories-seed.js";

export type Role = "admin" | "member";
export type ThemePreference = "system" | "light" | "dark" | "plain-light" | "plain-dark";

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
    theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('system', 'light', 'dark', 'plain-light', 'plain-dark')),
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
    token TEXT,
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

  CREATE TABLE IF NOT EXISTS narrators (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    UNIQUE (library_id, name)
  );

  CREATE TABLE IF NOT EXISTS series (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_name TEXT,
    UNIQUE (library_id, name)
  );

  CREATE TABLE IF NOT EXISTS genres (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    UNIQUE (library_id, name)
  );

  CREATE TABLE IF NOT EXISTS book_authors (
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'author' CHECK (role IN ('author', 'narrator')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (book_id, author_id, role)
  );

  CREATE TABLE IF NOT EXISTS book_genres (
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    genre_id TEXT NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, genre_id)
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
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, run_at);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_user_book ON book_bookmarks(user_id, book_id);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_book ON book_bookmarks(book_id);
  CREATE INDEX IF NOT EXISTS idx_saves_user ON book_saves(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_saves_book ON book_saves(book_id);
`);

const usersTable = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'users'").get() as { sql: string } | undefined;
if (usersTable?.sql && !usersTable.sql.includes("plain-light")) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN TRANSACTION;

    CREATE TABLE users_new (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('system', 'light', 'dark', 'plain-light', 'plain-dark')),
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
      theme,
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

const inviteColumns = db.prepare("PRAGMA table_info(invites)").all() as { name: string }[];
if (!inviteColumns.some((column) => column.name === "token")) {
  db.exec("ALTER TABLE invites ADD COLUMN token TEXT");
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

const seriesColumns = db.prepare("PRAGMA table_info(series)").all() as { name: string }[];
if (!seriesColumns.some((column) => column.name === "description")) {
  db.exec("ALTER TABLE series ADD COLUMN description TEXT");
}

const libraryColumns = db.prepare("PRAGMA table_info(libraries)").all() as { name: string }[];
if (!libraryColumns.some((column) => column.name === "owner_id")) {
  db.exec("ALTER TABLE libraries ADD COLUMN owner_id TEXT");
}
if (!libraryColumns.some((column) => column.name === "owner_type")) {
  db.exec("ALTER TABLE libraries ADD COLUMN owner_type TEXT CHECK (owner_type IN ('user', 'group'))");
}
if (!libraryColumns.some((column) => column.name === "visibility")) {
  db.exec("ALTER TABLE libraries ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('private', 'public'))");
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_libraries_owner      ON libraries(owner_id);
  CREATE INDEX IF NOT EXISTS idx_libraries_visibility ON libraries(visibility);
`);

const categoryColumns = db.prepare("PRAGMA table_info(categories)").all() as { name: string }[];
if (categoryColumns.length > 0 && !categoryColumns.some((column) => column.name === "icon")) {
  db.exec("ALTER TABLE categories ADD COLUMN icon TEXT");
}
if (categoryColumns.length > 0 && !categoryColumns.some((column) => column.name === "image_storage_key")) {
  db.exec("ALTER TABLE categories ADD COLUMN image_storage_key TEXT");
}

// Seed the navigation categories and alias keywords. Fill-gaps only: existing rows are
// never overwritten, so admin edits (renames, remapped/added/removed aliases) survive
// restarts. New seed entries added in code are still inserted on next boot.
{
  const insertCategory = db.prepare(
    "INSERT INTO categories (id, key, name, sort_order, icon) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING"
  );
  // Backfill the default icon only where one was never set (preserves admin choices).
  const backfillIcon = db.prepare("UPDATE categories SET icon = ? WHERE key = ? AND icon IS NULL");
  const categoryIdByKey = new Map<string, string>();
  const seedCategories = db.transaction(() => {
    for (const category of CATEGORY_SEED) {
      const existing = db.prepare("SELECT id FROM categories WHERE key = ?").get(category.key) as { id: string } | undefined;
      const id = existing?.id ?? nanoid(16);
      insertCategory.run(id, category.key, category.name, category.sortOrder, category.icon);
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
