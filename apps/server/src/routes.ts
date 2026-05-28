import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { config } from "./config.js";
import { db, hasUsers, logActivity, publicUser, type Role, type User } from "./db.js";
import { hashPassword, sha256, verifyPassword } from "./crypto.js";
import { addDays, clearSession, currentSessionHash, currentUserPayload, issueSession, revokeCurrentSession } from "./auth.js";

const credentialsSchema = z.object({
  email: z.string().email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(8, "Password must be at least 8 characters").max(200)
});

const setupSchema = credentialsSchema.extend({
  displayName: z.string().trim().min(2).max(80)
});

const inviteSchema = z.object({
  role: z.enum(["admin", "member"]).default("member"),
  expiresInDays: z.number().int().min(1).max(30).default(config.inviteDays)
});

const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  theme: z.enum(["system", "light", "dark"])
});

const roleSchema = z.object({
  role: z.enum(["admin", "member"])
});

const logQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25)
});

const logCleanupSchema = z.object({
  olderThanDays: z.number().int().min(1).max(3650).default(365)
});

const audiobookLibrarySchema = z.object({
  name: z.string().trim().min(2).max(120),
  sourcePath: z.string().trim().min(1).max(1000),
  defaultLanguage: z.string().trim().min(2).max(12).default("en"),
  enrichFromOpenLibrary: z.boolean().default(false)
});

const librarySettingsSchema = z.object({
  thumbnailPath: z.string().trim().min(1).max(1000)
});

const storageRootSchema = z.object({
  name: z.string().trim().min(2).max(120),
  path: z.string().trim().min(1).max(1000)
});

const browseQuerySchema = z.object({
  path: z.string().trim().max(1000).default("")
});

function parseBody<T>(schema: z.ZodSchema<T>, body: unknown) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { error: parsed.error.flatten() };
  }

  return { data: parsed.data };
}

function getUserByEmail(email: string) {
  return db.prepare("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL").get(email) as User | undefined;
}

interface InviteListRow {
  id: string;
  token: string | null;
  role: Role;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  created_by_name: string;
  used_by_name: string | null;
}

interface UserListRow extends User {
  active_sessions: number;
}

interface SessionListRow {
  id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_seen: string;
  device_name: string | null;
  ip_address: string | null;
  user_id: string;
  display_name: string;
  email: string;
}

interface LogRow {
  id: string;
  event: string;
  detail: string;
  ip_address: string | null;
  created_at: string;
  actor_name: string | null;
}

interface AudiobookLibraryRow {
  id: string;
  name: string;
  type: "audiobook";
  source_path: string;
  settings_json: string;
  scan_status: "idle" | "scanning" | "error";
  last_scanned_at: string | null;
  created_at: string;
  updated_at: string;
  book_count: number;
  file_count: number;
}

interface AudiobookBookRow {
  id: string;
  library_id: string;
  folder_path: string;
  status: "pending" | "ready" | "error";
  discovered_at: string;
  updated_at: string;
  deleted_at: string | null;
  title: string | null;
  sort_title: string | null;
  language: string | null;
  duration_seconds: number | null;
  cover_storage_key: string | null;
  author_names: string | null;
  file_count: number;
  total_size: number | null;
}

interface StorageRootRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
  updated_at: string;
  library_count: number;
}

const audioExtensions = new Set([".m4b", ".m4a", ".mp3", ".flac", ".ogg", ".opus", ".aac"]);
const thumbnailPathSettingKey = "library.thumbnail_path";

interface OpenLibrarySearchDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  isbn?: string[];
  cover_i?: number;
}

interface OpenLibraryWork {
  description?: string | { value?: string };
  subjects?: string[];
  covers?: number[];
}

interface BookFileRow {
  id: string;
  relative_path: string;
  mime_type: string | null;
  track_number: number | null;
  chapter_title: string | null;
  duration_seconds: number | null;
  size: number | null;
  modified_at: string | null;
  status: "available" | "missing";
}

function databaseSize() {
  return [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`].reduce((total, file) => (
    total + (fs.existsSync(file) ? fs.statSync(file).size : 0)
  ), 0);
}

function sortTitle(value: string) {
  return value.replace(/^(the|a|an)\s+/i, "").trim();
}

function normaliseRelativePath(value: string) {
  return value.split(path.sep).join("/");
}

function mimeFromExtension(extension: string) {
  return {
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".m4b": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus"
  }[extension] ?? "application/octet-stream";
}

function trackNumberFromFileName(fileName: string, fallback: number) {
  const match = fileName.match(/^(\d{1,4})(?:\D|$)/);
  return match ? Number(match[1]) : fallback;
}

function validateLibrarySource(sourcePath: string) {
  const resolved = path.resolve(sourcePath);
  const thumbnailPath = getConfiguredThumbnailPath();

  if (!path.isAbsolute(resolved)) {
    throw new Error("Use an absolute server path for the audiobook source.");
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error("Audiobook source path must be an existing directory.");
  }

  const realSource = fs.realpathSync(resolved);
  const allowedRoot = findStorageRootForPath(realSource);
  if (!allowedRoot) {
    throw new Error("Choose a folder inside a configured Digital Library container.");
  }

  const realThumbnailRoot = fs.realpathSync(thumbnailPath);
  if (realSource === realThumbnailRoot || realSource.startsWith(`${realThumbnailRoot}${path.sep}`)) {
    throw new Error("Audiobook source path cannot be inside thumbnail storage.");
  }

  return realSource;
}

function validateStorageRootPath(rootPath: string) {
  const resolved = path.resolve(rootPath);

  if (!path.isAbsolute(resolved)) {
    throw new Error("Use an absolute server path for the storage container.");
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error("Storage container path must be an existing directory.");
  }

  fs.accessSync(resolved, fs.constants.R_OK);
  return fs.realpathSync(resolved);
}

function pathIsInside(candidatePath: string, rootPath: string) {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`);
}

function findStorageRootForPath(sourcePath: string) {
  const roots = db.prepare("SELECT id, path FROM storage_roots").all() as { id: string; path: string }[];
  return roots.find((root) => pathIsInside(sourcePath, root.path));
}

function publicStorageRoot(row: StorageRootRow) {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    libraryCount: row.library_count
  };
}

function configuredThumbnailPathValue() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(thumbnailPathSettingKey) as { value: string } | undefined;
  return row?.value || config.thumbnailPath || "";
}

function validateThumbnailPath(thumbnailPath: string) {
  const resolved = path.resolve(thumbnailPath);

  if (!path.isAbsolute(resolved)) {
    throw new Error("Use an absolute server path for thumbnail storage.");
  }

  fs.mkdirSync(resolved, { recursive: true });
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error("Thumbnail path must be a directory.");
  }

  fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
  return fs.realpathSync(resolved);
}

function getConfiguredThumbnailPath() {
  const thumbnailPath = configuredThumbnailPathValue();
  if (!thumbnailPath) {
    throw new Error("Configure thumbnail storage before creating a library.");
  }

  return validateThumbnailPath(thumbnailPath);
}

function thumbnailStorageKey(resourceId: string, fileName: string) {
  const shard = resourceId.slice(0, 4).padEnd(4, "0");
  return normaliseRelativePath(path.join(shard.slice(0, 2), shard.slice(2, 4), fileName));
}

function thumbnailAbsolutePath(storageKey: string) {
  const root = getConfiguredThumbnailPath();
  const absolutePath = path.resolve(root, storageKey);
  if (!pathIsInside(absolutePath, root)) {
    throw new Error("Invalid thumbnail storage key.");
  }

  return absolutePath;
}

function openLibraryDescription(work: OpenLibraryWork) {
  if (!work.description) {
    return null;
  }

  return typeof work.description === "string" ? work.description : work.description.value ?? null;
}

function openLibraryWorkId(key?: string) {
  return key?.replace(/^\/works\//, "") ?? null;
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url, {
    headers: { "User-Agent": "isputnik.home/0.1 metadata enrichment" }
  });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function downloadOpenLibraryCover(bookId: string, coverId: number) {
  const response = await fetch(`https://covers.openlibrary.org/b/id/${coverId}-L.jpg`);
  if (!response.ok) {
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    return null;
  }

  const storageKey = thumbnailStorageKey(bookId, `${bookId}-cover.jpg`);
  const absolutePath = thumbnailAbsolutePath(storageKey);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, buffer);
  return storageKey;
}

async function enrichAudiobookLibrary(libraryId: string) {
  const books = db.prepare(`
    SELECT
      books.id,
      book_metadata.title,
      book_metadata.source,
      book_metadata.cover_storage_key,
      GROUP_CONCAT(DISTINCT authors.name) AS author_names
    FROM books
    JOIN book_metadata ON book_metadata.book_id = books.id
    LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
    LEFT JOIN authors ON authors.id = book_authors.author_id
    WHERE books.library_id = ?
      AND books.deleted_at IS NULL
      AND book_metadata.source != 'manual'
    GROUP BY books.id
  `).all(libraryId) as {
    id: string;
    title: string | null;
    source: string;
    cover_storage_key: string | null;
    author_names: string | null;
  }[];

  let matched = 0;
  let updated = 0;
  let covers = 0;

  for (const book of books) {
    const title = book.title?.trim();
    const author = book.author_names?.split(",")[0]?.trim() ?? "";
    if (!title) {
      continue;
    }

    const searchUrl = new URL("https://openlibrary.org/search.json");
    searchUrl.searchParams.set("title", title);
    if (author) {
      searchUrl.searchParams.set("author", author);
    }
    searchUrl.searchParams.set("limit", "3");

    try {
      const search = await fetchJson<{ docs?: OpenLibrarySearchDoc[] }>(searchUrl.toString());
      const doc = search.docs?.[0];
      const workId = openLibraryWorkId(doc?.key);
      if (!doc || !workId) {
        continue;
      }

      matched += 1;
      const work = await fetchJson<OpenLibraryWork>(`https://openlibrary.org/works/${workId}.json`);
      const description = openLibraryDescription(work);
      const subjects = (work.subjects ?? []).slice(0, 6);
      const coverId = doc.cover_i ?? work.covers?.[0];
      let coverStorageKey = book.cover_storage_key;
      if (!coverStorageKey && coverId) {
        coverStorageKey = await downloadOpenLibraryCover(book.id, coverId);
        if (coverStorageKey) {
          covers += 1;
        }
      }

      db.transaction(() => {
        db.prepare(`
          UPDATE book_metadata
          SET
            source = 'openlibrary',
            description = COALESCE(?, description),
            year_published = COALESCE(?, year_published),
            isbn = COALESCE(?, isbn),
            openlibrary_id = ?,
            cover_storage_key = COALESCE(?, cover_storage_key),
            updated_at = CURRENT_TIMESTAMP
          WHERE book_id = ?
            AND source != 'manual'
        `).run(
          description,
          doc.first_publish_year ?? null,
          doc.isbn?.[0] ?? null,
          workId,
          coverStorageKey,
          book.id
        );

        for (const subject of subjects) {
          const genreId = nanoid(16);
          db.prepare(`
            INSERT INTO genres (id, library_id, name)
            VALUES (?, ?, ?)
            ON CONFLICT(library_id, name) DO NOTHING
          `).run(genreId, libraryId, subject);
          const genre = db.prepare("SELECT id FROM genres WHERE library_id = ? AND name = ?")
            .get(libraryId, subject) as { id: string };
          db.prepare(`
            INSERT INTO book_genres (book_id, genre_id)
            VALUES (?, ?)
            ON CONFLICT(book_id, genre_id) DO NOTHING
          `).run(book.id, genre.id);
        }
      })();

      updated += 1;
    } catch {
      // OpenLibrary enrichment is best-effort and should not block local library use.
    }
  }

  return { matched, updated, covers };
}

function relativePathWithinRoot(rootPath: string, requestedRelativePath: string) {
  const candidate = path.resolve(rootPath, requestedRelativePath || ".");
  const realCandidate = fs.realpathSync(candidate);
  if (!pathIsInside(realCandidate, rootPath)) {
    throw new Error("Selected folder is outside the storage container.");
  }

  if (!fs.statSync(realCandidate).isDirectory()) {
    throw new Error("Selected path must be a directory.");
  }

  return realCandidate;
}

function walkAudiobookFiles(rootPath: string) {
  const filesByFolder = new Map<string, { absolutePath: string; fileName: string; relativePath: string; stat: fs.Stats }[]>();

  const walk = (currentPath: string) => {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        const real = fs.realpathSync(absolutePath);
        if (!real.startsWith(`${rootPath}${path.sep}`)) {
          continue;
        }
      }

      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!audioExtensions.has(extension)) {
        continue;
      }

      const folderPath = path.dirname(absolutePath);
      const relativePath = normaliseRelativePath(path.relative(rootPath, absolutePath));
      const stat = fs.statSync(absolutePath);
      const files = filesByFolder.get(folderPath) ?? [];
      files.push({ absolutePath, fileName: entry.name, relativePath, stat });
      filesByFolder.set(folderPath, files);
    }
  };

  walk(rootPath);
  return filesByFolder;
}

function scanAudiobookLibrary(libraryId: string) {
  const library = db.prepare("SELECT id, source_path, settings_json FROM libraries WHERE id = ? AND type = 'audiobook'")
    .get(libraryId) as { id: string; source_path: string; settings_json: string } | undefined;
  if (!library) {
    throw new Error("Audiobook library not found.");
  }

  const rootPath = validateLibrarySource(library.source_path);
  const settings = JSON.parse(library.settings_json || "{}") as { default_language?: string };
  const filesByFolder = walkAudiobookFiles(rootPath);
  const foundFolders = new Set<string>();
  let discoveredBooks = 0;
  let discoveredFiles = 0;

  db.transaction(() => {
    db.prepare("UPDATE libraries SET scan_status = 'scanning', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(libraryId);

    for (const [folderAbsolutePath, files] of filesByFolder.entries()) {
      const folderPath = normaliseRelativePath(path.relative(rootPath, folderAbsolutePath)) || ".";
      foundFolders.add(folderPath);
      const existingBook = db.prepare("SELECT id FROM books WHERE library_id = ? AND folder_path = ?")
        .get(libraryId, folderPath) as { id: string } | undefined;
      const bookId = existingBook?.id ?? nanoid(16);
      const title = path.basename(folderAbsolutePath);
      const authorHint = path.basename(path.dirname(folderAbsolutePath));
      const authorId = nanoid(16);

      if (existingBook) {
        db.prepare(`
          UPDATE books
          SET status = 'ready', updated_at = CURRENT_TIMESTAMP, deleted_at = NULL
          WHERE id = ?
        `).run(bookId);
      } else {
        db.prepare(`
          INSERT INTO books (id, library_id, folder_path, status)
          VALUES (?, ?, ?, 'ready')
        `).run(bookId, libraryId, folderPath);
      }

      db.prepare(`
        INSERT INTO book_metadata (id, book_id, source, title, sort_title, language)
        VALUES (?, ?, 'scan', ?, ?, ?)
        ON CONFLICT(book_id) DO UPDATE SET
          title = CASE WHEN book_metadata.source = 'manual' THEN book_metadata.title ELSE excluded.title END,
          sort_title = CASE WHEN book_metadata.source = 'manual' THEN book_metadata.sort_title ELSE excluded.sort_title END,
          language = COALESCE(book_metadata.language, excluded.language),
          updated_at = CURRENT_TIMESTAMP
      `).run(nanoid(16), bookId, title, sortTitle(title), settings.default_language ?? "en");

      db.prepare(`
        INSERT INTO authors (id, library_id, name, sort_name)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(library_id, name) DO NOTHING
      `).run(authorId, libraryId, authorHint, sortTitle(authorHint));
      const author = db.prepare("SELECT id FROM authors WHERE library_id = ? AND name = ?")
        .get(libraryId, authorHint) as { id: string };
      db.prepare(`
        INSERT INTO book_authors (book_id, author_id, role, sort_order)
        VALUES (?, ?, 'author', 0)
        ON CONFLICT(book_id, author_id, role) DO NOTHING
      `).run(bookId, author.id);

      db.prepare("UPDATE book_files SET status = 'missing', deleted_at = CURRENT_TIMESTAMP WHERE book_id = ?").run(bookId);
      files
        .sort((left, right) => left.fileName.localeCompare(right.fileName, undefined, { numeric: true }))
        .forEach((file, index) => {
          const extension = path.extname(file.fileName).toLowerCase();
          const fileId = nanoid(16);
          db.prepare(`
            INSERT INTO book_files (
              id, book_id, relative_path, mime_type, track_number, chapter_title, size, modified_at, status, deleted_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', NULL)
            ON CONFLICT(book_id, relative_path) DO UPDATE SET
              mime_type = excluded.mime_type,
              track_number = excluded.track_number,
              chapter_title = excluded.chapter_title,
              size = excluded.size,
              modified_at = excluded.modified_at,
              status = 'available',
              deleted_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          `).run(
            fileId,
            bookId,
            file.relativePath,
            mimeFromExtension(extension),
            trackNumberFromFileName(file.fileName, index + 1),
            path.basename(file.fileName, extension),
            file.stat.size,
            file.stat.mtime.toISOString()
          );
          discoveredFiles += 1;
        });

      discoveredBooks += 1;
    }

    const knownBooks = db.prepare("SELECT id, folder_path FROM books WHERE library_id = ? AND deleted_at IS NULL")
      .all(libraryId) as { id: string; folder_path: string }[];
    for (const book of knownBooks) {
      if (!foundFolders.has(book.folder_path)) {
        db.prepare("UPDATE books SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(book.id);
        db.prepare("UPDATE book_files SET status = 'missing', deleted_at = CURRENT_TIMESTAMP WHERE book_id = ?").run(book.id);
      }
    }

    db.prepare(`
      INSERT INTO jobs (id, type, payload, status, completed_at)
      VALUES (?, 'SCAN_AUDIOBOOK_LIBRARY', ?, 'completed', CURRENT_TIMESTAMP)
    `).run(nanoid(16), JSON.stringify({ libraryId, discoveredBooks, discoveredFiles }));
    db.prepare(`
      UPDATE libraries
      SET scan_status = 'idle', last_scanned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(libraryId);
  })();

  return { discoveredBooks, discoveredFiles };
}

function publicAudiobookLibrary(row: AudiobookLibraryRow, includeSourcePath: boolean) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    sourcePath: includeSourcePath ? row.source_path : undefined,
    settings: JSON.parse(row.settings_json || "{}") as unknown,
    scanStatus: row.scan_status,
    lastScannedAt: row.last_scanned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bookCount: row.book_count,
    fileCount: row.file_count
  };
}

export async function registerRoutes(app: FastifyInstance) {
  app.get("/api/setup/status", async () => ({
    requiresSetup: !hasUsers()
  }));

  app.post("/api/setup/admin", async (request, reply) => {
    if (hasUsers()) {
      reply.code(409).send({ error: "Setup has already been completed" });
      return;
    }

    const parsed = parseBody(setupSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid setup details", details: parsed.error });
      return;
    }

    const userId = nanoid(16);
    const passwordHash = await hashPassword(parsed.data.password);
    const user = db.transaction(() => {
      db.prepare(`
        INSERT INTO users (id, email, password_hash, display_name, role, protected_from_delete)
        VALUES (?, ?, ?, ?, 'admin', 1)
      `).run(userId, parsed.data.email, passwordHash, parsed.data.displayName);

      return db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as User;
    })();

    issueSession(reply, user.id, request);
    logActivity({
      event: "account.setup",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: "Created the setup administrator account.",
      ipAddress: request.ip
    });
    reply.code(201).send({ user: publicUser(user) });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = parseBody(credentialsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid login details", details: parsed.error });
      return;
    }

    const user = getUserByEmail(parsed.data.email);
    if (!user || !user.is_active || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      logActivity({
        event: "auth.login_failed",
        detail: "A sign-in attempt failed.",
        ipAddress: request.ip
      });
      reply.code(401).send({ error: "Invalid email or password" });
      return;
    }

    issueSession(reply, user.id, request);
    logActivity({
      event: "auth.login",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: "Signed in.",
      ipAddress: request.ip
    });
    reply.send({ user: publicUser(user) });
  });

  app.post("/api/auth/logout", { preHandler: app.authenticate }, async (request, reply) => {
    logActivity({
      event: "auth.logout",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail: "Signed out.",
      ipAddress: request.ip
    });
    revokeCurrentSession(request);
    clearSession(reply);
    reply.send({ ok: true });
  });

  app.get("/api/auth/me", { preHandler: app.authenticate }, async (request) => ({
    user: currentUserPayload(request)
  }));

  app.patch("/api/profile", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(profileSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid profile details", details: parsed.error });
      return;
    }

    db.prepare(`
      UPDATE users
      SET display_name = ?, theme = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(parsed.data.displayName, parsed.data.theme, request.user!.id);

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(request.user!.id) as User;
    logActivity({
      event: "profile.updated",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: "Updated profile settings.",
      ipAddress: request.ip
    });
    reply.send({ user: publicUser(user) });
  });

  app.post("/api/invites", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(inviteSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid invite details", details: parsed.error });
      return;
    }

    const token = nanoid(36);
    const inviteId = nanoid(16);
    const expiresInDays = parsed.data.expiresInDays ?? config.inviteDays;
    const expiresAt = addDays(expiresInDays).toISOString();
    db.prepare(`
      INSERT INTO invites (id, token_hash, token, role, created_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(inviteId, sha256(token), token, parsed.data.role, request.user!.id, expiresAt);
    logActivity({
      event: "invite.created",
      actorUserId: request.user!.id,
      targetType: "invite",
      targetId: inviteId,
      detail: `Created a ${parsed.data.role} invite link.`,
      ipAddress: request.ip
    });

    reply.code(201).send({
      invite: {
        id: inviteId,
        role: parsed.data.role,
        expiresAt,
        url: `${config.appUrl}/invite/${token}`
      }
    });
  });

  app.get("/api/invites", { preHandler: app.requireAdmin }, async () => {
    const invites = db.prepare(`
      SELECT
        invites.id,
        invites.token,
        invites.role,
        invites.created_at,
        invites.expires_at,
        invites.used_at,
        creator.display_name AS created_by_name,
        used.display_name AS used_by_name
      FROM invites
      JOIN users AS creator ON creator.id = invites.created_by
      LEFT JOIN users AS used ON used.id = invites.used_by
      WHERE invites.revoked_at IS NULL
      ORDER BY datetime(invites.created_at) DESC
    `).all() as InviteListRow[];
    const now = Date.now();

    return {
      invites: invites.map((invite) => ({
        id: invite.id,
        role: invite.role,
        url: invite.token ? `${config.appUrl}/invite/${invite.token}` : null,
        createdAt: invite.created_at,
        expiresAt: invite.expires_at,
        usedAt: invite.used_at,
        createdByName: invite.created_by_name,
        usedByName: invite.used_by_name,
        status: invite.used_at ? "used" : new Date(invite.expires_at).getTime() <= now ? "expired" : "active"
      }))
    };
  });

  app.delete("/api/invites/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const result = db.prepare(`
      UPDATE invites
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revoked_at IS NULL
    `).run(id);

    if (result.changes === 0) {
      reply.code(404).send({ error: "Invite link not found" });
      return;
    }

    logActivity({
      event: "invite.revoked",
      actorUserId: request.user!.id,
      targetType: "invite",
      targetId: id,
      detail: "Revoked an invite link.",
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  app.get("/api/invites/:token", async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const invite = db.prepare(`
      SELECT id, role, expires_at
      FROM invites
      WHERE token_hash = ?
        AND used_at IS NULL
        AND revoked_at IS NULL
        AND datetime(expires_at) > CURRENT_TIMESTAMP
    `).get(sha256(token)) as { id: string; role: Role; expires_at: string } | undefined;

    if (!invite) {
      reply.code(404).send({ error: "Invite is invalid or expired" });
      return;
    }

    reply.send({ invite: { id: invite.id, role: invite.role, expiresAt: invite.expires_at } });
  });

  app.post("/api/invites/:token/accept", async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const parsed = parseBody(setupSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid account details", details: parsed.error });
      return;
    }

    const invite = db.prepare(`
      SELECT id, role
      FROM invites
      WHERE token_hash = ?
        AND used_at IS NULL
        AND revoked_at IS NULL
        AND datetime(expires_at) > CURRENT_TIMESTAMP
    `).get(sha256(token)) as { id: string; role: Role } | undefined;

    if (!invite) {
      reply.code(404).send({ error: "Invite is invalid or expired" });
      return;
    }

    if (getUserByEmail(parsed.data.email)) {
      reply.code(409).send({ error: "An account with this email already exists" });
      return;
    }

    const userId = nanoid(16);
    const passwordHash = await hashPassword(parsed.data.password);
    const user = db.transaction(() => {
      db.prepare(`
        INSERT INTO users (id, email, password_hash, display_name, role)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, parsed.data.email, passwordHash, parsed.data.displayName, invite.role);
      db.prepare("UPDATE invites SET used_at = CURRENT_TIMESTAMP, used_by = ? WHERE id = ?").run(userId, invite.id);
      return db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as User;
    })();

    issueSession(reply, user.id, request);
    logActivity({
      event: "invite.accepted",
      actorUserId: user.id,
      targetType: "invite",
      targetId: invite.id,
      detail: "Accepted an invite and created an account.",
      ipAddress: request.ip
    });
    reply.code(201).send({ user: publicUser(user) });
  });

  app.get("/api/users", { preHandler: app.requireAdmin }, async () => {
    const users = db.prepare(`
      SELECT
        users.*,
        COUNT(sessions.id) AS active_sessions
      FROM users
      LEFT JOIN sessions ON sessions.user_id = users.id
        AND sessions.revoked_at IS NULL
        AND datetime(sessions.expires_at) > CURRENT_TIMESTAMP
      WHERE users.deleted_at IS NULL
      GROUP BY users.id
      ORDER BY datetime(users.created_at) ASC
    `).all() as UserListRow[];

    return {
      users: users.map((user) => ({
        ...publicUser(user),
        activeSessions: user.active_sessions
      }))
    };
  });

  app.patch("/api/users/:id/role", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(roleSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid account role", details: parsed.error });
      return;
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      reply.code(404).send({ error: "User not found" });
      return;
    }

    if (user.protected_from_delete || id === request.user!.id) {
      reply.code(409).send({ error: "This administrator role cannot be changed here" });
      return;
    }

    db.prepare("UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(parsed.data.role, id);
    logActivity({
      event: "user.role_changed",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Changed ${user.display_name}'s role to ${parsed.data.role}.`,
      ipAddress: request.ip
    });
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User;
    reply.send({ user: publicUser(updated) });
  });

  app.delete("/api/users/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      reply.code(404).send({ error: "User not found" });
      return;
    }

    if (user.protected_from_delete) {
      reply.code(409).send({ error: "This protected setup admin cannot be deleted" });
      return;
    }

    if (user.id === request.user!.id) {
      reply.code(409).send({ error: "You cannot deactivate your current account" });
      return;
    }

    db.transaction(() => {
      db.prepare("UPDATE users SET deleted_at = CURRENT_TIMESTAMP, is_active = 0 WHERE id = ?").run(id);
      db.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(id);
    })();

    logActivity({
      event: "user.deactivated",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Deactivated ${user.display_name}'s account.`,
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  app.get("/api/sessions", { preHandler: app.requireAdmin }, async (request) => {
    const rows = db.prepare(`
      SELECT
        sessions.id,
        sessions.token_hash,
        sessions.created_at,
        sessions.expires_at,
        sessions.last_seen,
        sessions.device_name,
        sessions.ip_address,
        users.id AS user_id,
        users.display_name,
        users.email
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.revoked_at IS NULL
        AND datetime(sessions.expires_at) > CURRENT_TIMESTAMP
        AND users.deleted_at IS NULL
      ORDER BY datetime(sessions.last_seen) DESC
    `).all() as SessionListRow[];
    const tokenHash = currentSessionHash(request);

    return {
      sessions: rows.map((session) => ({
        id: session.id,
        userId: session.user_id,
        displayName: session.display_name,
        email: session.email,
        createdAt: session.created_at,
        expiresAt: session.expires_at,
        lastSeen: session.last_seen,
        deviceName: session.device_name,
        ipAddress: session.ip_address,
        current: session.token_hash === tokenHash
      }))
    };
  });

  app.delete("/api/sessions/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const session = db.prepare("SELECT id, token_hash, user_id FROM sessions WHERE id = ? AND revoked_at IS NULL").get(id) as {
      id: string;
      token_hash: string;
      user_id: string;
    } | undefined;
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }

    if (session.token_hash === currentSessionHash(request)) {
      reply.code(409).send({ error: "Use sign out to end your current session" });
      return;
    }

    db.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    logActivity({
      event: "session.revoked",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: session.user_id,
      detail: "Revoked an active session.",
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  app.get("/api/logs", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(logQuerySchema, request.query);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid log query", details: parsed.error });
      return;
    }

    const query = parsed.data.q ?? "";
    const pageSize = parsed.data.pageSize ?? 25;
    const requestedPage = parsed.data.page ?? 1;
    const search = `%${query}%`;
    const where = query
      ? `WHERE activity_logs.event LIKE @search
          OR activity_logs.detail LIKE @search
          OR activity_logs.ip_address LIKE @search
          OR users.display_name LIKE @search`
      : "";
    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM activity_logs
      LEFT JOIN users ON users.id = activity_logs.actor_user_id
      ${where}
    `).get({ search }) as { count: number };
    const totalPages = Math.max(1, Math.ceil(count.count / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = db.prepare(`
      SELECT
        activity_logs.id,
        activity_logs.event,
        activity_logs.detail,
        activity_logs.ip_address,
        activity_logs.created_at,
        users.display_name AS actor_name
      FROM activity_logs
      LEFT JOIN users ON users.id = activity_logs.actor_user_id
      ${where}
      ORDER BY datetime(activity_logs.created_at) DESC, activity_logs.id DESC
      LIMIT @pageSize OFFSET @offset
    `).all({
      search,
      pageSize,
      offset: (page - 1) * pageSize
    }) as LogRow[];

    return {
      logs: rows.map((row) => ({
        id: row.id,
        event: row.event,
        detail: row.detail,
        ipAddress: row.ip_address,
        createdAt: row.created_at,
        actorName: row.actor_name
      })),
      page,
      pageSize,
      total: count.count,
      totalPages
    };
  });

  app.delete("/api/logs", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(logCleanupSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid log cleanup period", details: parsed.error });
      return;
    }

    const result = db.prepare(`
      DELETE FROM activity_logs
      WHERE datetime(created_at) < datetime('now', ?)
    `).run(`-${parsed.data.olderThanDays} days`);

    if (result.changes > 0) {
      logActivity({
        event: "logs.deleted",
        actorUserId: request.user!.id,
        targetType: "log",
        detail: `Deleted ${result.changes} log entries older than ${parsed.data.olderThanDays} days.`,
        ipAddress: request.ip
      });
    }

    reply.send({ deleted: result.changes, olderThanDays: parsed.data.olderThanDays });
  });

  app.get("/api/library/settings", { preHandler: app.requireAdmin }, async () => {
    const thumbnailPath = configuredThumbnailPathValue();
    let thumbnailPathReady = false;
    let thumbnailPathError = "";

    if (thumbnailPath) {
      try {
        validateThumbnailPath(thumbnailPath);
        thumbnailPathReady = true;
      } catch (err) {
        thumbnailPathError = err instanceof Error ? err.message : "Thumbnail path is not writable.";
      }
    }

    return {
      settings: {
        thumbnailPath,
        thumbnailPathReady,
        thumbnailPathError,
        fromEnvironment: Boolean(config.thumbnailPath)
      }
    };
  });

  app.patch("/api/library/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(librarySettingsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid library settings", details: parsed.error });
      return;
    }

    let thumbnailPath: string;
    try {
      thumbnailPath = validateThumbnailPath(parsed.data.thumbnailPath);
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Thumbnail path is not writable." });
      return;
    }

    db.prepare(`
      INSERT INTO app_settings (key, value, updated_by, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(thumbnailPathSettingKey, thumbnailPath, request.user!.id);

    logActivity({
      event: "library.settings.updated",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: thumbnailPathSettingKey,
      detail: "Updated Digital Library thumbnail storage path.",
      ipAddress: request.ip
    });

    reply.send({
      settings: {
        thumbnailPath,
        thumbnailPathReady: true,
        thumbnailPathError: "",
        fromEnvironment: Boolean(config.thumbnailPath)
      }
    });
  });

  app.get("/api/storage/roots", { preHandler: app.requireAdmin }, async () => {
    const rows = db.prepare(`
      SELECT
        storage_roots.*,
        COUNT(libraries.id) AS library_count
      FROM storage_roots
      LEFT JOIN libraries ON libraries.source_path = storage_roots.path
        OR libraries.source_path LIKE storage_roots.path || ?
      GROUP BY storage_roots.id
      ORDER BY storage_roots.name COLLATE NOCASE
    `).all(`${path.sep}%`) as StorageRootRow[];

    return { roots: rows.map(publicStorageRoot) };
  });

  app.post("/api/storage/roots", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(storageRootSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid storage container details", details: parsed.error });
      return;
    }

    let rootPath: string;
    try {
      rootPath = validateStorageRootPath(parsed.data.path);
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Invalid storage container path" });
      return;
    }

    const id = nanoid(16);
    try {
      db.prepare(`
        INSERT INTO storage_roots (id, name, path, created_by)
        VALUES (?, ?, ?, ?)
      `).run(id, parsed.data.name, rootPath, request.user!.id);
    } catch {
      reply.code(409).send({ error: "A storage container already uses that path." });
      return;
    }

    logActivity({
      event: "storage.root.created",
      actorUserId: request.user!.id,
      targetType: "storage_root",
      targetId: id,
      detail: `Added Digital Library storage container "${parsed.data.name}".`,
      ipAddress: request.ip
    });

    reply.code(201).send({ root: { id, name: parsed.data.name, path: rootPath, libraryCount: 0 } });
  });

  app.delete("/api/storage/roots/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const root = db.prepare("SELECT id, name, path FROM storage_roots WHERE id = ?").get(id) as {
      id: string;
      name: string;
      path: string;
    } | undefined;

    if (!root) {
      reply.code(404).send({ error: "Storage container not found" });
      return;
    }

    const inUse = db.prepare(`
      SELECT COUNT(*) AS count
      FROM libraries
      WHERE source_path = ?
        OR source_path LIKE ?
    `).get(root.path, `${root.path}${path.sep}%`) as { count: number };

    if (inUse.count > 0) {
      reply.code(409).send({ error: "This storage container is already used by a library." });
      return;
    }

    db.prepare("DELETE FROM storage_roots WHERE id = ?").run(id);
    logActivity({
      event: "storage.root.deleted",
      actorUserId: request.user!.id,
      targetType: "storage_root",
      targetId: id,
      detail: `Deleted Digital Library storage container "${root.name}".`,
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  app.get("/api/storage/roots/:id/browse", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(browseQuerySchema, request.query);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid browse path", details: parsed.error });
      return;
    }

    const root = db.prepare("SELECT id, name, path FROM storage_roots WHERE id = ?").get(id) as {
      id: string;
      name: string;
      path: string;
    } | undefined;
    if (!root) {
      reply.code(404).send({ error: "Storage container not found" });
      return;
    }

    try {
      const currentPath = relativePathWithinRoot(root.path, parsed.data.path ?? "");
      const currentRelativePath = normaliseRelativePath(path.relative(root.path, currentPath));
      const entries = fs.readdirSync(currentPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .flatMap((entry) => {
          const absolutePath = path.join(currentPath, entry.name);
          try {
            const realPath = fs.realpathSync(absolutePath);
            if (!pathIsInside(realPath, root.path) || !fs.statSync(realPath).isDirectory()) {
              return [];
            }
            return [{
              name: entry.name,
              relativePath: normaliseRelativePath(path.relative(root.path, realPath))
            }];
          } catch {
            return [];
          }
        })
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));

      const parentPath = currentPath === root.path
        ? null
        : normaliseRelativePath(path.relative(root.path, path.dirname(currentPath)));

      return {
        root: { ...root, libraryCount: 0 },
        currentPath: currentRelativePath,
        selectedPath: currentPath,
        parentPath,
        entries
      };
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to browse storage container" });
    }
  });

  app.post("/api/library/audiobook-libraries", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(audiobookLibrarySchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid audiobook library details", details: parsed.error });
      return;
    }

    let sourcePath: string;
    try {
      sourcePath = validateLibrarySource(parsed.data.sourcePath);
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Invalid audiobook source path" });
      return;
    }

    const libraryId = nanoid(16);
    const settings = {
      folder_structure: "author_book",
      enrich_from_openlibrary: parsed.data.enrichFromOpenLibrary,
      default_language: parsed.data.defaultLanguage,
      show_narrator: true,
      supported_extensions: Array.from(audioExtensions).map((extension) => extension.slice(1)),
      cover_filenames: ["cover", "folder", "artwork"]
    };

    db.prepare(`
      INSERT INTO libraries (id, name, type, source_path, settings_json, created_by)
      VALUES (?, ?, 'audiobook', ?, ?, ?)
    `).run(libraryId, parsed.data.name, sourcePath, JSON.stringify(settings), request.user!.id);

    let scanResult = { discoveredBooks: 0, discoveredFiles: 0 };
    try {
      scanResult = scanAudiobookLibrary(libraryId);
    } catch (err) {
      db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(libraryId);
      reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to scan audiobook library" });
      return;
    }

    logActivity({
      event: "library.audiobook.created",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: libraryId,
      detail: `Created audiobook library "${parsed.data.name}" with ${scanResult.discoveredBooks} books.`,
      ipAddress: request.ip
    });

    reply.code(201).send({ library: { id: libraryId }, scan: scanResult });
  });

  app.get("/api/library/audiobook-libraries", { preHandler: app.authenticate }, async (request) => {
    const rows = db.prepare(`
      SELECT
        libraries.*,
        COUNT(DISTINCT books.id) AS book_count,
        COUNT(book_files.id) AS file_count
      FROM libraries
      LEFT JOIN books ON books.library_id = libraries.id AND books.deleted_at IS NULL
      LEFT JOIN book_files ON book_files.book_id = books.id AND book_files.status = 'available'
      WHERE libraries.type = 'audiobook'
      GROUP BY libraries.id
      ORDER BY datetime(libraries.created_at) DESC
    `).all() as AudiobookLibraryRow[];

    return {
      libraries: rows.map((row) => publicAudiobookLibrary(row, request.user?.role === "admin"))
    };
  });

  app.post("/api/library/audiobook-libraries/:id/rescan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, name FROM libraries WHERE id = ? AND type = 'audiobook'")
      .get(id) as { id: string; name: string } | undefined;
    if (!exists) {
      reply.code(404).send({ error: "Audiobook library not found" });
      return;
    }

    try {
      const scan = scanAudiobookLibrary(id);
      logActivity({
        event: "library.audiobook.scanned",
        actorUserId: request.user!.id,
        targetType: "library",
        targetId: id,
        detail: `Scanned audiobook library "${exists.name}" and found ${scan.discoveredBooks} books.`,
        ipAddress: request.ip
      });
      reply.send({ scan });
    } catch (err) {
      db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
      reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to scan audiobook library" });
    }
  });

  app.post("/api/library/audiobook-libraries/:id/enrich", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, name FROM libraries WHERE id = ? AND type = 'audiobook'")
      .get(id) as { id: string; name: string } | undefined;
    if (!exists) {
      reply.code(404).send({ error: "Audiobook library not found" });
      return;
    }

    try {
      const result = await enrichAudiobookLibrary(id);
      logActivity({
        event: "library.audiobook.enriched",
        actorUserId: request.user!.id,
        targetType: "library",
        targetId: id,
        detail: `Enriched audiobook library "${exists.name}" from OpenLibrary.`,
        ipAddress: request.ip
      });
      reply.send({ enrichment: result });
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to enrich audiobook library" });
    }
  });

  app.get("/api/library/covers/*", { preHandler: app.authenticate }, async (request, reply) => {
    const storageKey = (request.params as { "*": string })["*"];
    try {
      const absolutePath = thumbnailAbsolutePath(storageKey);
      if (!fs.existsSync(absolutePath)) {
        reply.code(404).send({ error: "Cover not found" });
        return;
      }

      reply.type("image/jpeg").send(fs.createReadStream(absolutePath));
    } catch {
      reply.code(404).send({ error: "Cover not found" });
    }
  });

  app.get("/api/library/audiobook-libraries/:id/books", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const library = db.prepare("SELECT id FROM libraries WHERE id = ? AND type = 'audiobook'").get(id);
    if (!library) {
      reply.code(404).send({ error: "Audiobook library not found" });
      return;
    }

    const books = db.prepare(`
      SELECT
        books.id,
        books.library_id,
        books.folder_path,
        books.status,
        books.discovered_at,
        books.updated_at,
        books.deleted_at,
        book_metadata.title,
        book_metadata.sort_title,
        book_metadata.language,
        book_metadata.duration_seconds,
        book_metadata.cover_storage_key,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names,
        (
          SELECT COUNT(*)
          FROM book_files
          WHERE book_files.book_id = books.id
            AND book_files.status = 'available'
        ) AS file_count,
        (
          SELECT COALESCE(SUM(book_files.size), 0)
          FROM book_files
          WHERE book_files.book_id = books.id
            AND book_files.status = 'available'
        ) AS total_size
      FROM books
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      WHERE books.library_id = ?
        AND books.deleted_at IS NULL
      GROUP BY books.id
      ORDER BY COALESCE(book_metadata.sort_title, book_metadata.title, books.folder_path) COLLATE NOCASE
    `).all(id) as AudiobookBookRow[];

    return {
      books: books.map((book) => ({
        id: book.id,
        libraryId: book.library_id,
        folderPath: book.folder_path,
        status: book.status,
        title: book.title ?? path.basename(book.folder_path),
        sortTitle: book.sort_title,
        language: book.language,
        authors: book.author_names ? book.author_names.split(", ") : [],
        fileCount: book.file_count,
        totalSize: book.total_size ?? 0,
        durationSeconds: book.duration_seconds,
        coverUrl: book.cover_storage_key ? `/api/library/covers/${book.cover_storage_key}` : null,
        discoveredAt: book.discovered_at,
        updatedAt: book.updated_at
      }))
    };
  });

  app.get("/api/library/books/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const book = db.prepare(`
      SELECT
        books.id,
        books.library_id,
        books.folder_path,
        books.status,
        books.discovered_at,
        books.updated_at,
        books.deleted_at,
        libraries.name AS library_name,
        book_metadata.title,
        book_metadata.sort_title,
        book_metadata.description,
        book_metadata.year_published,
        book_metadata.language,
        book_metadata.duration_seconds,
        book_metadata.cover_storage_key,
        book_metadata.isbn,
        book_metadata.openlibrary_id,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names
      FROM books
      JOIN libraries ON libraries.id = books.library_id
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      WHERE books.id = ?
        AND books.deleted_at IS NULL
      GROUP BY books.id
    `).get(id) as (AudiobookBookRow & {
      library_name: string;
      description: string | null;
      year_published: number | null;
      isbn: string | null;
      openlibrary_id: string | null;
    }) | undefined;

    if (!book) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const files = db.prepare(`
      SELECT id, relative_path, mime_type, track_number, chapter_title, duration_seconds, size, modified_at, status
      FROM book_files
      WHERE book_id = ?
      ORDER BY track_number, relative_path COLLATE NOCASE
    `).all(id) as BookFileRow[];

    reply.send({
      book: {
        id: book.id,
        libraryId: book.library_id,
        libraryName: book.library_name,
        folderPath: book.folder_path,
        status: book.status,
        title: book.title ?? path.basename(book.folder_path),
        sortTitle: book.sort_title,
        description: book.description,
        yearPublished: book.year_published,
        language: book.language,
        authors: book.author_names ? book.author_names.split(",") : [],
        durationSeconds: book.duration_seconds,
        coverUrl: book.cover_storage_key ? `/api/library/covers/${book.cover_storage_key}` : null,
        isbn: book.isbn,
        openLibraryId: book.openlibrary_id,
        discoveredAt: book.discovered_at,
        updatedAt: book.updated_at,
        files: files.map((file) => ({
          id: file.id,
          relativePath: file.relative_path,
          mimeType: file.mime_type,
          trackNumber: file.track_number,
          chapterTitle: file.chapter_title,
          durationSeconds: file.duration_seconds,
          size: file.size ?? 0,
          modifiedAt: file.modified_at,
          status: file.status
        }))
      }
    });
  });

  app.get("/api/status", { preHandler: app.requireAdmin }, async () => {
    const users = db.prepare("SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL").get() as { count: number };
    const sessions = db.prepare(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE revoked_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP
    `).get() as { count: number };
    const activeInvites = db.prepare(`
      SELECT COUNT(*) AS count FROM invites
      WHERE revoked_at IS NULL AND used_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP
    `).get() as { count: number };
    const events = db.prepare("SELECT COUNT(*) AS count FROM activity_logs").get() as { count: number };
    const audiobookLibraries = db.prepare("SELECT COUNT(*) AS count FROM libraries WHERE type = 'audiobook'").get() as { count: number };
    const audiobookBooks = db.prepare("SELECT COUNT(*) AS count FROM books WHERE deleted_at IS NULL").get() as { count: number };

    return {
      status: {
        health: "Operational",
        databaseBytes: databaseSize(),
        users: users.count,
        activeSessions: sessions.count,
        activeInvites: activeInvites.count,
        logEntries: events.count,
        audiobookLibraries: audiobookLibraries.count,
        audiobookBooks: audiobookBooks.count,
        uptimeSeconds: Math.floor(process.uptime()),
        generatedAt: new Date().toISOString()
      }
    };
  });

  app.get("/api/about", { preHandler: app.authenticate }, async () => ({
    about: {
      name: "isputnik.home",
      version: config.version,
      description: config.description,
      runtime: `Node.js ${process.version}`,
      database: "SQLite (WAL mode)",
      server: "Fastify + TypeScript",
      frontend: "React + TypeScript",
      versionUpdates: [
        {
          version: config.version,
          label: "Current development version",
          changes: [
            "Added the application shell with protected routes, profile settings, and light, dark, and system themes.",
            "Added invite-only account creation with copyable invitation links, link status, and revocation.",
            "Added the control panel with status, logs, user roles, active session management, and About.",
            "Grouped control-panel navigation and made About available in the main application.",
            "Added compact log search, paging, and manual retention cleanup with a 365-day default."
          ]
        }
      ]
    }
  }));
}
