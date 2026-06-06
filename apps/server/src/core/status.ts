import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { config } from "../config.js";

function databaseSize() {
  return [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`].reduce((total, file) => (
    total + (fs.existsSync(file) ? fs.statSync(file).size : 0)
  ), 0);
}

interface LibraryStatsRow {
  id: string;
  name: string;
  book_count: number;
  total_size_bytes: number;
  total_duration_seconds: number;
}

interface PersonStatsRow {
  name: string;
  book_count: number;
  total_duration_seconds: number;
}

interface LongestBookRow {
  id: string;
  title: string;
  library_name: string;
  author_names: string | null;
  total_size_bytes: number;
  total_duration_seconds: number;
}

function audiobookLibraryStats() {
  const libraries = db.prepare(`
    WITH file_totals AS (
      SELECT
        book_id,
        SUM(COALESCE(size, 0)) AS size_bytes,
        SUM(COALESCE(duration_seconds, 0)) AS duration_seconds
      FROM book_files
      WHERE deleted_at IS NULL AND status = 'available'
      GROUP BY book_id
    ),
    book_totals AS (
      SELECT
        books.id,
        books.library_id,
        COALESCE(book_metadata.duration_seconds, file_totals.duration_seconds, 0) AS duration_seconds,
        COALESCE(file_totals.size_bytes, 0) AS size_bytes
      FROM books
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN file_totals ON file_totals.book_id = books.id
      WHERE books.deleted_at IS NULL
    )
    SELECT
      libraries.id,
      libraries.name,
      COUNT(book_totals.id) AS book_count,
      COALESCE(SUM(book_totals.size_bytes), 0) AS total_size_bytes,
      COALESCE(SUM(book_totals.duration_seconds), 0) AS total_duration_seconds
    FROM libraries
    LEFT JOIN book_totals ON book_totals.library_id = libraries.id
    WHERE libraries.type = 'audiobook'
    GROUP BY libraries.id, libraries.name
    ORDER BY libraries.name COLLATE NOCASE
  `).all() as LibraryStatsRow[];

  const peopleByRole = (role: "author" | "narrator") => db.prepare(`
    WITH file_totals AS (
      SELECT
        book_id,
        SUM(COALESCE(duration_seconds, 0)) AS duration_seconds
      FROM book_files
      WHERE deleted_at IS NULL AND status = 'available'
      GROUP BY book_id
    ),
    book_totals AS (
      SELECT
        books.id,
        COALESCE(book_metadata.duration_seconds, file_totals.duration_seconds, 0) AS duration_seconds
      FROM books
      JOIN libraries ON libraries.id = books.library_id AND libraries.type = 'audiobook'
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN file_totals ON file_totals.book_id = books.id
      WHERE books.deleted_at IS NULL
    )
    SELECT
      MIN(authors.name) AS name,
      COUNT(DISTINCT book_totals.id) AS book_count,
      COALESCE(SUM(book_totals.duration_seconds), 0) AS total_duration_seconds
    FROM book_authors
    JOIN authors ON authors.id = book_authors.author_id
    JOIN book_totals ON book_totals.id = book_authors.book_id
    WHERE book_authors.role = ?
    GROUP BY lower(authors.name)
    ORDER BY book_count DESC, total_duration_seconds DESC, name COLLATE NOCASE
    LIMIT 10
  `).all(role) as PersonStatsRow[];

  const longestBooks = db.prepare(`
    WITH file_totals AS (
      SELECT
        book_id,
        SUM(COALESCE(size, 0)) AS size_bytes,
        SUM(COALESCE(duration_seconds, 0)) AS duration_seconds
      FROM book_files
      WHERE deleted_at IS NULL AND status = 'available'
      GROUP BY book_id
    ),
    book_totals AS (
      SELECT
        books.id,
        books.library_id,
        COALESCE(NULLIF(book_metadata.title, ''), books.folder_path) AS title,
        COALESCE(book_metadata.duration_seconds, file_totals.duration_seconds, 0) AS duration_seconds,
        COALESCE(file_totals.size_bytes, 0) AS size_bytes
      FROM books
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN file_totals ON file_totals.book_id = books.id
      WHERE books.deleted_at IS NULL
    )
    SELECT
      book_totals.id,
      book_totals.title,
      libraries.name AS library_name,
      COALESCE((
        SELECT GROUP_CONCAT(name, ', ')
        FROM (
          SELECT authors.name
          FROM book_authors
          JOIN authors ON authors.id = book_authors.author_id
          WHERE book_authors.book_id = book_totals.id AND book_authors.role = 'author'
          ORDER BY book_authors.sort_order, authors.name COLLATE NOCASE
        )
      ), '') AS author_names,
      book_totals.size_bytes AS total_size_bytes,
      book_totals.duration_seconds AS total_duration_seconds
    FROM book_totals
    JOIN libraries ON libraries.id = book_totals.library_id AND libraries.type = 'audiobook'
    ORDER BY total_duration_seconds DESC, total_size_bytes DESC, title COLLATE NOCASE
    LIMIT 10
  `).all() as LongestBookRow[];

  const totalSizeBytes = libraries.reduce((sum, library) => sum + library.total_size_bytes, 0);
  const totalDurationSeconds = libraries.reduce((sum, library) => sum + library.total_duration_seconds, 0);
  const totalBooks = libraries.reduce((sum, library) => sum + library.book_count, 0);

  return {
    totalLibraries: libraries.length,
    totalBooks,
    totalSizeBytes,
    totalDurationSeconds,
    libraries: libraries.map((library) => ({
      id: library.id,
      name: library.name,
      bookCount: library.book_count,
      totalSizeBytes: library.total_size_bytes,
      totalDurationSeconds: library.total_duration_seconds
    })),
    topAuthors: peopleByRole("author").map((author) => ({
      name: author.name,
      bookCount: author.book_count,
      totalDurationSeconds: author.total_duration_seconds
    })),
    topNarrators: peopleByRole("narrator").map((narrator) => ({
      name: narrator.name,
      bookCount: narrator.book_count,
      totalDurationSeconds: narrator.total_duration_seconds
    })),
    longestBooks: longestBooks.map((book) => ({
      id: book.id,
      title: book.title,
      libraryName: book.library_name,
      authors: book.author_names ? book.author_names.split(", ").filter(Boolean) : [],
      totalSizeBytes: book.total_size_bytes,
      totalDurationSeconds: book.total_duration_seconds
    }))
  };
}

export async function statusPlugin(app: FastifyInstance) {
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
    const libraryStats = audiobookLibraryStats();

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
        libraryStats,
        uptimeSeconds: Math.floor(process.uptime()),
        generatedAt: new Date().toISOString()
      }
    };
  });

  app.get("/api/jobs", { preHandler: app.requireAdmin }, async () => {
    const rows = db.prepare(`
      SELECT
        jobs.id,
        jobs.type,
        jobs.status,
        jobs.attempts,
        jobs.created_at,
        jobs.completed_at,
        jobs.failed_at,
        jobs.error,
        jobs.payload,
        libraries.name AS library_name
      FROM jobs
      LEFT JOIN libraries ON libraries.id = json_extract(jobs.payload, '$.libraryId')
      ORDER BY jobs.created_at DESC
      LIMIT 50
    `).all() as {
      id: string;
      type: string;
      status: string;
      attempts: number;
      created_at: string;
      completed_at: string | null;
      failed_at: string | null;
      error: string | null;
      payload: string;
      library_name: string | null;
    }[];

    return {
      jobs: rows.map((r) => {
        let result: { discoveredBooks?: number; discoveredFiles?: number; bookErrors?: string[] } | null = null;
        let progress: { booksProcessed: number; booksTotal: number } | null = null;
        try {
          const p = JSON.parse(r.payload) as { result?: typeof result; progress?: typeof progress };
          result = p.result ?? null;
          progress = p.progress ?? null;
        } catch { /* ignore */ }
        return {
          id: r.id,
          type: r.type,
          status: r.status,
          attempts: r.attempts,
          libraryName: r.library_name,
          createdAt: r.created_at,
          completedAt: r.completed_at,
          failedAt: r.failed_at,
          error: r.error,
          result,
          progress
        };
      })
    };
  });

  app.post("/api/jobs/:id/cancel", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const job = db.prepare("SELECT id, status, payload FROM jobs WHERE id = ?").get(id) as { id: string; status: string; payload: string } | undefined;
    if (!job) {
      reply.code(404).send({ error: "Job not found" });
      return;
    }
    if (job.status !== "pending" && job.status !== "running") {
      reply.code(409).send({ error: "Job is not active" });
      return;
    }
    db.prepare(`
      UPDATE jobs
      SET status = 'failed', failed_at = CURRENT_TIMESTAMP, locked_at = NULL, locked_by = NULL, error = 'Cancelled by user'
      WHERE id = ?
    `).run(id);
    try {
      const p = JSON.parse(job.payload) as { libraryId?: string };
      if (p.libraryId) {
        db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND scan_status = 'scanning'")
          .run(p.libraryId);
      }
    } catch { /* ignore */ }
    reply.send({ cancelled: true });
  });

  app.get("/api/db/info", { preHandler: app.requireAdmin }, async () => {
    const dbPath = config.dbPath;
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;

    const statOrNull = (p: string) => {
      try { return fs.statSync(p); } catch { return null; }
    };

    const mainStat = statOrNull(dbPath);
    const walStat = statOrNull(walPath);

    const sizeBytes = mainStat?.size ?? 0;
    const walSizeBytes = walStat?.size ?? 0;
    const lastModified = mainStat?.mtime.toISOString() ?? null;

    return {
      db: {
        path: dbPath,
        directory: path.dirname(dbPath),
        filename: path.basename(dbPath),
        sizeBytes,
        walSizeBytes,
        totalSizeBytes: sizeBytes + walSizeBytes + (statOrNull(shmPath)?.size ?? 0),
        lastModified
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
          version: "0.9.0",
          label: "Collections & themes",
          changes: [
            "New Collections — build your own ordered lists (\"playlists\") of audiobooks. Add a book from its menu, reorder or remove items, and rename or delete a collection from its page. Collections live under the user menu.",
            "Continuous playback — \"Play all\" walks a collection book-by-book, showing the playlist position and an \"Up next\" card, and automatically rolls into the next book when one finishes.",
            "Collections are built on a shared, media-agnostic foundation, so future library types (ebooks, photos, video) and Notes can reuse them without rework.",
            "Theme picker — choose your own light/dark/system look from a dedicated Theme page, and admins can set the default theme for new sign-ins from Control Panel → Config."
          ]
        },
        {
          version: "0.8.12",
          label: "Polished install card",
          changes: [
            "The \"Install the mobile app\" card on the sign-in and profile pages now shows platform-specific guidance with iPhone and Android options and recognizable icons — a one-tap Install on Android/Chrome, or step-by-step \"Add to Home Screen\" instructions on iOS."
          ]
        },
        {
          version: "0.8.11",
          label: "Clearer install prompt",
          changes: [
            "The sign-in and profile pages now always show how to install the mobile app when you're in a browser — a one-tap Install button where the browser supports it, or step-by-step \"Add to Home Screen\" guidance otherwise."
          ]
        },
        {
          version: "0.8.10",
          label: "Cleaner install & offline",
          changes: [
            "Added an Install button on the sign-in and profile pages — one-tap on Android/desktop, with Add-to-Home-Screen steps on iOS.",
            "Save offline and the Downloads screen now appear only in the installed app, where offline storage is reliable; in a browser tab you'll see a prompt to install instead.",
            "Removed the pop-up install banner in favor of the explicit buttons."
          ]
        },
        {
          version: "0.8.9",
          label: "Docs & release notes",
          changes: [
            "Expanded the README with Docker deployment, the HTTPS requirement for the installable app, a Caddy reverse-proxy example, and phone install steps for Android and iOS.",
            "Backfilled this What's New timeline with the 0.8 series — the progressive web app (PWA) and offline work below."
          ]
        },
        {
          version: "0.8.8",
          label: "Mobile layout fixes",
          changes: [
            "The Audiobooks page now fits phone screens — no more sideways scrolling — with a denser, right-sized cover grid."
          ]
        },
        {
          version: "0.8.7",
          label: "Reliable offline launch",
          changes: [
            "Opening the installed app with no connection no longer hangs or gets stuck on a sign-in screen: it opens straight into your library from your last sign-in, and only asks you to sign in again when the server is actually reachable."
          ]
        },
        {
          version: "0.8.6",
          label: "Sign-in QR & show password",
          changes: [
            "The sign-in page shows a QR code of the current address, so you can open the app on another device by scanning it.",
            "Password fields now have a show/hide toggle."
          ]
        },
        {
          version: "0.8.5",
          label: "Lock-screen & car controls",
          changes: [
            "The player reports now-playing info (cover, chapter, author) to your device and wires up the lock-screen, car, and Bluetooth controls — play, pause, skip chapters, and scrubbing."
          ]
        },
        {
          version: "0.8.3",
          label: "Manage downloads",
          changes: [
            "New Downloads screen (account menu → Downloads): see every book saved for offline, a device storage meter, and remove downloads to free space."
          ]
        },
        {
          version: "0.8.2",
          label: "Offline progress sync",
          changes: [
            "Listening positions saved while offline now sync to the server automatically when you reconnect, and resume works offline."
          ]
        },
        {
          version: "0.8.1",
          label: "Offline listening",
          changes: [
            "Save a book for offline from its detail page (Save offline); the player then plays it from on-device storage with no connection, including seeking.",
            "On iPhone, a tip prompts you to add the app to the Home Screen first so downloads aren't cleared by Safari."
          ]
        },
        {
          version: "0.8.0",
          label: "Install to your phone",
          changes: [
            "isputnik.home is now an installable app (PWA): add it to your home screen and it launches full-screen and opens even offline. Requires serving the app over HTTPS."
          ]
        },
        {
          version: "0.7.1",
          label: "Player polish & smarter bulk edit",
          changes: [
            "The audiobook player was reworked: a compact bottom-anchored layout, a book-progress pill, an accent play button, an accent progress bar, and bordered action buttons — and it now sizes nicely on phones.",
            "Bulk edit and the per-book Edit form now share the same Author, Narrator, and Tag pickers — type to choose existing values or add new ones, instead of typing comma-separated text.",
            "Audiobook book tiles on the main page now sit on a transparent card (cover-forward), matching the home dashboard look."
          ]
        },
        {
          version: "0.7.0",
          label: "Redesigned audiobook tiles & bulk editing",
          changes: [
            "Audiobook tiles were redesigned: a cleaner cover (no redundant headphones badge), a listening-progress bar, a finished tick, listening duration and series position, and a denser grid that stays two-up on phones.",
            "Each tile now has quick actions — a favorite heart and a hover Play button — plus a ⋮ menu for Play, Mark finished/unfinished, Download, Share, and (for editors) Edit metadata. These never interfere with opening the book.",
            "New multi-select mode (the Select button): pick books across libraries and overwrite shared metadata — Author, Narrator, Category, Language, Tags, or Description — in one action. Editors can also edit a single book inline from its ⋮ menu.",
            "The Special Libraries feature was removed to keep things simple; section/override data is cleaned up automatically. Existing libraries and books are unaffected."
          ]
        },
        {
          version: "0.6.1",
          label: "Shared navigation & library UI polish",
          changes: [
            "Primary pages now use one shared left navigation with a profile dropdown and bottom-aligned Settings and About links; the control panel also includes a Home link.",
            "Audiobook browsing has a reorganized catalog header, and the home dashboard uses compact book-cover cards that match the audiobook catalog scale.",
            "Book details now expose additional metadata through an expandable More details panel, while Edit Metadata has a larger responsive layout with dedicated Metadata, Series, Cover, and Metadata Lookup tabs.",
            "Admins can create tags manually from Control Panel > Labels > Tags, alongside rename, delete, merge, and remove-unused actions.",
            "Control-panel actions and light-theme primary buttons were made more consistent, with disabled controls using the standard unavailable cursor."
          ]
        },
        {
          version: "0.6.0",
          label: "Audiobook search & paging",
          changes: [
            "The audiobook catalog now searches, filters, sorts, and pages on the server, loading a page at a time (infinite scroll plus a Load more button) instead of fetching every book up front — so large libraries stay fast.",
            "Search matches titles, authors, narrators, and series; filters (authors, narrators, categories, tags, series, language, status, length) and sorting now run against the whole library, not just what's loaded.",
            "The special-library (section) view uses the same paged catalog."
          ]
        },
        {
          version: "0.5.3",
          label: "Internal code cleanup",
          changes: [
            "Maintenance release: split two oversized source files (the audiobook page and the audiobook server routes) into focused modules. No user-facing changes."
          ]
        },
        {
          version: "0.5.2",
          label: "Audiobook browse redesign & testing tools",
          changes: [
            "Audiobook browsing was rebuilt into one full-width, tabbed layout (Books, Authors, Narrators, Series, Collections) with a shared header, replacing the old per-page sidebar navigation.",
            "The special-library (section) view now matches the main library: same header and filter/sort/view controls, with a \"back to all libraries\" link instead of a separate sidebar.",
            "Filter, Sort, and the grid/list toggle now sit together on one row next to the library picker, which is now a dropdown menu styled like the book actions menu.",
            "Author, Narrator, and Series pages use the same back button as book detail and drop the redundant per-page search and profile chrome.",
            "Invite links hardened: only the token hash is stored (the link is shown once when created), and links now use the address you're actually visiting instead of a fixed default.",
            "New admin tool (Control Panel → Maintenance → Backup): \"Load testing data\" loads a generated fake-audiobook database for interface testing, taking a full backup of your current library first."
          ]
        },
        {
          version: "0.5.1",
          label: "Ebook browse page",
          changes: [
            "Dedicated ebook browse page and an ebook-aware book detail view."
          ]
        },
        {
          version: "0.5.0",
          label: "Ebooks (EPUB/PDF)",
          changes: [
            "New ebook library type with an in-app EPUB and PDF reader."
          ]
        },
        {
          version: "0.4.17",
          label: "Backups",
          changes: [
            "New Backup screen (Control Panel → Maintenance → Backup): create an on-demand backup, download, restore, or delete — admin only.",
            "Backups are a zip of the database plus cover art (uploaded and provider-fetched covers can't be regenerated); the database snapshot is taken live with no downtime. Media files and the metadata cache are not included.",
            "Scheduled daily backups with a configurable time, retention limit, and an include-covers toggle.",
            "Restore puts cover art back immediately and stages the database to be applied on the next server restart, after auto-saving the current database first.",
            "Configurable via BACKUP_PATH and BACKUP_RETENTION."
          ]
        },
        {
          version: "0.4.16",
          label: "Listening progress & UX polish",
          changes: [
            "Book cards now show a listened indicator — a checkmark when finished and a progress bar while in progress.",
            "Book detail lists each file's state under Files: completed, playing, or not started (derived from your current position).",
            "Tags moved under the cover on the book page and are now clickable — open a tag to see every book carrying it.",
            "Adding a library is now a step-by-step wizard (Details → Metadata overrides → Source folder) so the form fits the window.",
            "Special-section overrides (Author, Narrator, Tags, etc.) are now correctly optional — leave any blank to keep scanned values.",
            "Wider Edit library dialog and clearer spacing in the section dialog."
          ]
        },
        {
          version: "0.4.15",
          label: "Special sections & control panel",
          changes: [
            "New Labels screen (Categories + Tags tabs). Tag management: rename tags (renaming onto an existing tag merges them), delete a tag from all books, and remove unused tags in one click.",
            "Audiobook catalog stats (libraries, top authors/narrators, longest listens) moved from the Status page to a dedicated Stats tab under Control Panel → Audiobooks; Status now focuses on system and database health.",
            "Audiobook libraries can now be grouped into a Special Section — a master entry in the audiobook sidebar (with its own icon) that holds one or more libraries. Section books are kept out of the main Books grid and browsed behind the section.",
            "Each library added to a section has its own Overwrite-on-add rules: force Author, Narrator, Description, Category, and Tags for every book on add and rescan. Blank fields keep the scanned value (e.g. a blank Author keeps each story's real writer).",
            "Manually edited books still win — overrides apply as scan metadata, so a per-book manual edit survives rescans.",
            "Admins manage sections from Control Panel → Audiobooks: create/edit/delete sections and attach libraries with their override values. Deleting a section detaches its libraries (no books or files are removed).",
            "Control Panel navigation reorganized: a new Digital Library group (Storage, Audiobooks, plus Gallery / Other Media placeholders for future types), a Maintenance screen for Jobs (with a Backup placeholder), and database details folded into the Status page. User administration is now a single Accounts screen with Users / Groups / Invite links / Sessions tabs. The Audiobooks screen splits into Audiobooks, Special libraries, and Stats tabs."
          ]
        },
        {
          version: "0.4.13",
          label: "Category management polish",
          changes: [
            "Category management is now centered on the category list, with mappings managed inside each category editor instead of a separate global tab.",
            "The category editor now has Mappings and Tags tabs. Tags shows scanned genre tags with book counts and lets an admin add a tag as a keyword for the current category.",
            "Added an on-page explanation of category mapping, including a concrete priority example, so admins can understand why a book lands in a category.",
            "New installs now include default category images for the public audiobook category cards, while category management remains icon-first unless an admin uploads a custom image.",
            "Default category mappings for new installs are now English-only. Existing databases keep their current mappings until an admin changes them."
          ]
        },
        {
          version: "0.4.12",
          label: "Categories & tags",
          changes: [
            "Books are now sorted into a fixed set of navigation Categories (Fiction, Classics & Literary, Adventure & Action, Mystery & Thriller, Sci-Fi & Fantasy, Horror & Supernatural, Romance, Humor & Satire, Biographies & Memoirs, History, Self-Help & Business, Science & Culture, Kids & Teens) with a General / Other fallback — replacing the old free-form Genres.",
            "Every original genre is kept as a searchable Tag, shown as chips on the book page; nothing is discarded. Tags are global and ready to be reused by future library types.",
            "During a scan, incoming genre text is matched to a category via keyword mappings; unmatched books fall back to General / Other.",
            "Book editor now has a Category dropdown and a Tags field; a manual choice is preserved across rescans.",
            "New admin Control Panel section for categories: rename/reorder categories, manage keyword-to-category mappings, and Re-match all books from their existing tags instantly — no file rescan needed.",
            "Each category has an icon (admin-pickable) plus an optional uploaded image that overrides it, shown on the category browse cards."
          ]
        },
        {
          version: "0.4.11",
          label: "Status dashboard & book rescan",
          changes: [
            "Status page now has separate System and Libraries & Books sections with prettier metric cards.",
            "Library status now shows total libraries, total books, total audiobook size, total listening hours, and per-library books, size, and hours.",
            "Added Top 10 Authors, Top 10 Narrators, and Top 10 Books by Hour to the status page.",
            "Added a single-book rescan API that supports skip-sidecar and tag-encoding repair options while preserving library write-access checks.",
            "Encoding repair now also fixes mojibake inside metadata.json sidecars, not only audio tags, so rescans can repair titles, descriptions, people, series, genres, and publisher fields."
          ]
        },
        {
          version: "0.4.10",
          label: "Audiobook detail polish",
          changes: [
            "My List now supports removing saved books directly from the My List page.",
            "Book detail pages now keep actions, description, and the files dropdown aligned in the book info column.",
            "Book metadata and descriptions are more compact by default, with show-more controls for the full detail set.",
            "Removed the reset-progress button from book details and the extra top brand icon from the popup player."
          ]
        },
        {
          version: "0.4.9",
          label: "Bookmarks, My List & encoding fix",
          changes: [
            "Bookmarks: save a spot in any audiobook with an optional note, then view, edit, delete, or jump back to it from the player. Bookmarks are now stored on the server (synced across devices) — any older browser-only bookmarks are migrated automatically.",
            "My List: save whole audiobooks to a personal list with an optional note, browsable from the new 'My List' tab in the audiobook sidebar.",
            "Rescan options: the Rescan button now opens a dialog to skip metadata.json sidecars and to fix garbled tag text (mojibake). Choose Windows-1251/1250/1252 or KOI8-R to repair tags like 'Ðàíåå' → 'Ранее'; correctly stored and manually edited metadata is left untouched.",
            "Player redesign: refreshed popup with Speed, My List, Bookmarks, Add Note, and Mark as Finished in one row and a full-width Chapters bar below, plus a volume slider, two-line chapter heading, brand header, and quick Download / Reset progress.",
          ]
        },
        {
          version: "0.4.8",
          label: "Security hardening",
          changes: [
            "Cover-art downloads can no longer reach internal or private network addresses (SSRF protection), follow redirects, or exceed their size cap — the limit is now enforced while streaming rather than trusting the response headers.",
            "Hardened a library access lookup against SQL injection and applied the same path-traversal safety check to book downloads that the streaming endpoint already used.",
          ]
        },
        {
          version: "0.4.7",
          label: "Popup player & sidecar improvements",
          changes: [
            "Audiobook player now opens in a dedicated popup window (Audible-style) at /player/:id — stays alive while browsing the main app.",
            "Player popup features large cover art, chapter title, Audible-style minimal controls (outlined skip circles, large dark play button), and a bottom-sheet chapter list that slides up full-screen.",
            "Add a Bookmark button saves the current position to localStorage for later reference.",
            "Mark as Finished available via the ⋯ menu in the player popup.",
            "Thumbnails are now organized by library ID on disk — deleting a library cleans up its covers with a single folder removal. Author photos live under a shared 'people/' bucket.",
            "Sidecar metadata: series strings in 'Name #N' format are now parsed into separate series name and position fields (e.g. 'Читер #2' → series: Читер, position: 2).",
          ]
        },
        {
          version: "0.4.6",
          label: "Scan performance & reliability",
          changes: [
            "Scan is now 5–10× faster: audio files within each book are parsed in parallel, SHA-256 hashing removed (size + mtime fingerprint is sufficient), and up to 4 books are processed concurrently.",
            "Async directory walk no longer blocks the HTTP server during large library scans.",
            "Each book is written to the database as soon as it finishes — partial progress is preserved if the scan is cancelled or the server restarts.",
            "Jobs page now shows live scan progress (X / Y books) while a scan is running.",
            "Fixed: cancelling a job now immediately sets the library status to error; the cancelled scan no longer gets rescheduled for retry.",
            "Fixed: certain M4B files caused music-metadata to hang indefinitely due to a chapter-parsing bug. Chapter parsing removed (unused); 15-second parse timeout added as a safety net.",
            "Fixed: folder cover images are now found even when the filename is not a standard name like cover.jpg — the scanner falls back to the largest image file in the folder.",
            "Fixed: cover images in the Edit Metadata cover browser showed as broken links due to a Fastify async streaming issue. Fixed by reading image files into a buffer before sending.",
            "New library setting: Do not read metadata.json — when enabled at library creation time, sidecar metadata files are ignored during all scans.",
            "Book detail page now shows the folder path of the book on disk.",
          ]
        },
        {
          version: "0.4.5",
          label: "Unraid scanner hardening",
          changes: [
            "Fixed audiobook scans failing on Unraid when sidecar metadata provided series values as objects instead of plain strings.",
            "Sidecar metadata normalization now safely supports object-style series names and sequence numbers before writing to SQLite.",
          ]
        },
        {
          version: "0.4.4",
          label: "Linux scan fixes",
          changes: [
            "Fixed crash on Linux/Unraid: replaced ON CONFLICT(cols) DO NOTHING with INSERT OR IGNORE throughout — certain SQLite builds on Linux miscounted binding parameters in the ON CONFLICT clause.",
          ]
        },
        {
          version: "0.4.3",
          label: "Scan reliability & job controls",
          changes: [
            "Fixed scanner crash on Linux (Unraid) caused by audio tag fields returning non-string values — now handled safely throughout.",
            "Scanner no longer aborts on a single bad book — each book is processed independently, errors are collected and reported.",
            "Job cancellation: active jobs can now be cancelled from the Jobs page.",
            "Jobs page now shows scan results (books and files discovered, skipped count) and full error details on click.",
            "Running jobs that exceed 10 minutes show a pulsing warning badge.",
            "Job errors now include the full stack trace for easier diagnosis.",
          ]
        },
        {
          version: "0.4.2",
          label: "Jobs, Database & library management",
          changes: [
            "Added Jobs page in the control panel showing the last 50 background jobs with status, duration, and error details. Auto-refreshes while jobs are active.",
            "Added Database page showing the SQLite file path, size, WAL size, and last modified time for backup reference.",
            "Added Delete library button with a confirmation modal — removes all database records without touching files on disk.",
            "Rescan button is now disabled and shows 'Scanning…' while a library scan is already in progress.",
          ]
        },
        {
          version: "0.4.1",
          label: "Logo update",
          changes: [
            "Updated application logo and brand assets.",
          ]
        },
        {
          version: "0.4.0",
          label: "Series, Genres & Groups",
          changes: [
            "Added Series list and detail pages — browse, create, rename, delete series, and manage which books belong to each.",
            "Added Genres list and detail pages — browse, create, rename, delete genres, and manually assign books to genres.",
            "Added user groups — admins can create groups, add members with member or manager roles, and assign libraries to groups.",
            "Library sharing: libraries can now be owned by a group, giving all group members access.",
            "Library access control extracted into shared module — consistent read/write permission checks across all library endpoints.",
            "Audiobook list page now supports filtering by library, author, and narrator.",
          ]
        },
        {
          version: "0.3.0",
          label: "Library navigation & people",
          changes: [
            "Redesigned navigation: section links moved to the top bar, left sidebar is now contextual per section.",
            "Added Authors and Narrators pages under Audiobooks with name search and book counts.",
            "Added person detail page showing all books by that author or narrator.",
            "Added person profile editing: name, sort name, biography, and photo upload.",
            "Added library, author, and narrator filter dropdowns to the audiobooks page.",
            "App logo now links home; Home button removed from navigation.",
            "Top navigation bar now shown on all pages including the control panel.",
            "Removed About from the control panel sidebar — accessible from the top menu.",
            "Docker template now supports one required media path plus two optional additional paths.",
          ]
        },
        {
          version: "0.2.3",
          label: "Docker & self-hosting",
          changes: [
            "Added Docker support with multi-stage build and GitHub Container Registry publishing.",
            "Added Unraid Docker template with /config volume convention for appdata.",
            "Fixed session cookies not persisting over plain HTTP on local networks.",
            "Fixed invite links using server URL from the request instead of configuration.",
          ]
        },
        {
          version: "0.2.0",
          label: "Audiobook player UX",
          changes: [
            "Added skip ±30 s buttons with automatic cross-chapter wrap-around.",
            "Added overall book progress bar showing position across all chapters.",
            "Added toggleable chapter list panel with click-to-jump navigation.",
            "Progress is now saved on browser/tab close via fetch keepalive.",
            "Added audiobook library with folder scanning, metadata editing, and cover art.",
            "Added metadata lookup via iTunes, OpenLibrary, and FantLab providers.",
            "Added byte-range streaming endpoint with seek support."
          ]
        },
        {
          version: "0.1.0",
          label: "Initial release",
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
