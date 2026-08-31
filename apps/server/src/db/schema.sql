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
  theme                 TEXT NOT NULL DEFAULT 'minimalist',
  -- Interface language ('en', 'ru', …). Validated in code (like theme) so a new
  -- language doesn't need a schema change.
  language              TEXT NOT NULL DEFAULT 'en',
  protected_from_delete INTEGER NOT NULL DEFAULT 0 CHECK (protected_from_delete IN (0, 1)),
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  -- Delivery address for "Send to e-reader" (Kindle/Kobo).
  ereader_email         TEXT,
  -- Two-factor auth: enable flag, the chosen second factor, the encrypted TOTP
  -- secret (NULL when the method is 'email' — those codes live on the challenge
  -- row), and hashed single-use backup codes (JSON array). See core/mfa.ts.
  mfa_enabled           INTEGER NOT NULL DEFAULT 0,
  mfa_method            TEXT NOT NULL DEFAULT 'totp' CHECK (mfa_method IN ('totp', 'email')),
  mfa_secret            TEXT,
  mfa_backup_codes      TEXT,
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
  -- 'device' marks a session minted by the link-a-device flow (see
  -- core/device-link.ts) rather than by someone typing a password here. It lives
  -- much longer than a browser session and is refused on admin routes, because
  -- the thing holding it is a TV in a room, not a person at a keyboard.
  kind          TEXT NOT NULL DEFAULT 'browser' CHECK (kind IN ('browser', 'device')),
  -- What the owner calls this device ("Living Room TV"). device_name above is the
  -- raw user agent and is never editable; this is, and takes precedence in the UI.
  label         TEXT,
  revoked_at    TEXT
);

-- Short-lived second-factor step between password success and a full session.
-- One row per in-progress MFA sign-in; cleared on success, expiry, or attempt cap.
-- Also carries the emailed one-time code for the 'email' method: code_hash is the
-- sha256 of the digits last sent, and sends/last_sent_at bound resending. TOTP
-- challenges leave those NULL — the factor is the user's own secret.
-- `purpose` reuses the same mechanics (expiry, attempt cap, resend budget) for the
-- code that confirms an email enrollment; one row per user per purpose.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose       TEXT NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'enroll')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  code_hash     TEXT,
  sends         INTEGER NOT NULL DEFAULT 0,
  last_sent_at  TEXT
);

-- Passkeys (WebAuthn). A registered credential is a public key the browser signs
-- challenges with; the private half never leaves the user's device or keychain, so
-- unlike a password or a TOTP secret there is nothing here worth stealing.
-- `credential_id` and `public_key` are base64url, the encoding simplewebauthn hands
-- back. `counter` is the authenticator's use count for clone detection — synced
-- iCloud/Google passkeys always report 0, so only a DECREASE from a non-zero stored
-- value means anything (see core/webauthn.ts).
-- `backed_up` records whether the credential syncs: a device-bound key is lost with
-- the device, which is worth telling the user before it happens.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  TEXT NOT NULL UNIQUE,
  public_key     TEXT NOT NULL,
  counter        INTEGER NOT NULL DEFAULT 0,
  transports     TEXT,
  backed_up      INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
  label          TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at   TEXT,
  last_ip        TEXT
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials (user_id);

-- The random challenge a passkey ceremony signs, held server-side for the seconds
-- it takes the user to touch their sensor. Same short-lived shape as
-- mfa_challenges. `user_id` is NULL for a sign-in: passkeys here are discoverable,
-- so the browser names the account and the challenge is opened before we know who
-- is knocking.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'register')),
  challenge   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT NOT NULL
);

-- Link a device: one row per pending "sign this display in" request, between the
-- device putting a code on screen and someone approving it from their phone. The
-- OAuth 2.0 device-authorization shape, narrowed to one household (core/device-link.ts).
--
-- Two secrets, doing different jobs. `device_code` is the long one only the asking
-- device ever holds, and — like sessions, share links and API tokens — only its
-- sha256 is stored. `user_code` is the short one shown on the TV and typed or
-- scanned on the phone; it is not a credential (holding it approves nothing on its
-- own — approving needs a signed-in account and that account's password), so it is
-- stored as-is and bounded by its short expiry. Guessing user codes is answered
-- per-IP by the route's rate limit and the abuse counter, not per-row: a guess that
-- is wrong matches no row at all, so there is nothing here for it to count against.
--
-- `attempts` is therefore about the other end — wrong passwords typed on the
-- confirmation screen. Enough of them kill the request rather than the account,
-- which is what someone holding an unlocked phone would be up against.
--
-- There is deliberately no 'expired' status: expiry is `expires_at <= now`, asked
-- in every query. A stored state has to be swept to become true, and until the
-- sweep runs the screen would still say "waiting".
--
-- `session_id` links a redeemed request to the session it became, so revoking a
-- device from Profile → Devices can be traced back to how it got there.
CREATE TABLE IF NOT EXISTS device_link_requests (
  id                TEXT PRIMARY KEY,
  device_code_hash  TEXT NOT NULL UNIQUE,
  user_code         TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at        TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  user_agent        TEXT,
  ip_address        TEXT,
  approved_by       TEXT REFERENCES users(id) ON DELETE CASCADE,
  approved_at       TEXT,
  session_id        TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  -- Whether this request came from outside the house, decided when it was created
  -- and remembered because approval cannot re-derive it: by then the caller is the
  -- phone, and the phone's address says nothing about where the television is.
  -- A remote request may only be approved by someone holding a live registration
  -- window (see device_link_windows).
  remote            INTEGER NOT NULL DEFAULT 0 CHECK (remote IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_device_link_expires ON device_link_requests (expires_at);

-- An administrator's temporary permission for ONE person to link ONE device from
-- outside the home network. The rest of the time linking is refused out there and
-- the app does not offer it, which is the default this exists to make survivable:
-- the alternative was a global setting that opens the door for everyone, forever.
--
-- "Live" is derived, never stored: not used, not revoked, not past expires_at.
-- The first device linked against it fills used_at and session_id, and it is over
-- — so an admin may grant as often as they like and each grant is worth one device.
CREATE TABLE IF NOT EXISTS device_link_windows (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_link_windows_user ON device_link_windows (user_id, expires_at);

-- Brute-force defense & source-IP access control.
-- Every sign-in attempt, used to derive per-account lockout and per-IP auto-block.
-- Rows with a NULL email are anonymous abuse hits (scanner probe paths, unknown
-- share/API tokens): they count only toward the per-IP block, never a lockout.
-- `kind` says what the row actually was, so the auto-block can report what it
-- counted: 'signin' is a real sign-in attempt (password, code, or passkey),
-- 'probe' a scanner path sweep, 'token' a share/API token or device code that
-- matched nothing.
CREATE TABLE IF NOT EXISTS login_attempts (
  id          TEXT PRIMARY KEY,
  email       TEXT,
  ip_address  TEXT,
  successful  INTEGER NOT NULL DEFAULT 0 CHECK (successful IN (0, 1)),
  kind        TEXT NOT NULL DEFAULT 'signin' CHECK (kind IN ('signin', 'probe', 'token')),
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

-- Cached AbuseIPDB lookups for IPs local detection has already flagged. Written
-- only when an admin has configured an API key; refreshed after 24 hours.
CREATE TABLE IF NOT EXISTS ip_reputation (
  ip_address        TEXT PRIMARY KEY,
  score             INTEGER,        -- abuseConfidenceScore 0..100
  total_reports     INTEGER,
  last_reported_at  TEXT,
  country_code      TEXT,           -- ISO 3166-1 alpha-2, as AbuseIPDB reports it
  isp               TEXT,
  checked_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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

-- Networks an account has already signed in from, keyed on the coarse /24 (IPv4)
-- or /64 (IPv6) so a rotating home or mobile address doesn't look new every time.
-- Recorded on every sign-in regardless of policy; the optional "new network"
-- alert (security_policy.alertNewIpSignIn) reads it and is seeded from history
-- when an admin first turns it on.
CREATE TABLE IF NOT EXISTS known_login_networks (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network_key    TEXT NOT NULL,
  last_ip        TEXT,
  first_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, network_key)
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
  -- The custom scan rule that produced this item; NULL = the default scanner.
  -- Forward reference: library_scan_rules is created further down this file,
  -- which SQLite resolves lazily (the column is nullable and only set later).
  scan_rule_id  TEXT REFERENCES library_scan_rules(id) ON DELETE SET NULL,
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
  -- Alphabet index (see modules/library/shared/alphabet.ts): the letter this
  -- item files under, the script that letter belongs to, an administrator's
  -- override of the bucket, and the normalized form the browse lists sort by.
  -- Derived from sort_title on write — SQLite can't compute them (ASCII-only
  -- UPPER, no custom collations).
  alpha_key         TEXT,
  alpha_script      TEXT,
  alpha_override    TEXT,
  sort_key          TEXT,
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
  -- Photo only: 64-bit dHash perceptual fingerprint (16 hex chars) computed from the
  -- cached preview thumbnail; near-identical photos (bursts, re-takes) hash within a
  -- few bits of each other. NULL = video / not yet hashed (the scan backfills).
  -- Used by memory suggestions to pick visually distinct photos (similarity.ts).
  phash               TEXT,
  -- sha256 of the ORIGINAL file's bytes, written only by the duplicate scan
  -- (duplicates/items.ts) and only for assets whose `size` collides with another asset —
  -- byte-identical files must share a size, so most rows never need hashing and the
  -- catalog scan never has to read a whole file. `content_hash_at` records the file's
  -- own mtime at the moment it was hashed — read by stat during the duplicate scan, NOT
  -- copied from `modified_at`, so a file edited in place between catalog scans still
  -- rehashes. NULL = not a size-collision candidate / not hashed.
  content_hash        TEXT,
  content_hash_at     TEXT,
  -- Video only: a browser-playable H.264/AAC copy of a video the browser can't decode
  -- (playable = 0), produced by the weekly "convert unplayable videos" job and stored in
  -- the thumbnail bucket (see transcode.ts). NULL = native-playable / not converted /
  -- can't be converted. web_video_attempts guards against retrying a bad file forever.
  web_video_key       TEXT,
  web_video_attempts  INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_gallery_taken_at ON gallery_details(taken_at);
-- Drives the duplicate scan's size-collision candidate query.
CREATE INDEX IF NOT EXISTS idx_gallery_size ON gallery_details(size);
-- Finds the other copies of a digest during the duplicate scan's grouping pass.
-- Partial: most photos are never hashed, because only a size collision earns a read.
CREATE INDEX IF NOT EXISTS idx_gallery_content_hash ON gallery_details(content_hash) WHERE content_hash IS NOT NULL;

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
  -- An explicit "use this photo" pick, same shape as gallery_albums/gallery_slideshows
  -- .cover_item_id. Takes priority over cover_face_id and the most-recent-photo
  -- fallback when set; NULL leaves the cover fully automatic.
  cover_item_id    TEXT REFERENCES library_items(id) ON DELETE SET NULL,
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

-- Gallery slideshows: an ordered photo set PLUS presentation settings (see
-- docs/gallery-slideshows-proposal.md). Distinct from albums — an album ORGANIZES,
-- a slideshow PRESENTS (order + transition + timing). Same access model as albums:
-- viewable by every member (items access-filtered per viewer on read), editable by
-- creator + admins. Spans all gallery libraries.
--
-- `source_kind`/`source_ref` record where a slideshow came from so a customized
-- Memory remembers its origin (used from Phase 3). `music_track_id` (Phase 2) and
-- the render_* columns + `gallery_music_tracks` (Phase 4, MP4 export) are declared
-- now so later phases add no migration; Phase 1 leaves them at their defaults.
CREATE TABLE IF NOT EXISTS gallery_music_tracks (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  artist           TEXT,
  builtin          INTEGER NOT NULL DEFAULT 0,   -- 1 = shipped starter track (undeletable)
  storage_key      TEXT NOT NULL,
  duration_seconds REAL,
  uploaded_by      TEXT REFERENCES users(id) ON DELETE SET NULL,  -- NULL for builtin
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS gallery_slideshows (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  source_kind    TEXT NOT NULL DEFAULT 'manual' CHECK (source_kind IN ('manual', 'memory', 'album')),
  source_ref     TEXT,
  music_track_id TEXT REFERENCES gallery_music_tracks(id) ON DELETE SET NULL,
  transition     TEXT NOT NULL DEFAULT 'crossfade'
                   CHECK (transition IN ('none', 'crossfade', 'fade', 'slide', 'kenburns', 'dipblack', 'random')),
  slide_seconds  REAL NOT NULL DEFAULT 4,
  -- Cross-fade length in seconds (0.5–5, route-validated); drives both the live
  -- player's playback animations and the rendered movie's xfade duration.
  transition_seconds REAL NOT NULL DEFAULT 2,
  -- The opening title card of the rendered movie (slideshow-title-card.ts). Defaults
  -- reproduce the card every earlier render made: the slideshow's name over black for
  -- three seconds, with a photo-count subline.
  title_enabled  INTEGER NOT NULL DEFAULT 1,       -- 0 = open straight on the first photo
  title_text     TEXT,                             -- NULL = use the slideshow's name
  title_subtitle_mode TEXT NOT NULL DEFAULT 'count'
                   CHECK (title_subtitle_mode IN ('count', 'custom', 'none')),
  title_subtitle TEXT,                             -- the line shown when mode = 'custom'
  title_seconds  REAL NOT NULL DEFAULT 3,          -- how long the card holds the screen
  -- What the words sit on. 'photo'/'blur' use title_photo_item_id (or the first slide
  -- when it is NULL or no longer a member); 'collage' tiles a spread of the slideshow's
  -- own photos. Anything but 'black' is darkened behind the text so it stays readable.
  title_background TEXT NOT NULL DEFAULT 'black'
                   CHECK (title_background IN ('black', 'photo', 'blur', 'collage')),
  title_photo_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL,
  -- Lettering: which bundled face the card's text is set in, and how large
  -- (slideshow-title-card.ts CARD_FONTS/CARD_SIZES). The defaults reproduce the
  -- card every pre-3.26 movie rendered: DejaVu Sans at today's size.
  card_font      TEXT NOT NULL DEFAULT 'classic'
                   CHECK (card_font IN ('classic', 'serif', 'bold', 'script', 'typewriter')),
  card_size      TEXT NOT NULL DEFAULT 'medium'
                   CHECK (card_size IN ('small', 'medium', 'large')),
  -- The closing card: an end title over black or the slideshow's own photos, with
  -- up to six lines of credits (closing_lines, newline-separated) and the music
  -- fading out underneath it. OFF by default — a movie ends as it always did
  -- until someone turns it on. closing_text NULL = "The End".
  closing_enabled INTEGER NOT NULL DEFAULT 0,
  closing_text   TEXT,
  closing_lines  TEXT,
  closing_seconds REAL NOT NULL DEFAULT 5,
  closing_background TEXT NOT NULL DEFAULT 'black'
                   CHECK (closing_background IN ('black', 'photo', 'blur', 'collage')),
  closing_photo_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL,
  -- The post-credit clip: a gallery VIDEO (any the picker can access, not just a
  -- member) that plays LAST, after the closing card — the stinger after a film's
  -- credits. Same 20s cap as member videos; the render skips a clip it can't reach
  -- rather than failing. (A clip before the title card was offered until 3.42.0
  -- and dropped: nobody wanted a movie that opens on one.)
  outro_item_id  TEXT REFERENCES library_items(id) ON DELETE SET NULL,
  -- The clip's own sound (on by default): the clip's audio plays and the music
  -- pauses underneath it, resuming where it left off. A clip whose file has no
  -- audio stream simply keeps the music running.
  outro_sound    INTEGER NOT NULL DEFAULT 1,
  -- The list-card / detail-header cover. NULL falls back to the first slide in
  -- presentation order that has one — same "explicit pick, else first" shape as
  -- gallery_albums.cover_item_id.
  cover_item_id  TEXT REFERENCES library_items(id) ON DELETE SET NULL,
  -- Render state of the LATEST MP4 export (Phase 4). 'draft' = never rendered.
  render_status  TEXT NOT NULL DEFAULT 'draft'
                   CHECK (render_status IN ('draft', 'queued', 'rendering', 'ready', 'failed')),
  -- 1 = a 'ready' movie predates the slideshow's current settings/content (an edit
  -- since the last render), so it stays visible + playable but is flagged out of date.
  render_stale   INTEGER NOT NULL DEFAULT 0,
  render_job_id  TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  output_storage_key TEXT,
  output_bytes   INTEGER,
  rendered_at    TEXT,
  render_error   TEXT,
  -- Saving the movie into a gallery library, chosen PER SLIDESHOW (3.43.0; before that
  -- one server-wide default library took every render, which nobody opted into).
  --
  -- movie_target_library_id NULL = don't save, which is the default for a new slideshow.
  -- movie_on_conflict is the answer given when the target name was already taken, kept so
  -- a re-render never has to ask again — and a background render could not ask anyway.
  -- movie_file_stem is set only by Rename (NULL = follow the slideshow's own name).
  -- movie_save_error carries why the last save failed (a read-only mount, a name taken by
  -- someone else's video) so the editor can say so; NULL when the last save was fine.
  movie_target_library_id TEXT REFERENCES libraries(id) ON DELETE SET NULL,
  movie_on_conflict   TEXT NOT NULL DEFAULT 'keep_both'
                        CHECK (movie_on_conflict IN ('overwrite', 'keep_both')),
  movie_file_stem     TEXT,
  movie_save_error    TEXT,
  -- Where the LATEST successful render actually landed as a gallery video item. The path
  -- follows the slideshow's CURRENT name unless movie_file_stem overrides it: the same
  -- name overwrites the same file/item on re-render (no duplicates); after a rename the
  -- movie saves under the new name and the old file/item are retired (see
  -- saveMovieToLibrary). All NULL until a render is saved to a library. movie_item_id is
  -- SET NULL if that item is later removed.
  movie_library_id    TEXT REFERENCES libraries(id) ON DELETE SET NULL,
  movie_relative_path TEXT,
  movie_item_id       TEXT REFERENCES library_items(id) ON DELETE SET NULL,
  created_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Ordered membership. Mirrors gallery_album_items (position REAL lets a drag-reorder
-- insert between neighbors); `dwell_seconds` overrides the slideshow default for one
-- slide (NULL = use gallery_slideshows.slide_seconds).
CREATE TABLE IF NOT EXISTS gallery_slideshow_items (
  slideshow_id  TEXT NOT NULL REFERENCES gallery_slideshows(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  position      REAL NOT NULL,
  dwell_seconds REAL,
  added_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (slideshow_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_gallery_slideshow_items_item ON gallery_slideshow_items (item_id);

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

-- ── Dismissals: "not the same, stop showing me this" ──────────────────────────
--
-- The four tables below outlived the caches they were built beside. Those held one
-- install-wide scan and were rebuilt whole every time; a duplicate cleanup keeps its
-- own snapshot instead (duplicate_job_*), and the caches are gone. Dismissals could
-- not go with them: a decision that two things are NOT duplicates has to outlive the
-- scan that proposed them, or every re-scan asks again. So a cleanup writes these,
-- and every scan consults them before it groups anything.

-- "Leave this one alone." Ordered, unlike the equal-contents dismissals: dismissing
-- "A is already inside B" says nothing about whether B is inside A.
CREATE TABLE IF NOT EXISTS gallery_duplicate_contained_ignores (
  library_id         TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  folder_path        TEXT NOT NULL,
  target_library_id  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  target_folder_path TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (library_id, folder_path, target_library_id, target_folder_path)
);

-- "These two just share some photos — stop pairing them." A pair, like the
-- equal-contents dismissals: the overlap is symmetric and the decision has to
-- survive a rebuild. Side A is the lexically smaller (library, path).
CREATE TABLE IF NOT EXISTS gallery_duplicate_folder_overlap_ignores (
  library_a  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path_a     TEXT NOT NULL,
  library_b  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path_b     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (library_a, path_a, library_b, path_b)
);

-- "These two folders are not duplicates", as a pair, for the same reason the
-- item-level dismissals are pairs: the decision has to survive a rebuild that
-- regroups the set. The lexically smaller (library, path) is always side A.
CREATE TABLE IF NOT EXISTS gallery_duplicate_folder_ignores (
  library_a  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path_a     TEXT NOT NULL,
  library_b  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path_b     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (library_a, path_a, library_b, path_b)
);

-- "These two are not duplicates." Stored as an EDGE rather than against a group id
-- so the decision survives a rebuild: when a third copy appears and regrouping
-- changes the member set, the dismissed pair still refuses to link. `item_a` is
-- always the lexically smaller id, so a pair has exactly one row.
CREATE TABLE IF NOT EXISTS gallery_duplicate_ignores (
  item_a     TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  item_b     TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (item_a, item_b)
);

-- ── Duplicate cleanup JOBS (duplicates/jobs.ts) ─────────────────────────────
--
-- Everything above this line is a CACHE over the last scan: rebuilt from scratch by
-- every rebuild, pruned by every deletion, and identified by ids that do not survive
-- either. That is fine for a page you open, act on, and leave.
--
-- A cleanup job is the opposite: a piece of work someone owns, puts down, and comes
-- back to days later. So a job takes its own SNAPSHOT of what a scan found and never
-- references the cache's ids — a job pointing at them would be emptied by the next
-- rebuild, including one pressed on the older duplicate pages, which stay available.
-- See docs/duplicate-detection.md.

CREATE TABLE IF NOT EXISTS duplicate_jobs (
  id                 TEXT PRIMARY KEY,
  -- Whose job it is. Only the owner may change or act on it; an admin may cancel,
  -- delete or hand it over. Deliberately not ON DELETE CASCADE: a deleted user's
  -- cleanup history is still an audit record of files that left the library.
  owner_user_id      TEXT NOT NULL REFERENCES users(id),
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'scanning', 'review', 'processing',
                                       'paused', 'completed', 'failed', 'cancelled')),
  -- What the wizard asked for. Locked once scanning starts; changing either means a
  -- new scan, because the snapshot below was taken under them.
  -- Folders OR files, never both. They are different jobs of work: clearing whole
  -- folders is a few decisions about a lot of photos, and going through single
  -- copies is a lot of decisions about a few. Mixing them produced one list nobody
  -- could work through in a sitting, and every folder cleared re-ordered the file
  -- half underneath it.
  duplicate_type     TEXT NOT NULL DEFAULT 'folders' CHECK (duplicate_type IN ('folders', 'files')),
  media_type         TEXT NOT NULL DEFAULT 'both' CHECK (media_type IN ('photo', 'video', 'both')),
  -- Which wizard step to reopen on, for a draft put down mid-way.
  current_step       INTEGER NOT NULL DEFAULT 1,
  scan_progress      INTEGER NOT NULL DEFAULT 0,
  -- Why a scan failed, or why the job was cancelled — shown on the job card.
  status_detail      TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_activity_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  scan_started_at    TEXT,
  scan_completed_at  TEXT,
  completed_at       TEXT
);

-- One active job at a time, enforced by the database rather than by a check that
-- races two browser tabs. Completed, failed, cancelled and deleted jobs are not
-- active, so they fall out of the index and never block a new one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_duplicate_jobs_active
  ON duplicate_jobs((1)) WHERE status IN ('draft', 'scanning', 'review', 'processing', 'paused');

CREATE INDEX IF NOT EXISTS idx_duplicate_jobs_owner ON duplicate_jobs(owner_user_id);

-- The libraries the job compares, with what they WERE when it was created. The
-- snapshots matter: a library turned external mid-job must not silently start
-- offering its files for deletion, and one turned internal must not start offering
-- them either — the job was reviewed under the old answer. Section 8 revalidation
-- compares these against the library as it stands and refuses on a change.
CREATE TABLE IF NOT EXISTS duplicate_job_libraries (
  job_id                TEXT NOT NULL REFERENCES duplicate_jobs(id) ON DELETE CASCADE,
  library_id            TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  included              INTEGER NOT NULL DEFAULT 1 CHECK (included IN (0, 1)),
  library_type_snapshot TEXT NOT NULL,   -- 'managed' | 'external', from policy_json
  protected_snapshot    INTEGER NOT NULL CHECK (protected_snapshot IN (0, 1)),
  PRIMARY KEY (job_id, library_id)
);

-- One duplicate group or folder answer, as the job saw it. No foreign key into the
-- cache tables: their ids are regenerated by every rebuild.
CREATE TABLE IF NOT EXISTS duplicate_job_results (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES duplicate_jobs(id) ON DELETE CASCADE,
  result_type       TEXT NOT NULL CHECK (result_type IN ('photo_set', 'folder_set', 'contained', 'overlap')),
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'resolved', 'protected', 'error')),
  review_status     TEXT NOT NULL DEFAULT 'unreviewed'
                    CHECK (review_status IN ('unreviewed', 'reviewed', 'skipped')),
  reclaimable_bytes INTEGER NOT NULL DEFAULT 0,
  -- Why the keeper won, pre-rendered when the snapshot was taken.
  keeper_reason     TEXT,
  -- HOW SURE the result is, on two separate axes. Folding them into one label would
  -- lose the case that matters: a byte-identical set is certain about the match and
  -- can still be a coin toss about which copy to keep.
  --
  -- match_confidence — is this the same picture? 'certain' means identical bytes, which
  -- every folder answer also rests on. 'likely' and 'unsure' only ever appear on a
  -- near-identical set, graded when the snapshot is taken from how far apart the
  -- fingerprints are and whether the other evidence agrees.
  match_confidence  TEXT NOT NULL DEFAULT 'certain'
                    CHECK (match_confidence IN ('certain', 'likely', 'unsure')),
  -- keeper_rank — WHICH criterion settled which copy survives, as its index in
  -- KEEPER_CRITERIA: 0 is the first and strongest, -1 means nothing separated them and
  -- the stable tiebreak decided. The ladder is ordered rather than weighted, so the
  -- rank is the confidence; storing it saves the page re-deriving it from prose.
  keeper_rank       INTEGER NOT NULL DEFAULT -1,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_duplicate_job_results_job ON duplicate_job_results(job_id, result_type, status);

-- The FOLDERS a folder-shaped result is about. A folder has no row of its own
-- anywhere in the app — it exists only as a prefix of library_items.folder_path — so
-- a result that is about folders has to name them somewhere, and a file's directory
-- is not enough: the folder "Trip" holds "Trip/a/one.jpg", whose directory is
-- "Trip/a".
--
-- This is also where the recurring "copies sit in '.'" defect is fixed. The old
-- contained-folder cache had ONE target column, so a folder whose copies are
-- scattered over four other folders had no truthful single value and fell back to
-- the library root, which the card could only render as "everything in this library".
-- Here the covering side is a SET: one 'delete' row for the folder being cleared out
-- and one 'keep' row per folder that actually holds copies. The sentence the card
-- says is a list because the data is a list.
--
-- Empty for a photo set, whose subject is files rather than folders.
CREATE TABLE IF NOT EXISTS duplicate_job_result_folders (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES duplicate_jobs(id) ON DELETE CASCADE,
  result_id   TEXT NOT NULL REFERENCES duplicate_job_results(id) ON DELETE CASCADE,
  library_id  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  folder_path TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('keep', 'delete', 'protected')),
  -- What the folder held when the snapshot was taken, for the card's counts.
  item_count  INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (result_id, library_id, folder_path)
);

CREATE INDEX IF NOT EXISTS idx_duplicate_job_result_folders_result
  ON duplicate_job_result_folders(result_id, role);

-- The snapshot's file-level rows: what revalidation checks against, and where each
-- copy's fate is recorded.
--
-- `keeper_member_id` is the point of the table. Every doomed file names the copy that
-- survives it, so "where do the copies live?" is answered by the union of the keepers'
-- folders. The older contained-folder cache stored ONE target folder per row, which
-- cannot express copies scattered across several folders — the honest single answer
-- was then the library root, and the card said "everything in this library" and
-- "copies sit in '.'". That was re-worded four times and fixed none of them; the shape
-- was what was wrong.
CREATE TABLE IF NOT EXISTS duplicate_job_result_members (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES duplicate_jobs(id) ON DELETE CASCADE,
  result_id        TEXT NOT NULL REFERENCES duplicate_job_results(id) ON DELETE CASCADE,
  -- Which folder of the result this file belongs to, when the result is about
  -- folders. NULL on a photo set, whose members are loose files.
  folder_id        TEXT REFERENCES duplicate_job_result_folders(id) ON DELETE CASCADE,
  -- The item as it was at scan time. Nullable and ON DELETE SET NULL: the photo may
  -- be gone by the time anyone comes back, and the snapshot still has to describe
  -- what it was in order to say so.
  item_id          TEXT REFERENCES library_items(id) ON DELETE SET NULL,
  library_id       TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path             TEXT NOT NULL,
  size_snapshot    INTEGER,
  mtime_snapshot   TEXT,
  content_hash     TEXT,
  -- Perceptual distance from the keeper, in bits of 64. Always 0 for a byte-identical
  -- set — the copies ARE the same file — and 1..NEAR_IDENTICAL_DISTANCE for a
  -- near-identical one. This is what separates the two tiers in the snapshot: a
  -- result whose members are all at 0 is certain, and anything above it is a
  -- judgement call the page has to present as one.
  distance         INTEGER NOT NULL DEFAULT 0,
  role             TEXT NOT NULL CHECK (role IN ('keep', 'delete', 'protected')),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'deleted', 'skipped', 'missing', 'modified', 'error')),
  -- On a 'delete' row: the member whose copy survives it. NULL on keep/protected rows.
  keeper_member_id TEXT REFERENCES duplicate_job_result_members(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_duplicate_job_members_result ON duplicate_job_result_members(result_id, role);
CREATE INDEX IF NOT EXISTS idx_duplicate_job_members_job ON duplicate_job_result_members(job_id, status);

-- The job's own keep/clear instructions, seeded by copying the global ones at
-- creation. From then on they are the job's: editing them never writes back to the
-- set the older pages use, so the two can't disagree about what "keep here" means.
--
-- No inherited_from or locked columns. Inheritance is the most-specific covering
-- folder winning, and locking is the library's protection flag — both derived at read
-- time, so neither can drift from the data it describes.
CREATE TABLE IF NOT EXISTS duplicate_job_folder_preferences (
  job_id      TEXT NOT NULL REFERENCES duplicate_jobs(id) ON DELETE CASCADE,
  library_id  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  folder_path TEXT NOT NULL,
  preference  TEXT NOT NULL CHECK (preference IN ('keep', 'clear')),
  updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (job_id, library_id, folder_path)
);

-- What was done, in order. logActivity() records the install-wide audit trail; this is
-- the job's own history, so "what happened in this cleanup" survives without reading
-- the whole activity log.
CREATE TABLE IF NOT EXISTS duplicate_job_actions (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES duplicate_jobs(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  status      TEXT NOT NULL DEFAULT 'ok',
  details     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_duplicate_job_actions_job ON duplicate_job_actions(job_id, created_at);

CREATE TABLE IF NOT EXISTS duplicate_job_errors (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES duplicate_jobs(id) ON DELETE CASCADE,
  target_type TEXT,
  target_id   TEXT,
  error_code  TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_duplicate_job_errors_job ON duplicate_job_errors(job_id, resolved_at);

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

-- Folder locks: an admin's "nothing under here may be deleted from the app".
-- A folder has no row of its own — it exists only as a prefix of
-- library_items.folder_path — so a lock names (library, path) the way scan-rule
-- paths and job folder preferences do. A lock covers its whole subtree. Locking
-- "" (the whole library) is the library policy's job (allowDelete/external), not
-- a row here. Deletion only: uploads, scans and metadata edits inside a locked
-- folder are unaffected. Enforced inside trashBook(), beside libraryAllowsDelete.
CREATE TABLE IF NOT EXISTS library_folder_locks (
  library_id  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  folder_path TEXT NOT NULL,
  locked_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  locked_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (library_id, folder_path)
);

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
  website           TEXT,
  location          TEXT,
  -- Life facts: the short line that sits above the biography. Dates follow the
  -- same partial-date convention as family_tree_persons ('YYYY' | 'YYYY-MM' |
  -- 'YYYY-MM-DD') — a contributor's dates are as often a bare year as a full
  -- date, and lexicographic order stays chronological either way.
  birth_date        TEXT,
  death_date        TEXT,
  -- Country of origin, and the one-line "English writer and humorist". Both are
  -- free text rather than codes: country of origin for a 19th-century author is
  -- a genuinely contested answer (Russian Empire, Austria-Hungary) and a picker
  -- would force a wrong one.
  country           TEXT,
  occupation        TEXT,
  image_storage_key TEXT,
  openlibrary_id    TEXT,
  -- The page the facts above were read from, for the source link beside them.
  wikipedia_url     TEXT,
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

-- One run of the bulk quote import — the file, when it was fed in, and how many
-- rows it brought. Kept so an import can be undone as the event it was ("delete
-- everything quotes-ru.json added") rather than one quote at a time.
--
-- Rows point at it with ON DELETE SET NULL: losing the record leaves its quotes
-- in place as ordinary imported ones, the same degrade-don't-cascade rule the
-- rest of this table follows. Deleting the QUOTES is a deliberate act, never a
-- side effect of tidying the record away.
CREATE TABLE IF NOT EXISTS quote_imports (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What the admin picked, for recognising it later. Absent on an import made
  -- straight against the API.
  file_name   TEXT,
  quote_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_quote_imports_user ON quote_imports(user_id, datetime(created_at) DESC);

-- Quotes / highlights. A first-class entity, not just an in-book highlight: a
-- quote may be captured in the reader (item_id + document_id + cfi all set, with
-- an on-page highlight anchored by the cfi) OR brought in from outside the library
-- (all three NULL — just `text` plus a free-text source). FKs are ON DELETE SET
-- NULL (not CASCADE) so removing a book degrades its quotes to external ones rather
-- than deleting them; source_title/source_author are snapshotted at save time so
-- attribution survives that. Display prefers the live item when item_id is still set.
--
-- Famous quotes, family sayings, and reader highlights are all rows here: the
-- surfaces that show them (the Quotes page, the Quote of the day card, a family
-- tree profile) are filters over this one table, never separate stores.
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
  -- How the row got here, derived by the server rather than sent by the client.
  -- It is also what makes a bulk import reviewable afterwards: the Quotes page
  -- can list exactly what a JSON pack brought in.
  origin           TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'reader', 'import')),
  -- A quote is its owner's alone until raised to 'family'. Every shared surface
  -- (Quote of the day, a person's profile) shows 'family' rows plus the viewer's
  -- own, so reading highlights never leak by simply existing.
  visibility       TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'family')),
  -- Member of the Quote-of-the-day pool. Imported packs opt in; highlights and
  -- hand-typed quotes stay out unless chosen, so the daily card is curated.
  in_rotation      INTEGER NOT NULL DEFAULT 0,
  -- BCP-47-ish short code ('en', 'ru'), NULL when unknown. The daily card prefers
  -- the reader's own UI language and falls back to the whole pool.
  language         TEXT,
  -- WHEN IT WAS SAID (not when it was saved) — partial ISO dates on the same
  -- convention as family_tree_persons.birth_date: 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD'.
  quote_date       TEXT,
  -- Free text: the circumstances it was said in.
  context          TEXT,
  -- WHO SAID IT, deliberately distinct from source_author (who wrote the source
  -- work). SET NULL plus the person_name snapshot, so deleting a family member
  -- leaves their quotes attributed rather than anonymous.
  family_tree_person_id TEXT REFERENCES family_tree_persons(id) ON DELETE SET NULL,
  person_name      TEXT,
  -- Which run of the bulk import brought this row in, so one pack can be undone
  -- without touching another. NULL for everything typed or highlighted by hand.
  import_id        TEXT REFERENCES quote_imports(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Likes — per-user liked items, one row per (user, item). The table name is
-- historical: this shipped as "My List", was renamed to Favorites, and is now
-- Likes. Renaming the table would need a migration; the product word is Likes.
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
--  Family sharing — "Send to"
-- ════════════════════════════════════════════════════════════════════════════

-- One family member pointing another at something: a pointer plus a line of
-- text, never a copy of the file. The subject is polymorphic over the resolver
-- in modules/social/subjects.ts (audiobook | ebook | gallery | family_tree_person).
--
-- Sender is SET NULL with a `from_name` snapshot rather than CASCADE: a removed
-- account should not silently erase what it sent, the same bargain `quotes`
-- makes with source_title/source_author. Recipient IS cascade — a recommendation
-- addressed to nobody has no meaning.
--
-- UNIQUE(from, to, entity) makes re-sending idempotent: sending the same book to
-- the same person twice updates the message and lifts it back to 'new' rather
-- than stacking duplicate cards in their inbox.
CREATE TABLE IF NOT EXISTS recommendations (
  id            TEXT PRIMARY KEY,
  from_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  to_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  message       TEXT,
  -- 'new' until the recipient acts. 'saved' means they liked it;
  -- 'dismissed' is "not now". Neither deletes the row — the Sent list stays
  -- honest about what was sent, and the feed can still cite it.
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'saved', 'dismissed')),
  -- Snapshots so the card still reads after the subject or the sender is gone.
  subject_title TEXT,
  from_name     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- When the recipient last opened their inbox with this card in it. Drives the
  -- bell dot, NOT a badge count — see docs/family-sharing-proposal.md.
  seen_at       TEXT,
  UNIQUE (from_user_id, to_user_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_recommendations_inbox ON recommendations (to_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_recommendations_sent ON recommendations (from_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_recommendations_subject ON recommendations (entity_type, entity_id);

-- What the household says about a thing, kept under the thing itself. Polymorphic
-- over the same resolver as recommendations, so a note works on a book, a photo or
-- a person in the family tree without any of them knowing about notes.
--
-- Deliberately flat: no parent_id, no replies. Nesting is what turns a note box
-- into a comment section, and this is meant to be the former.
--
-- `body` is PLAIN TEXT and is rendered as plain text. No markdown, no HTML, ever.
-- That is the whole XSS story for user-authored content in this app and it stays
-- that way; anything that would render it richly has to change this comment first.
--
-- Author is SET NULL with an `author_name` snapshot, the bargain `quotes` and
-- `recommendations` already make: a removed account should not silently erase what
-- it said about the family's photographs.
--
-- deleted_at is a soft delete. With no replies there is no thread shape to keep, so
-- a deleted note simply stops being listed — the row survives so a mistake can be
-- undone by hand, and so an admin can see what was removed.
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_subject ON notes (entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notes_author ON notes (user_id, created_at);

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
  -- The item's cover/preview thumbnail, kept alive while it sits in the bin so the
  -- Recycle Bin can show what a row actually is. Deleted with the item's files on
  -- purge, and on restore (the re-catalogued item generates its own).
  cover_key    TEXT,
  -- WHY this item is here, which decides how long it stays. A byte-identical duplicate
  -- whose surviving copy was verified present at the moment it went is about the safest
  -- deletion there is; a hand-deleted audiobook is a decision someone may want a long
  -- time to reconsider. Also worth having on its own: without it a cleanup's thousands
  -- of rows are indistinguishable from a hand delete in the bin.
  source       TEXT NOT NULL DEFAULT 'manual',
  -- WHEN it will be permanently removed. NULL = kept until the bin is emptied by hand.
  --
  -- Written when the item is trashed, NOT computed at purge from whatever the global
  -- setting happens to say then. Retention used to be evaluated only at sweep time, so
  -- lowering it from 30 days to 7 retroactively condemned everything already in the bin
  -- older than 7 days — including items deleted under a promise of 30. Each item's fate
  -- is now fixed at the moment the promise was made.
  expires_at   TEXT,
  -- WHERE this row's files are, when that is not the library's own folder. trash_path is
  -- relative, so it needs a base: NULL means source_path (a .trash inside the library,
  -- the default), and a value means the install-wide bin folder chosen on the Storage
  -- page. Per row rather than read from the setting, so a row can always be found again
  -- by the app that wrote it, whatever the setting later says.
  trash_root   TEXT,
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
-- "everything below this folder" — the shape of the gallery's Folders view, the
-- duplicate-folder fingerprints, and every folder card. Without the folder_path
-- column here each of those scans a whole library to answer a question about one
-- folder, which on a big library is the server stopping for the duration.
CREATE INDEX IF NOT EXISTS idx_items_library_folder     ON library_items(library_id, folder_path);

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
CREATE INDEX IF NOT EXISTS idx_activity_logs_dedup       ON activity_logs(event, actor_user_id, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status              ON jobs(status, run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due        ON scheduled_jobs(enabled, next_run_at);

-- ════════════════════════════════════════════════════════════════════════════
--  Family tree (modules/familytree)
-- ════════════════════════════════════════════════════════════════════════════
-- A third, independent "person" concept: `people` are book contributors and
-- `gallery_people` are face clusters; family_tree_persons are family members.
-- gallery_person_id bridges a family member to their face cluster so tagged
-- photos surface on the profile. Any signed-in user can view; only admins edit.

CREATE TABLE IF NOT EXISTS family_tree_persons (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  maiden_name       TEXT,
  gender            TEXT NOT NULL DEFAULT 'unknown' CHECK (gender IN ('male', 'female', 'other', 'unknown')),
  -- Partial ISO dates: 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD' (validated in app code;
  -- lexicographic order == chronological, and GEDCOM partial dates map 1:1 later).
  birth_date        TEXT,
  death_date        TEXT,
  birthplace        TEXT,
  death_place       TEXT,
  bio               TEXT,
  -- Portrait is EITHER an uploaded image in the thumbnail store (bucket
  -- 'familytree') OR a chosen gallery item whose cover is used; app code clears
  -- one when setting the other.
  portrait_storage_key TEXT,
  portrait_item_id  TEXT REFERENCES library_items(id) ON DELETE SET NULL,
  gallery_person_id TEXT REFERENCES gallery_people(id) ON DELETE SET NULL,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A spouse/partner union (GEDCOM FAM). person2 NULL = single-parent family, so
-- child edges always hang off a union and never need a separate parent table.
-- Deleting a person keeps the union when the other partner survives (app code
-- promotes the survivor into person1); person2's SET NULL is the DB backstop.
CREATE TABLE IF NOT EXISTS family_tree_unions (
  id            TEXT PRIMARY KEY,
  person1_id    TEXT NOT NULL REFERENCES family_tree_persons(id) ON DELETE CASCADE,
  person2_id    TEXT REFERENCES family_tree_persons(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('married', 'partners', 'divorced', 'widowed', 'unknown')),
  married_date  TEXT,
  married_place TEXT,
  divorced_date TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The PK deliberately allows a child in several unions (adoptive + biological,
-- GEDCOM import); v1 routes enforce at most one parent-union per child.
CREATE TABLE IF NOT EXISTS family_tree_children (
  union_id  TEXT NOT NULL REFERENCES family_tree_unions(id) ON DELETE CASCADE,
  child_id  TEXT NOT NULL REFERENCES family_tree_persons(id) ON DELETE CASCADE,
  relation  TEXT NOT NULL DEFAULT 'biological' CHECK (relation IN ('biological', 'adopted', 'step', 'foster', 'unknown')),
  added_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (union_id, child_id)
);

-- Life events beyond the birth/death/marriage columns: a person's timeline
-- (school, work, moves, service…). GEDCOM-shaped — each row maps to an INDI
-- event tag (RESI/EDUC/OCCU/…) or a custom EVEN. `label` is the short "what"
-- for every type (occupation title, school name); required in app code for
-- `custom`. Dates are partial ISO like everywhere else; `end_date` covers
-- ranges ("residence 2001–2007").
CREATE TABLE IF NOT EXISTS family_tree_events (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES family_tree_persons(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('residence', 'education', 'graduation', 'occupation', 'retirement', 'military', 'immigration', 'emigration', 'naturalization', 'travel', 'award', 'baptism', 'burial', 'custom')),
  label      TEXT,
  date       TEXT,
  end_date   TEXT,
  place      TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Gallery photos/videos attached to a life event (the trip, the ceremony…),
-- separate from the person-level wall. CASCADE like family_tree_photos.
CREATE TABLE IF NOT EXISTS family_tree_event_photos (
  event_id TEXT NOT NULL REFERENCES family_tree_events(id) ON DELETE CASCADE,
  item_id  TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (event_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_ft_event_photos_item ON family_tree_event_photos(item_id);

-- Where a fact came from: books, record indexes, websites (GEDCOM SOUR
-- records). Shared — one source can back many citations.
CREATE TABLE IF NOT EXISTS family_tree_sources (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  author     TEXT,
  publisher  TEXT,
  url        TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A citation ties a source to exactly one target: a person (optionally a
-- specific fact — name/birth/death), a life event, or a union (optionally
-- marriage/divorce). `detail` is GEDCOM PAGE ("where in the source"); `url`
-- is a citation-specific link (e.g. a Geneanet record page) as opposed to the
-- source's general URL.
CREATE TABLE IF NOT EXISTS family_tree_citations (
  id         TEXT PRIMARY KEY,
  source_id  TEXT NOT NULL REFERENCES family_tree_sources(id) ON DELETE CASCADE,
  person_id  TEXT REFERENCES family_tree_persons(id) ON DELETE CASCADE,
  event_id   TEXT REFERENCES family_tree_events(id) ON DELETE CASCADE,
  union_id   TEXT REFERENCES family_tree_unions(id) ON DELETE CASCADE,
  fact       TEXT CHECK (fact IN ('name', 'birth', 'death', 'marriage', 'divorce')),
  detail     TEXT,
  url        TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((person_id IS NOT NULL) + (event_id IS NOT NULL) + (union_id IS NOT NULL) = 1)
);

CREATE INDEX IF NOT EXISTS idx_ft_citations_source ON family_tree_citations(source_id);
CREATE INDEX IF NOT EXISTS idx_ft_citations_person ON family_tree_citations(person_id);
CREATE INDEX IF NOT EXISTS idx_ft_citations_event  ON family_tree_citations(event_id);
CREATE INDEX IF NOT EXISTS idx_ft_citations_union  ON family_tree_citations(union_id);

-- Gallery photos/videos attached to a family member. CASCADE like
-- gallery_album_items — an attachment is meaningless without its item.
CREATE TABLE IF NOT EXISTS family_tree_photos (
  person_id TEXT NOT NULL REFERENCES family_tree_persons(id) ON DELETE CASCADE,
  item_id   TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  position  REAL NOT NULL,
  added_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (person_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_ft_unions_p1             ON family_tree_unions(person1_id);
CREATE INDEX IF NOT EXISTS idx_ft_unions_p2             ON family_tree_unions(person2_id);
CREATE INDEX IF NOT EXISTS idx_ft_children_child        ON family_tree_children(child_id);
CREATE INDEX IF NOT EXISTS idx_ft_events_person         ON family_tree_events(person_id);
CREATE INDEX IF NOT EXISTS idx_ft_photos_item           ON family_tree_photos(item_id);
CREATE INDEX IF NOT EXISTS idx_ft_persons_gallery_person ON family_tree_persons(gallery_person_id);

-- ════════════════════════════════════════════════════════════════════════════
--  Stories (modules/stories)
-- ════════════════════════════════════════════════════════════════════════════
-- An authored narrative page built from content the library already holds:
-- prose, photos/videos, albums, slideshows and maps, organised into dated
-- chapters. Everything is REFERENCED, never copied — a story is a presentation
-- layer (see docs/stories-proposal.md).
--
-- Access mirrors gallery albums: every member may read a published story,
-- edit is creator + admins. Referenced content is filtered per viewer at read
-- time, so a story never widens access to anything.
CREATE TABLE IF NOT EXISTS stories (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  subtitle      TEXT,
  cover_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'draft',   -- 'draft' | 'published'
  created_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The narrative spine. Every story has at least one chapter (a new story gets
-- an untitled one), so the reader and editor only ever handle one shape — a
-- single untitled, undated chapter simply renders without chapter chrome.
-- Dates are partial ISO like the family tree ('YYYY' | 'YYYY-MM' |
-- 'YYYY-MM-DD', lexicographic = chronological); end_date makes a range, both
-- NULL means undated, and date_approx renders "around ...".
CREATE TABLE IF NOT EXISTS story_chapters (
  id          TEXT PRIMARY KEY,
  story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  position    REAL NOT NULL,
  title       TEXT,
  date        TEXT,
  end_date    TEXT,
  date_approx INTEGER NOT NULL DEFAULT 0,
  place       TEXT,
  place_lat   REAL,
  place_lng   REAL,
  description TEXT
);

-- One unit of narrative. Reference kinds (media/album/slideshow) carry the
-- polymorphic (entity_type, entity_id) pair used by collection_items and
-- taggables — deliberately without an FK, so a deleted album degrades to an
-- "unavailable" placeholder through the subjects hydrator rather than taking
-- the story's rows with it. idx_story_blocks_entity lets the delete paths
-- sweep dead references.
CREATE TABLE IF NOT EXISTS story_blocks (
  id          TEXT PRIMARY KEY,
  chapter_id  TEXT NOT NULL REFERENCES story_chapters(id) ON DELETE CASCADE,
  position    REAL NOT NULL,
  kind        TEXT NOT NULL,   -- 'text' | 'media' | 'album' | 'slideshow' | 'map'
  entity_type TEXT,
  entity_id   TEXT,
  body        TEXT,            -- 'text' kind: markdown source
  lat         REAL,            -- 'map' kind
  lng         REAL,
  zoom        INTEGER,
  label       TEXT,
  caption     TEXT,
  layout      TEXT             -- 'default' | 'wide' | 'grid'
);

CREATE INDEX IF NOT EXISTS idx_story_chapters_story ON story_chapters(story_id, position);
CREATE INDEX IF NOT EXISTS idx_story_blocks_chapter ON story_blocks(chapter_id, position);
CREATE INDEX IF NOT EXISTS idx_story_blocks_entity  ON story_blocks(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_stories_created_by   ON stories(created_by);
