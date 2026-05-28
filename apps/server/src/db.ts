import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { config } from "./config.js";

export type Role = "admin" | "member";

export interface User {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: Role;
  theme: "system" | "light" | "dark";
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
    theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('system', 'light', 'dark')),
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
`);

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
