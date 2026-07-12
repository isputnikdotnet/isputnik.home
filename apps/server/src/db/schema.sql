-- iSputnik Home — canonical database schema (baseline, migration 0).
--
-- Design rules (see docs/database.md):
--   * Generic spine: `library_items` is the universal item; per-type detail
--     tables (`audiobook_details`, `ebook_details`) extend it 1:1 by item_id.
--   * Shared concerns (metadata, people, series, categories, tags, collections,
--     permissions, sharing, trash) are media-agnostic and keyed to items.
--   * People and series are GLOBAL (not library-scoped) so they span libraries.
--   * Timestamps are ISO-8601 UTC with milliseconds ('YYYY-MM-DDThh:mm:ss.sssZ')
--     — the strftime() default below matches JS `new Date().toISOString()`, so a
--     column never holds two formats. Use nowIso() for app-written timestamps.
--   * Booleans are INTEGER 0/1 with a CHECK. Enums are CHECK (... IN ...).
--   * Polymorphic links (assignments, taggables, collection_items, shares,
--     trashed_items) carry no FK on the polymorphic id — app code cleans them.
--
-- The `libraries.type` and polymorphic `*_type` columns are intentionally NOT
-- CHECK-constrained so new media types need no schema change (enforced in app
-- code via Zod).

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- ════════════════════════════════════════════════════════════════════════════
--  Identity & access
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash         TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  theme                 TEXT NOT NULL DEFAULT 'dark',
  protected_from_delete INTEGER NOT NULL DEFAULT 0 CHECK (protected_from_delete IN (0, 1)),
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at            TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  device_name   TEXT,
  ip_address    TEXT,
  revoked_at    TEXT
);

-- Short-lived second-factor step between password success and a full session.
-- One row per in-progress MFA sign-in; cleared on success, expiry, or attempt cap.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0
);

-- Brute-force defense & source-IP access control.
-- Every sign-in attempt, used to derive per-account lockout and per-IP auto-block.
CREATE TABLE IF NOT EXISTS login_attempts (
  id          TEXT PRIMARY KEY,
  email       TEXT,
  ip_address  TEXT,
  successful  INTEGER NOT NULL DEFAULT 0 CHECK (successful IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts (email, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts (ip_address, created_at);

-- Blocked source IPs: manual (auto = 0, usually no expiry) or automatic
-- (auto = 1, with a cooldown expiry).
CREATE TABLE IF NOT EXISTS blocked_ips (
  ip_address  TEXT PRIMARY KEY,
  reason      TEXT,
  auto        INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT,
  created_by  TEXT REFERENCES users(id)
);

-- Trusted networks (CIDR). A request from one is a relaxed zone: rate limits,
-- lockout, and MFA are skipped. Empty by default — admins opt in their LAN range.
CREATE TABLE IF NOT EXISTS trusted_networks (
  id          TEXT PRIMARY KEY,
  cidr        TEXT NOT NULL UNIQUE,
  label       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by  TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  used_by     TEXT REFERENCES users(id),
  revoked_at  TEXT
);

CREATE TABLE IF NOT EXISTS user_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind        TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'system')),
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id   TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'manager')),
  joined_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (group_id, user_id)
);

-- Unified access model. One row = "this subject (user/group) holds this role on
-- this object". subject_id/object_id are polymorphic (no FK). Public access is
-- the built-in Everyone group's row; an owner is just a 'manager' row.
CREATE TABLE IF NOT EXISTS assignments (
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('user', 'group')),
  subject_id    TEXT NOT NULL,
  object_type   TEXT NOT NULL,            -- 'library' | 'library_item' | 'collection' | …
  object_id     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('viewer', 'member', 'contributor', 'manager', 'deny')),
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (subject_type, subject_id, object_type, object_id)
);

-- ════════════════════════════════════════════════════════════════════════════
--  Libraries & items
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS storage_roots (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS libraries (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL,           -- 'audiobook' | 'ebook' | 'gallery' | … (app-enforced)
  source_path     TEXT NOT NULL,
  owner_id        TEXT,                    -- logical owner (polymorphic by owner_type)
  owner_type      TEXT CHECK (owner_type IN ('user', 'group')),
  policy_json     TEXT NOT NULL DEFAULT '{}',  -- { mode: 'managed'|'external', allowUpload, allowDelete, … }
  settings_json   TEXT NOT NULL DEFAULT '{}',
  scan_status     TEXT NOT NULL DEFAULT 'idle' CHECK (scan_status IN ('idle', 'scanning', 'error')),
  last_scanned_at TEXT,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The universal item. One row per item folder, regardless of media type. The
-- `type` mirrors its library's type and selects the detail/file tables used.
CREATE TABLE IF NOT EXISTS library_items (
  id            TEXT PRIMARY KEY,
  library_id    TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,            -- 'audiobook' | 'ebook' | …
  folder_path   TEXT NOT NULL,           -- relative to the library source_path
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'error')),
  -- 'manual' = the item's series membership is user-curated; the scanner won't touch it.
  series_source TEXT NOT NULL DEFAULT 'scan' CHECK (series_source IN ('scan', 'manual')),
  discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at    TEXT,
  UNIQUE (library_id, folder_path)
);

-- Shared descriptive metadata, 1:1 with library_items. `source` = 'manual'
-- protects the row from scanner overwrites.
CREATE TABLE IF NOT EXISTS item_metadata (
  item_id           TEXT PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
  source            TEXT NOT NULL DEFAULT 'scan' CHECK (source IN ('scan', 'manual')),
  title             TEXT,
  sort_title        TEXT,
  description       TEXT,
  language          TEXT,
  publisher         TEXT,
  year_published    INTEGER,
  isbn              TEXT,
  openlibrary_id    TEXT,
  cover_storage_key TEXT,
  rating            REAL,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Type-specific extensions, 1:1 with library_items.
CREATE TABLE IF NOT EXISTS audiobook_details (
  item_id          TEXT PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
  asin             TEXT,
  duration_seconds INTEGER
);

CREATE TABLE IF NOT EXISTS ebook_details (
  item_id     TEXT PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
  page_count  INTEGER
);

-- Gallery (photo/video) detail, 1:1 with library_items. Unlike book-like types a
-- gallery item is a SINGLE asset (one file = one item, like ebooks), so the file
-- itself is described here rather than in a separate media-files table.
-- `taken_at` (from EXIF, falling back to file mtime) drives the date Timeline;
-- `relative_path`'s directory drives the Folder view. GPS/camera feed the Map
-- view, the lightbox Info panel, and the location/camera filters.
CREATE TABLE IF NOT EXISTS gallery_details (
  item_id             TEXT PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'video')),
  relative_path       TEXT NOT NULL,
  mime_type           TEXT,
  size                INTEGER,
  width               INTEGER,
  height              INTEGER,
  orientation         INTEGER,
  -- User-applied clockwise rotation in degrees (0/90/180/270), baked into the
  -- generated thumbnails on top of EXIF orientation. Owned by the user, so a
  -- rescan preserves it (the gallery_details UPSERT never writes this column).
  rotation            INTEGER NOT NULL DEFAULT 0,
  duration_seconds    REAL,
  taken_at            TEXT,
  -- 'manual' = the date was set by a user (edit modal) and a rescan must not
  -- overwrite it; 'scan' = derived from EXIF / file mtime.
  taken_at_source     TEXT NOT NULL DEFAULT 'scan' CHECK (taken_at_source IN ('scan', 'manual')),
  modified_at         TEXT,
  gps_lat             REAL,
  gps_lng             REAL,
  -- 'manual' = the location was set by a user (Info panel) and a rescan must not
  -- overwrite it; 'scan' = derived from EXIF.
  gps_source          TEXT NOT NULL DEFAULT 'scan' CHECK (gps_source IN ('scan', 'manual')),
  camera_make         TEXT,
  camera_model        TEXT,
  preview_storage_key TEXT,
  -- Video only: 1 = a browser <video> can play the file as-is, 0 = unsupported
  -- container/codec (legacy AVI/MJPEG, WMV, …), NULL = unknown/photo/not probed.
  -- We serve originals untranscoded, so this drives the "download to view" hint.
  playable            INTEGER,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_gallery_taken_at ON gallery_details(taken_at);

-- People in photos. A `gallery_people` row is a named person (e.g. "Mum") that spans
-- every gallery library (people are global, like book contributors). It doubles as
-- the auto-grouping "cluster": `centroid` (a mean face embedding) is filled by the
-- optional face-recognition pass; manual whole-photo tagging leaves it NULL.
-- `linked_person_id` is a future bridge to the global `people` table (unused today).
CREATE TABLE IF NOT EXISTS gallery_people (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  linked_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  cover_face_id    TEXT,                          -- chosen representative face (Phase 2)
  hidden           INTEGER NOT NULL DEFAULT 0,    -- hide a noisy auto-cluster from the People list
  curated          INTEGER NOT NULL DEFAULT 0,    -- user-shaped (a merge target): anchors reclustering like a name does
  face_count       INTEGER NOT NULL DEFAULT 0,    -- distinct accessible items; recomputed on change
  centroid         BLOB,                          -- mean embedding for fast auto-assign (Phase 2)
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Gallery albums: hand-curated photo sets spanning every gallery library (the
-- everyday organization tool; Collections stay the cross-user presentation
-- feature). Viewable by every member — items are filtered per viewer's library
-- access on read — and editable by the creator + admins. sort_mode 'taken_at'
-- shows members chronologically; 'manual' uses position (append order today;
-- REAL so a future drag-reorder can insert between neighbors).
CREATE TABLE IF NOT EXISTS gallery_albums (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  cover_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL,
  sort_mode     TEXT NOT NULL DEFAULT 'taken_at' CHECK (sort_mode IN ('taken_at', 'manual')),
  created_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS gallery_album_items (
  album_id TEXT NOT NULL REFERENCES gallery_albums(id) ON DELETE CASCADE,
  item_id  TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (album_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_gallery_album_items_item ON gallery_album_items (item_id);

-- One appearance of a person in one asset. A manual whole-photo tag is a row with a
-- NULL box (box_* / det_score / embedding all NULL, source 'manual'); an
-- auto-detected face fills the normalised [0,1] box + embedding (source 'scan'). The
-- two share this table so the manual-first feature and the optional ML pass are one
-- data model. `assignment` tracks how a face reached its person: a confirmed manual
-- tag, an auto guess, a user-confirmed/-rejected suggestion.
CREATE TABLE IF NOT EXISTS gallery_faces (
  id                TEXT PRIMARY KEY,
  item_id           TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  person_id         TEXT REFERENCES gallery_people(id) ON DELETE SET NULL,
  box_x             REAL,                          -- normalised [0,1]; NULL = whole-photo tag
  box_y             REAL,
  box_w             REAL,
  box_h             REAL,
  det_score         REAL,
  embedding         BLOB,                          -- face descriptor (Phase 2)
  embedding_model   TEXT,                          -- tag for invalidation when the model changes
  assignment        TEXT NOT NULL DEFAULT 'confirmed'
                      CHECK (assignment IN ('auto', 'suggested', 'confirmed', 'rejected')),
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'scan')),
  thumb_storage_key TEXT,                          -- cropped face thumbnail (Phase 2); NULL = use item cover
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Custom scan rules: a path-scoped override of the default scanner for specific
-- folders in a library (docs/custom-scan-rules-proposal.md). An enabled rule owns
-- and scans its folders with its own layout pattern; the default scanner skips
-- them. Items it catalogs carry library_items.scan_rule_id = the rule's id.
CREATE TABLE IF NOT EXISTS library_scan_rules (
  id          TEXT PRIMARY KEY,
  library_id  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,   -- 0 = disabled; the default scanner owns its scope
  preset      TEXT,                          -- optional preset id the pattern came from (UI label)
  pattern     TEXT NOT NULL,                 -- declarative layout pattern (see scan-rule-pattern.ts)
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Folders a rule owns, relative to the library source. A folder belongs to at most
-- one rule (UNIQUE per library), so path specificity alone resolves ownership.
CREATE TABLE IF NOT EXISTS library_scan_rule_paths (
  rule_id        TEXT NOT NULL REFERENCES library_scan_rules(id) ON DELETE CASCADE,
  library_id     TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  relative_path  TEXT NOT NULL,
  PRIMARY KEY (rule_id, relative_path),
  UNIQUE (library_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_scan_rules_library      ON library_scan_rules(library_id);
CREATE INDEX IF NOT EXISTS idx_scan_rule_paths_library ON library_scan_rule_paths(library_id);

-- ════════════════════════════════════════════════════════════════════════════
--  People, series, categories, tags  (all global / cross-library)
-- ════════════════════════════════════════════════════════════════════════════

-- Contributors of every kind — authors, narrators, editors, artists,
-- photographers. Global: the same person can appear across libraries/types.
CREATE TABLE IF NOT EXISTS people (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_name         TEXT,
  bio               TEXT,
  image_storage_key TEXT,
  openlibrary_id    TEXT,
  enriched_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS item_people (
  item_id    TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  person_id  TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'author'
               CHECK (role IN ('author', 'narrator', 'editor', 'artist', 'photographer', 'contributor')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, person_id, role)
);

-- Variant-name → canonical-name merges; the scanner resolves names through this
-- before creating/looking up people, so merges survive rescans.
CREATE TABLE IF NOT EXISTS person_aliases (
  id             TEXT PRIMARY KEY,
  alias          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  canonical_name TEXT NOT NULL,
  created_by     TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A book series belongs to one library (unlike people, which are global). Item
-- membership + ordering live in series_items.
CREATE TABLE IF NOT EXISTS series (
  id                TEXT PRIMARY KEY,
  library_id        TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  sort_name         TEXT,
  description       TEXT,
  cover_storage_key TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (library_id, name COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS series_items (
  series_id  TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  position   REAL,                         -- decimals allowed (2.5 = novella)
  source     TEXT NOT NULL DEFAULT 'scan' CHECK (source IN ('scan', 'manual')),
  PRIMARY KEY (series_id, item_id)
);

-- A "work" groups library_items that are the SAME book in different editions:
-- two ebook printings/translations, two narrator recordings, or the audiobook +
-- ebook of one title. Works are GLOBAL (cross-library, cross-type) like people.
-- The work holds no descriptive metadata of its own — every display resolves
-- through a member edition, leaving room to add a canonical title/cover here
-- later. A work is meaningful only with >= 2 members; app code deletes an emptied one.
CREATE TABLE IF NOT EXISTS works (
  id         TEXT PRIMARY KEY,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Edition membership. An item belongs to at most one work (item_id is UNIQUE).
-- `is_primary` is a per-(work, media-type) PREFERENCE, not a load-bearing pointer:
-- the catalog DERIVES each work's browse representative as the preferred-then-
-- lowest-id surviving edition of a type, so deleting/unlinking a primary can never
-- strand its siblings. Both ids carry real FKs (not polymorphic, unlike taggables/
-- collection_items) — a deleted item or work cascades its membership away.
CREATE TABLE IF NOT EXISTS work_items (
  work_id    TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL UNIQUE REFERENCES library_items(id) ON DELETE CASCADE,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  added_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (work_id, item_id)
);

-- Fixed navigation taxonomy. `parent_id` allows an optional hierarchy.
CREATE TABLE IF NOT EXISTS categories (
  id                TEXT PRIMARY KEY,
  key               TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  slug              TEXT,
  parent_id         TEXT REFERENCES categories(id) ON DELETE SET NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  icon              TEXT,
  image_storage_key TEXT
);

-- keyword → category map the scanner uses to assign categories.
CREATE TABLE IF NOT EXISTS category_aliases (
  id          TEXT PRIMARY KEY,
  keyword     TEXT NOT NULL UNIQUE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  priority    INTEGER NOT NULL DEFAULT 0
);

-- Many-to-many: an item may hold several categories; one is primary. `source`
-- records who set it so manual choices survive rescans.
CREATE TABLE IF NOT EXISTS item_categories (
  item_id     TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  is_primary  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  source      TEXT NOT NULL DEFAULT 'scan' CHECK (source IN ('scan', 'manual', 'metadata', 'ai')),
  PRIMARY KEY (item_id, category_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id           TEXT PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Polymorphic tag links — any entity type (library_item, person, series, …).
CREATE TABLE IF NOT EXISTS taggables (
  tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,               -- 'library_item' | 'person' | 'series' | …
  entity_id   TEXT NOT NULL,
  PRIMARY KEY (tag_id, entity_type, entity_id)
);

-- ════════════════════════════════════════════════════════════════════════════
--  Media files
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS audio_files (
  id               TEXT PRIMARY KEY,
  item_id          TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  relative_path    TEXT NOT NULL,
  mime_type        TEXT,
  track_number     INTEGER,
  title            TEXT,
  duration_seconds INTEGER,
  size             INTEGER,
  modified_at      TEXT,
  content_hash     TEXT,
  status           TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'missing')),
  discovered_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at       TEXT,
  UNIQUE (item_id, relative_path)
);

-- Embedded chapter markers parsed from within one audio file (m4b/MP4 chapter
-- tracks, MP3 CHAP/CTOC). A file with no embedded chapters has no rows here.
CREATE TABLE IF NOT EXISTS audio_chapters (
  id            TEXT PRIMARY KEY,
  audio_file_id TEXT NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  start_seconds REAL NOT NULL,
  end_seconds   REAL,
  UNIQUE (audio_file_id, ordinal)
);

-- Document files. `role` = 'content' (the ebook itself) or 'companion' (a PDF/
-- EPUB bundled alongside an audiobook). One table, two clearly-labelled roles.
CREATE TABLE IF NOT EXISTS document_files (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'content' CHECK (role IN ('content', 'companion')),
  relative_path TEXT NOT NULL,
  format        TEXT NOT NULL,             -- 'epub' | 'pdf' | 'cbz' | 'mobi' | …
  mime_type     TEXT,
  size          INTEGER,
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'missing')),
  discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at    TEXT,
  UNIQUE (item_id, relative_path)
);

-- ════════════════════════════════════════════════════════════════════════════
--  Per-user progress & bookmarks
-- ════════════════════════════════════════════════════════════════════════════

-- Linear audiobook progress — one row per (user, item).
CREATE TABLE IF NOT EXISTS playback_progress (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id          TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  current_file_id  TEXT REFERENCES audio_files(id) ON DELETE SET NULL,
  position_seconds INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER,
  percent_complete REAL,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at     TEXT,
  UNIQUE (user_id, item_id)
);

-- Per-track progress for episodic items (radio shows, podcasts).
CREATE TABLE IF NOT EXISTS track_progress (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id          TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  file_id          TEXT NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
  position_seconds INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER,
  completed_at     TEXT,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, file_id)
);

-- Ebook reading progress — anchored on (item, document). `location` holds an
-- EPUB CFI today; the column is named generically for other formats.
CREATE TABLE IF NOT EXISTS reading_progress (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id          TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  document_id      TEXT NOT NULL REFERENCES document_files(id) ON DELETE CASCADE,
  location         TEXT NOT NULL,
  percent_complete REAL,
  label            TEXT,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at     TEXT,
  UNIQUE (user_id, item_id, document_id)
);

CREATE TABLE IF NOT EXISTS audio_bookmarks (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id               TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  file_id               TEXT REFERENCES audio_files(id) ON DELETE SET NULL,
  position_seconds      INTEGER NOT NULL DEFAULT 0,
  item_position_seconds INTEGER,           -- absolute offset within the whole item
  label                 TEXT,
  note                  TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS reading_bookmarks (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id          TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  document_id      TEXT NOT NULL REFERENCES document_files(id) ON DELETE CASCADE,
  location         TEXT NOT NULL,
  percent_complete REAL,
  label            TEXT,
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Quotes / highlights. A first-class entity, not just an in-book highlight: a
-- quote may be captured in the reader (item_id + document_id + cfi all set, with
-- an on-page highlight anchored by the cfi) OR brought in from outside the library
-- (all three NULL — just `text` plus a free-text source). FKs are ON DELETE SET
-- NULL (not CASCADE) so removing a book degrades its quotes to external ones rather
-- than deleting them; source_title/source_author are snapshotted at save time so
-- attribution survives that. Display prefers the live item when item_id is still set.
CREATE TABLE IF NOT EXISTS quotes (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id          TEXT REFERENCES library_items(id) ON DELETE SET NULL,
  document_id      TEXT REFERENCES document_files(id) ON DELETE SET NULL,
  cfi              TEXT,
  text             TEXT NOT NULL,
  note             TEXT,
  color            TEXT,
  source_title     TEXT,
  source_author    TEXT,
  percent_complete REAL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- "My List" — per-user saved items, one row per (user, item).
CREATE TABLE IF NOT EXISTS item_saves (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, item_id)
);

-- ════════════════════════════════════════════════════════════════════════════
--  Collections & item-level sharing
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Polymorphic membership (entity_type/entity_id), like taggables. No FK on
-- entity_id; module code removes rows when a resource is deleted.
CREATE TABLE IF NOT EXISTS collection_items (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,             -- 'library_item' | …
  entity_id     TEXT NOT NULL,
  position      REAL NOT NULL,
  added_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (collection_id, entity_type, entity_id)
);

-- User-to-user item shares, module-agnostic via (module, resource_id).
CREATE TABLE IF NOT EXISTS shares (
  id          TEXT PRIMARY KEY,
  module      TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'edit', 'manage')),
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT,
  revoked_at  TEXT,
  UNIQUE (module, resource_id, user_id)
);

-- Guest link shares: anyone with the (hashed) token until expiry.
CREATE TABLE IF NOT EXISTS share_links (
  id          TEXT PRIMARY KEY,
  module      TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  permission  TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'edit', 'manage')),
  label       TEXT,
  expires_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at  TEXT
);

-- Members of a multi-item guest link (gallery "quick links", module
-- 'gallery_set'; resource_id self-references the link id since there is no
-- single resource). A snapshot of the selection at share time: rows cascade
-- with the link, and a hard-deleted item drops out (the public page simply
-- shows fewer photos).
CREATE TABLE IF NOT EXISTS share_link_items (
  id            TEXT PRIMARY KEY,
  share_link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  UNIQUE (share_link_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_share_link_items_link ON share_link_items (share_link_id, position);

-- Personal access tokens. A user mints one per device to authenticate
-- non-cookie clients (today: OPDS readers). Only the sha256(token) is stored;
-- the raw value is shown once at creation. Read-only, scoped, revocable.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL DEFAULT 'opds',   -- only 'opds' for now; room to grow
  label        TEXT,                            -- "Kobo Clara", user-supplied
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT,
  last_ip      TEXT,
  expires_at   TEXT,                            -- NULL = no expiry
  revoked_at   TEXT
);

-- ════════════════════════════════════════════════════════════════════════════
--  Recycle bin & system
-- ════════════════════════════════════════════════════════════════════════════

-- Deleting an item moves its files into <source>/.trash/<token>/ and removes the
-- library_items row; everything needed to restore/purge is snapshotted here.
-- library_id has NO FK: a library may be deleted while its trash still needs purging.
CREATE TABLE IF NOT EXISTS trashed_items (
  id           TEXT PRIMARY KEY,
  library_id   TEXT NOT NULL,
  library_type TEXT NOT NULL,
  library_name TEXT NOT NULL,
  source_path  TEXT NOT NULL,
  title        TEXT NOT NULL,
  origin_path  TEXT NOT NULL,
  trash_path   TEXT NOT NULL,
  file_count   INTEGER NOT NULL DEFAULT 0,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  trashed_by   TEXT REFERENCES users(id),
  trashed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id            TEXT PRIMARY KEY,
  event         TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  target_type   TEXT,
  target_id     TEXT,
  detail        TEXT NOT NULL,
  ip_address    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  locked_at    TEXT,
  locked_by    TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- When the worker actually began RUNNING the job (set on claim, never cleared),
  -- so finished-task duration reflects run time, not time spent waiting in the
  -- queue. locked_at is cleared on completion, so it can't serve this purpose.
  started_at   TEXT,
  completed_at TEXT,
  failed_at    TEXT,
  error        TEXT
);

-- Recurring maintenance tasks (clean job logs, empty recycle bin, …). The set of
-- jobs is defined in code (modules/maintenance); this table holds only their
-- per-key state: whether enabled, how often, and the last/next run. A missing row
-- means "never configured" → disabled with code defaults. Disabled by default.
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  key          TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 0,
  frequency    TEXT NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  -- Admin-chosen schedule details; NULL means "use the job's built-in default".
  -- run_time is a local "HH:MM" clock time; day_of_week 0=Sunday..6=Saturday
  -- (weekly jobs); day_of_month 1..28 (monthly jobs, capped so every month has it).
  run_time     TEXT CHECK (run_time IS NULL OR run_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  day_of_week  INTEGER CHECK (day_of_week IS NULL OR day_of_week BETWEEN 0 AND 6),
  day_of_month INTEGER CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 28),
  next_run_at  TEXT,
  last_run_at  TEXT,
  last_status  TEXT CHECK (last_status IN ('success', 'error')),
  last_message TEXT,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ════════════════════════════════════════════════════════════════════════════
--  Indexes
-- ════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_sessions_user_id        ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash      ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_invites_token_hash       ON invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_group_members_group      ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user       ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_assignments_object       ON assignments(object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_assignments_subject      ON assignments(subject_type, subject_id);

CREATE INDEX IF NOT EXISTS idx_libraries_type           ON libraries(type);
CREATE INDEX IF NOT EXISTS idx_libraries_owner          ON libraries(owner_id);
CREATE INDEX IF NOT EXISTS idx_items_library            ON library_items(library_id, status);
CREATE INDEX IF NOT EXISTS idx_items_type               ON library_items(type);

CREATE INDEX IF NOT EXISTS idx_item_people_item         ON item_people(item_id);
CREATE INDEX IF NOT EXISTS idx_item_people_person       ON item_people(person_id);
CREATE INDEX IF NOT EXISTS idx_series_library          ON series(library_id);
CREATE INDEX IF NOT EXISTS idx_series_items_series      ON series_items(series_id);
CREATE INDEX IF NOT EXISTS idx_series_items_item        ON series_items(item_id);
CREATE INDEX IF NOT EXISTS idx_item_categories_item     ON item_categories(item_id);
CREATE INDEX IF NOT EXISTS idx_item_categories_category ON item_categories(category_id);
CREATE INDEX IF NOT EXISTS idx_category_aliases_cat     ON category_aliases(category_id);
CREATE INDEX IF NOT EXISTS idx_taggables_entity         ON taggables(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_person_aliases_alias     ON person_aliases(alias);
CREATE INDEX IF NOT EXISTS idx_gallery_faces_item        ON gallery_faces(item_id);
CREATE INDEX IF NOT EXISTS idx_gallery_faces_person      ON gallery_faces(person_id);

-- Per-item record of the face-detection pass, so a (re)scan only processes items it
-- hasn't seen. A row is upserted after an item is detected; `force` deletes rows to
-- reprocess. Separate table (not a gallery_details column) so it needs no migration.
-- A decode/detect failure is recorded too (status 'failed' + attempts), so a photo
-- that can't be processed (corrupt file, unsupported codec) is retried a bounded
-- number of times and then skipped, instead of clogging every incremental scan
-- forever. A force rescan — or a model change — gives it a fresh chance.
CREATE TABLE IF NOT EXISTS gallery_face_scans (
  item_id    TEXT PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
  scanned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  model      TEXT,
  face_count INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'ok',      -- 'ok' | 'failed' (decode/detect error)
  attempts   INTEGER NOT NULL DEFAULT 0       -- consecutive failures under `model`
);

-- User corrections: "this person is NOT in this photo". Recorded whenever a person is
-- removed from a photo, and re-applied after every clustering pass — so a full rescan
-- (which re-detects every face from scratch) can't silently put the photo back into
-- that person. Keyed by (item, person); cascades away if either is deleted.
CREATE TABLE IF NOT EXISTS gallery_face_exclusions (
  item_id    TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  person_id  TEXT NOT NULL REFERENCES gallery_people(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (item_id, person_id)
);

CREATE INDEX IF NOT EXISTS idx_audio_files_item         ON audio_files(item_id, track_number);
CREATE INDEX IF NOT EXISTS idx_audio_chapters_file      ON audio_chapters(audio_file_id);
CREATE INDEX IF NOT EXISTS idx_document_files_item      ON document_files(item_id);

CREATE INDEX IF NOT EXISTS idx_playback_user            ON playback_progress(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_playback_item            ON playback_progress(item_id);
CREATE INDEX IF NOT EXISTS idx_track_progress_item      ON track_progress(user_id, item_id);
CREATE INDEX IF NOT EXISTS idx_reading_user             ON reading_progress(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_reading_item             ON reading_progress(item_id);
CREATE INDEX IF NOT EXISTS idx_audio_bookmarks_user     ON audio_bookmarks(user_id, item_id);
CREATE INDEX IF NOT EXISTS idx_reading_bookmarks_user   ON reading_bookmarks(user_id, item_id);
CREATE INDEX IF NOT EXISTS idx_quotes_user               ON quotes(user_id, datetime(created_at) DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_user_document      ON quotes(user_id, document_id);
CREATE INDEX IF NOT EXISTS idx_item_saves_user          ON item_saves(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user          ON api_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_collections_user         ON collections(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_items_coll    ON collection_items(collection_id, position);
CREATE INDEX IF NOT EXISTS idx_collection_items_entity  ON collection_items(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_shares_resource          ON shares(module, resource_id);
CREATE INDEX IF NOT EXISTS idx_shares_user              ON shares(user_id);
CREATE INDEX IF NOT EXISTS idx_share_links_token        ON share_links(token_hash);
CREATE INDEX IF NOT EXISTS idx_share_links_resource     ON share_links(module, resource_id);
CREATE INDEX IF NOT EXISTS idx_share_links_owner        ON share_links(module, created_by, revoked_at, created_at);

CREATE INDEX IF NOT EXISTS idx_trashed_items_lib        ON trashed_items(library_id);
CREATE INDEX IF NOT EXISTS idx_trashed_items_at         ON trashed_items(trashed_at);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status              ON jobs(status, run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due        ON scheduled_jobs(enabled, next_run_at);
