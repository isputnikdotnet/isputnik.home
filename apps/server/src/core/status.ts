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
        item_id,
        SUM(COALESCE(size, 0)) AS size_bytes,
        SUM(COALESCE(duration_seconds, 0)) AS duration_seconds
      FROM audio_files
      WHERE deleted_at IS NULL AND status = 'available'
      GROUP BY item_id
    ),
    book_totals AS (
      SELECT
        library_items.id,
        library_items.library_id,
        COALESCE(audiobook_details.duration_seconds, file_totals.duration_seconds, 0) AS duration_seconds,
        COALESCE(file_totals.size_bytes, 0) AS size_bytes
      FROM library_items
      LEFT JOIN audiobook_details ON audiobook_details.item_id = library_items.id
      LEFT JOIN file_totals ON file_totals.item_id = library_items.id
      WHERE library_items.deleted_at IS NULL
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
        item_id,
        SUM(COALESCE(duration_seconds, 0)) AS duration_seconds
      FROM audio_files
      WHERE deleted_at IS NULL AND status = 'available'
      GROUP BY item_id
    ),
    book_totals AS (
      SELECT
        library_items.id,
        COALESCE(audiobook_details.duration_seconds, file_totals.duration_seconds, 0) AS duration_seconds
      FROM library_items
      JOIN libraries ON libraries.id = library_items.library_id AND libraries.type = 'audiobook'
      LEFT JOIN audiobook_details ON audiobook_details.item_id = library_items.id
      LEFT JOIN file_totals ON file_totals.item_id = library_items.id
      WHERE library_items.deleted_at IS NULL
    )
    SELECT
      MIN(people.name) AS name,
      COUNT(DISTINCT book_totals.id) AS book_count,
      COALESCE(SUM(book_totals.duration_seconds), 0) AS total_duration_seconds
    FROM item_people
    JOIN people ON people.id = item_people.person_id
    JOIN book_totals ON book_totals.id = item_people.item_id
    WHERE item_people.role = ?
    GROUP BY lower(people.name)
    ORDER BY book_count DESC, total_duration_seconds DESC, name COLLATE NOCASE
    LIMIT 10
  `).all(role) as PersonStatsRow[];

  const longestBooks = db.prepare(`
    WITH file_totals AS (
      SELECT
        item_id,
        SUM(COALESCE(size, 0)) AS size_bytes,
        SUM(COALESCE(duration_seconds, 0)) AS duration_seconds
      FROM audio_files
      WHERE deleted_at IS NULL AND status = 'available'
      GROUP BY item_id
    ),
    book_totals AS (
      SELECT
        library_items.id,
        library_items.library_id,
        COALESCE(NULLIF(item_metadata.title, ''), library_items.folder_path) AS title,
        COALESCE(audiobook_details.duration_seconds, file_totals.duration_seconds, 0) AS duration_seconds,
        COALESCE(file_totals.size_bytes, 0) AS size_bytes
      FROM library_items
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      LEFT JOIN audiobook_details ON audiobook_details.item_id = library_items.id
      LEFT JOIN file_totals ON file_totals.item_id = library_items.id
      WHERE library_items.deleted_at IS NULL
    )
    SELECT
      book_totals.id,
      book_totals.title,
      libraries.name AS library_name,
      COALESCE((
        SELECT GROUP_CONCAT(name, ', ')
        FROM (
          SELECT people.name
          FROM item_people
          JOIN people ON people.id = item_people.person_id
          WHERE item_people.item_id = book_totals.id AND item_people.role = 'author'
          ORDER BY item_people.sort_order, people.name COLLATE NOCASE
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
      WHERE revoked_at IS NULL AND datetime(expires_at) > datetime('now')
    `).get() as { count: number };
    const activeInvites = db.prepare(`
      SELECT COUNT(*) AS count FROM invites
      WHERE revoked_at IS NULL AND used_at IS NULL AND datetime(expires_at) > datetime('now')
    `).get() as { count: number };
    const events = db.prepare("SELECT COUNT(*) AS count FROM activity_logs").get() as { count: number };
    const audiobookLibraries = db.prepare("SELECT COUNT(*) AS count FROM libraries WHERE type = 'audiobook'").get() as { count: number };
    const audiobookBooks = db.prepare("SELECT COUNT(*) AS count FROM library_items WHERE deleted_at IS NULL").get() as { count: number };
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
      SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = 'Cancelled by user'
      WHERE id = ?
    `).run(id);
    try {
      const p = JSON.parse(job.payload) as { libraryId?: string };
      if (p.libraryId) {
        db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND scan_status = 'scanning'")
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
          version: "1.3.3",
          label: "Refreshed navigation & consistent tabbed layouts",
          changes: [
            "Your library and account pages now use a left-hand menu — the same style the Control panel uses. Profile, Favorites, Bookmarks, Collections, Shared with me, and Downloads are grouped under \"Account\" and \"My Library\" in the sidebar, replacing the old row of tabs across the top of the page.",
            "Polish: the Profile, Config, and Security pages now share one tabbed layout. Each has a heading with an icon and a short description, and every tab carries its own icon. Nothing moved — the same settings are in the same places — it's just easier to scan and visually consistent across the app."
          ]
        },
        {
          version: "1.3.2",
          label: "Admin sign-in unlock & clearer auth logs",
          changes: [
            "New (admin): unlock a locked account without waiting. After too many failed sign-ins an account is temporarily locked; Control panel → User management now shows a red \"Locked\" badge on that account with an Unlock button, so you can clear the lockout and let the person try again right away instead of waiting it out.",
            "The activity log now records which email address a failed or refused sign-in was for, so you can tell which account someone was trying to reach — useful for spotting who's locked out or being targeted."
          ]
        },
        {
          version: "1.3.1",
          label: "Fix: container could fail to start (two-factor dependency)",
          changes: [
            "Fixed a packaging bug in the 1.3.0 container image: a two-factor sign-in dependency (otplib) was missing from the published image, so the app could crash on startup with a \"Cannot find package 'otplib'\" error before it finished loading. The image now bundles it. If you ran into this, just update to 1.3.1 — there's nothing to configure and no data is affected."
          ]
        },
        {
          version: "1.3.0",
          label: "Security: two-factor sign-in & internet-ready hardening",
          changes: [
            "New: two-factor authentication (2FA). Add a one-time code from an authenticator app (Google Authenticator, Authy, Apple Passwords, 1Password…) to your sign-in, so a stolen password alone can't reach your account. Turn it on under Profile → Two-factor authentication: scan the QR code, enter a code to confirm, then save the backup codes it shows (each works once if you ever lose your phone). You can regenerate the codes or turn it off at any time. Locked out with no phone and no backup codes? An admin can reset it for you from Control panel → Users.",
            "New: a Security page in the control panel (admin) that gathers the new protections in one place. Accounts now lock for a while after several failed sign-ins, and an IP address that keeps failing is blocked automatically — the thresholds (how many tries, how long) are adjustable there. You can also block or unblock specific IPs by hand, mark trusted home-network ranges that skip the extra checks, and set a password policy (minimum length, and optionally requiring a mix of letters, numbers and symbols) that applies whenever a password is set.",
            "New: suspicious-activity email alerts. When email is set up, admins are notified about things worth a look — an account getting locked, an IP being auto-blocked, a new administrator account, or two-factor being turned off. (Configure email under Control panel → Config → Email.)",
            "Hardening so the library can be opened to the internet safely: enforced browser security headers (Content-Security-Policy and friends), CSRF protection on every change you make, sign-in rate limiting, and a TRUST_PROXY_HOPS setting so the per-IP protections see the real visitor when you run behind a reverse proxy. A new guide — docs/users/exposing-to-the-internet.md — walks through doing it properly (HTTPS, secure cookies, proxy setup), and a bundled dependency carrying security advisories was updated.",
            "Everything here is optional and off by default, so a home-network install is unchanged until you choose to turn it on."
          ]
        },
        {
          version: "1.2.15",
          label: "Send to e-reader, sleep timer & email change",
          changes: [
            "New: send any ebook to your Kindle or Kobo by email. Open an EPUB or PDF book's page and choose Send to e-reader, and it arrives on your device. Setup is two steps: an admin fills in the server's email (SMTP) details under Control panel → Config → Email and sends a test, and each person adds their own e-reader address — for example you@kindle.com — under Profile → Send to e-reader. For Kindle, also add the server's sender address to Amazon's approved-senders list. EPUB and PDF can be sent.",
            "New: a sleep timer in the audiobook player. Tap the moon button next to the speed control and pick 15, 30, 45 or 60 minutes, or End of chapter — playback pauses when the time is up, the button shows a live countdown, and the timer pauses whenever you pause.",
            "You can now change the email address you sign in with. Under Profile → Email, choose Change email and confirm with your current password; your other devices stay signed in."
          ]
        },
        {
          version: "1.2.14",
          label: "Custom scan rules",
          changes: [
            "New: custom scan rules for ebook libraries. When a folder is organised its own way — say Author / Series / \"01. Title\" — you can teach the scanner that exact shape instead of living with the default grouping. Open Control panel → the ebook library → Scan rules, give the rule a name, browse to the folder(s) it should cover, then describe the layout with a pattern made of {author}, {series}, {position} and {title} tokens (there are ready-made presets and a click-to-insert palette). A Preview button dry-runs the pattern over the real files so you can see how each book will be read before you save. Rules apply on the next rescan.",
            "The rule editor is split into two clear tabs — \"Name & folders\" and \"Rule\". A Browse-folders button opens a picker rooted at the library, and the folders you choose appear as a grid below, each removable with one click.",
            "Matching copes with how files are really named: \"1. Title\" and \"1.Title\" (no space after the number) are both understood, while genuine decimals like \"2.5\" stay intact. If a folder nests an extra level — for example a \"universe\" folder holding several sub-series — add a second rule on that deeper folder and use the {ignore} token to skip the wrapping level."
          ]
        },
        {
          version: "1.2.13",
          label: "Ebook metadata, bulk edit & FantLab",
          changes: [
            "FB2 ebooks now have their author, title, year, genres (as tags), description and cover read from the file during scanning — previously only EPUBs were read, so FB2-only libraries showed bare filenames with no author or tags to filter by. Books saved in the older windows-1251 Russian encoding are decoded correctly too. Heads up: existing FB2 books won't gain this until you rescan that ebook library (Control panel → the library → Rescan); newly added FB2 files are read automatically.",
            "Edit several ebooks at once: on the Ebooks page choose Select, tick the books, then \"Edit metadata\" to overwrite author, category, language, tags or description across all of them — the same bulk editor audiobooks already had. The editor is a little wider now and keeps Tags on their own tab.",
            "Fixed Metadata Lookup for FantLab: search returns results again, titles that start with a number like \"1. …\" now match, and you can paste either a work link (fantlab.ru/work…) or an edition link (fantlab.ru/edition…).",
            "Filter panels show a search box as soon as a list has more than one option, so authors, tags and categories are quick to find in the Ebooks filters too — not just the long audiobook lists.",
            "Smaller touches: new libraries default to no owner (a \"system\" library) rather than being owned by you, and the Upload, Select, Filter and Sort controls at the top of the Audiobooks and Ebooks pages are now compact icons."
          ]
        },
        {
          version: "1.2.12",
          label: "Read FB2 ebooks",
          changes: [
            "FB2 ebooks now open in the in-app reader, the same as EPUB — with the table of contents, search, bookmarks, themes, and reading-position sync all working the same way. Until now an FB2 book could only be downloaded. PDFs still open in their own viewer.",
            "FB2 books can also be saved for offline reading on a phone or tablet, just like EPUB."
          ]
        },
        {
          version: "1.2.11",
          label: "Book editions & multi-format ebooks",
          changes: [
            "Group different versions of the same book as editions. On the Audiobooks or Ebooks page choose Select, tick the books that belong together, and use \"Group as editions\", naming the one that should lead. The library then shows the group as a single cover — with a small editions badge — instead of several look-alike duplicates, and the book's page gains an Editions switcher to flip between them. Each edition keeps its own details (a different translation, publisher, year, or narrator) and its own reading or listening position.",
            "An edition group can mix an audiobook and an ebook of the same title, so one book can offer both Listen and Read. From the book's page you can change which edition leads, or remove one from the group — removing the last pair ungroups them.",
            "Ebooks that come in several file formats — say EPUB, PDF, and FB2 of the same book — are now one book with multiple formats rather than separate entries. New ebook libraries now scan EPUB, PDF, FB2, MOBI, AZW3, TXT and RTF; the scanner groups files that share a name in one folder, the book's page lists every format under Files, and Read opens the best one for in-app reading (EPUB, then PDF) while the rest are there to download. Reader apps over OPDS now get one entry per book offering every format.",
            "Heads up for ebook libraries you already have: existing ebooks keep working untouched. To merge format-duplicates you already catalogued, rescan the ebook library once — that re-catalogs it fresh, so its reading positions, favourites, and bookmarks reset (your files on disk are never touched). Newly added ebooks group their formats automatically."
          ]
        },
        {
          version: "1.2.10",
          label: "One Authors page for everything",
          changes: [
            "Authors now live on a single page that spans your whole library, with an All / Audiobooks / Ebooks filter — just like categories. The separate per-section author lists are gone; Authors is in the main menu now (and the shortcuts inside Audiobooks and Ebooks still take you there).",
            "Clicking an author or narrator anywhere — including on a book's page — opens their unified page showing everything they made across audiobooks and ebooks."
          ]
        },
        {
          version: "1.2.9",
          label: "Unified author pages",
          changes: [
            "Authors and narrators now have one combined page that brings together everything they made across your library — their audiobooks and ebooks side by side, grouped by role (author, narrator). Before, the same person showed up as separate entries under audiobooks and ebooks.",
            "You can still browse Authors and Narrators from each section as before; every link now opens this unified person page, and your existing author links and bookmarks keep working."
          ]
        },
        {
          version: "1.2.8",
          label: "Smarter audiobook folder scanning",
          changes: [
            "With \"Treat folder as book\" turned on, a folder named like \"Author - Title [Narrator]\" is now read for its author, title, and narrator — so books organised that way get the right people even without embedded tags or an online lookup.",
            "Cover art is now picked up from TIFF (.tif) images and from a sidecar art folder (Covers/, Artwork/, …) next to the book, not just JPEG/PNG inside the book folder — handy for CD rips that keep scans separate."
          ]
        },
        {
          version: "1.2.7",
          label: "Ebook sharing",
          changes: [
            "You can now share ebooks just like audiobooks — create a guest link anyone can open without an account, or share a book directly with another person's account.",
            "Opening a shared ebook link shows the cover and title with Read and Download buttons: Read opens the book right in the browser (the reader for EPUBs, the built-in viewer for PDFs), no app or sign-in needed.",
            "Ebooks shared directly with your account now appear under \"Shared with me\" alongside shared audiobooks and open in the reader with your own reading position."
          ]
        },
        {
          version: "1.2.6",
          label: "Reader & offline screen redesign",
          changes: [
            "The ebook reader has a cleaner menu on phones and the installed app: a back button up top alongside quick Search, text size (Aa), theme, bookmark, and settings controls, plus a slim bottom bar showing chapters, a progress slider, and the current page.",
            "The reader's settings now carry the full set of options — theme, font, text size, line spacing, and page direction — and the desktop reader uses the same layout with the book cover and title centred.",
            "The Offline screen now lists downloaded books in the same one-book-per-row layout as the home screen, grouped under Audiobooks and Ebooks headings, each row with a one-tap delete button to free up space."
          ]
        },
        {
          version: "1.2.5",
          label: "Default covers, reader access & library fixes",
          changes: [
            "Audiobooks and ebooks without their own artwork now show a clean default cover — a blue headphones card for audiobooks and an orange book card for ebooks — across the library grids, book pages, the player, and the home screen.",
            "Reader access (OPDS) has moved from your Profile to Control Panel → Config, so reader tokens are now managed by an administrator in one place.",
            "A user or group can now own more than one library.",
            "Audiobook player: multi-file books now show the position as a track number instead of a chapter number (books with real embedded chapters still show chapters).",
            "Scanning a library whose source folder is missing or unreadable now stops right away with a clear error, instead of appearing to scan indefinitely."
          ]
        },
        {
          version: "1.2.4",
          label: "Library setup wizard refresh",
          changes: [
            "The Add library wizard now has a cleaner three-step flow: choose the library type, enter the core details, then review the settings before scanning.",
            "Advanced library setup now opens inside the parent wizard as a bottom-up overlay with Access, Upload, and Scanning tabs, plus Save and Cancel actions.",
            "The Details step is more focused: folder selection, owner, and public/private visibility are directly on the page, while advanced scan/upload options stay tucked away until needed."
          ]
        },
        {
          version: "1.2.3",
          label: "Mobile library & offline polish",
          changes: [
            "Audiobooks and Ebooks on phones / the installed app now use the same clean one-book-per-row layout as the home screen — cover, progress, run time or format, a play/read button, and a three-dot menu with the full library actions (favourite, mark played/read, add to collection, download, edit, delete).",
            "The mobile library header is now a compact icon row (search, filter, sort, upload) with a Browse menu for authors, narrators and series.",
            "Offline reliability: downloaded ebooks open in the reader while offline, covers are saved for offline viewing, and a progress bar shows while a download is still running."
          ]
        },
        {
          version: "1.2.2",
          label: "Faster offline detection",
          changes: [
            "The online/offline indicator now updates promptly when the server becomes unreachable, instead of waiting on the browser's slower built-in network check."
          ]
        },
        {
          version: "1.2.1",
          label: "Mobile home & app navigation",
          changes: [
            "The home screen on phones and the installed app was rebuilt: in-progress and recently-added books now appear as a clean one-book-per-row list with cover, progress bar, run time, and a play or read button.",
            "New four-tab bottom navigation — Home, Media, Offline, Profile — with a Media menu to switch between Audiobooks and Ebooks.",
            "Save a book for offline straight from the home list, open ebooks in the reader or audiobooks in the player with one tap, and see an online/offline indicator in the header."
          ]
        },
        {
          version: "1.2.0",
          label: "Profile, theme & bookmarks refresh",
          changes: [
            "Your account settings now live in one place: change your password and pick your theme right on the Profile page. Changing your password signs your other devices out automatically.",
            "Bookmarks were redesigned around the books they belong to. Bookmarks are grouped under each book (collapsed by default, with an audio or ebook badge), and every saved spot shows its chapter, position, and your note in a compact row — with a Read or Play button to jump straight back in, next to remove.",
            "The Favorites, Downloads, and Shared-with-me tiles now show a clear remove button.",
            "Tidied the Control Panel: the Gallery and Other Media placeholders are gone. New library types are added through the library wizard and managed under Libraries."
          ]
        },
        {
          version: "1.1.0",
          label: "Read on any device (OPDS)",
          changes: [
            "Your ebook library is now available over OPDS — the open catalog standard that reader apps speak — so you can browse and download your books in apps like KOReader, Moon+ Reader, Librera, and Thorium, including on e-ink devices such as Kobo and Kindle that the in-app reader can't reach.",
            "Set it up under Profile → Reader access (OPDS): create a token for each device, then paste its catalog link into the reader, or scan the QR code on a phone. If your reader asks for a username and password instead, the same token works as the HTTP Basic password.",
            "Each token is read-only and only ever sees the libraries you can already access — it is never your account password, and you can remove a device's token at any time without affecting your other devices.",
            "Browse the catalog by recently added, all books, author, category, or language, search the whole library, and download a book straight into your reader."
          ]
        },
        {
          version: "1.0.1",
          label: "Security hardening",
          changes: [
            "Rate limits applied to the two public invite endpoints (the link preview and the account-creation form) to prevent scripted abuse."
          ]
        },
        {
          version: "1.0.0",
          label: "Rebuilt library foundation",
          changes: [
            "Heads up before you update: this release rebuilds the library database on a new, cleaner foundation, and it does not carry the old data across. After updating, your libraries will look empty — open each one and run a scan to re-catalogue it from your files. Your audiobooks and ebooks on disk are never touched, so a scan brings everything straight back. Listening and reading progress, bookmarks, collections, favourites, and shares start fresh.",
            "Audiobooks, ebooks, and future media types now share one common foundation. Every library type gets the same categories, tags, collections, favourites, sharing, and search, and new types can be added later without disturbing what's already there.",
            "Authors and narrators are now shared across the whole app, so the same person's photo and biography show up everywhere they're credited — not just inside one library.",
            "A lot of behind-the-scenes tidying for reliability and consistency: one uniform way of recording dates and times across the app, and a cleaner data model that's faster to build on going forward."
          ]
        },
        {
          version: "0.31.0",
          label: "New EPUB reader",
          changes: [
            "The EPUB reader has been rebuilt from the ground up on a modern rendering engine. Chapter navigation that used to fail or jump to the wrong place on some books now works everywhere — the table of contents, the current-chapter title, and the reading progress all track the book reliably.",
            "A cleaner, immersive reading view: a centered page with adjustable text size and font (serif or sans), line spacing, and light, sepia, or dark themes. Switch between one-page, two-page, and continuous-scroll layouts, jump anywhere with the progress slider, and see an estimated time remaining.",
            "Full-text search across the whole book, plus bookmarks you can add, note, and jump back to.",
            "Open a book straight into the reader from its tile on the Ebooks page, and mark an ebook as read or unread from both the tile and the book's detail page — mirroring how audiobooks work."
          ]
        },
        {
          version: "0.27.0",
          label: "Home dashboard: Continue & Recently added",
          changes: [
            "The home page now opens on your real library instead of placeholder tiles. A \"Continue listening & reading\" row gathers the audiobooks and ebooks you're partway through — most recently played or read first — and a \"Recently added\" row shows the newest titles, both spanning audiobooks and ebooks together.",
            "A slim overview strip across the top links straight to your Audiobooks, Ebooks, in-progress books, and Favorites, each with a live count.",
            "Each row's \"View all\" opens a full cross-library page — Recently added or Continue — that lists the latest items across the whole digital library, using the same cover tiles as the Audiobooks page."
          ]
        },
        {
          version: "0.26.0",
          label: "Audible metadata provider",
          changes: [
            "Audible is now a metadata source in a book's Metadata Lookup — search it directly or as part of \"All providers\", or paste an Audible link. It's the richest source for audiobooks and the most reliable for the narrator, the Audible ASIN, and high-resolution cover art.",
            "Audible results work everywhere a provider result does: the current-vs-result comparison, applying details, and the Cover tab's online cover search."
          ]
        },
        {
          version: "0.25.0",
          label: "Lookup compare, paste-a-link & manual people",
          changes: [
            "Metadata Lookup can now expand any search result into a side-by-side comparison with the current book, so you can see exactly which fields — title, authors, narrators, year, description, cover and more — a result would change before you apply it.",
            "Paste a book link from Open Library, Apple Books, FantLab, or LibriVox to pull metadata straight from that specific page instead of searching.",
            "The Cover tab can search those same sources for cover art and apply just the cover, leaving the rest of the book's metadata untouched.",
            "Author and narrator profiles get the same treatment: \"Find online\" now previews a current-vs-found comparison of the biography and photo (paste a Wikipedia or Open Library author link to target a specific page), and a new \"New author\" / \"New narrator\" button lets you add a person by hand."
          ]
        },
        {
          version: "0.24.1",
          label: "m4b scan fix & chapters tab",
          changes: [
            "Fixed a scan that could hang on some m4b audiobooks while reading their embedded chapters.",
            "The book details page gained a Chapters tab that lists a book's embedded chapters."
          ]
        },
        {
          version: "0.24.0",
          label: "m4b chapter reading & navigation",
          changes: [
            "Embedded chapters inside m4b (and MP3) audiobooks are now read during the scan, so a single-file book shows its real chapter list instead of one long track.",
            "The player and the book page let you jump between those chapters and show where you are within them."
          ]
        },
        {
          version: "0.23.0",
          label: "Recycle bin & restore",
          changes: [
            "Deleting a catalogued audiobook or ebook is now a soft delete: its files move into a hidden per-library .trash folder and the item leaves the catalog, but it can be restored until you remove it for good.",
            "A new Recycle Bin in the Control Panel lets you restore items, delete them permanently, or empty the bin, and deleted items auto-purge after 30 days (configurable).",
            "Per-item delete now works for ebooks too, from the book detail page."
          ]
        },
        {
          version: "0.22.0",
          label: "Online metadata lookup, LibriVox & author photos",
          changes: [
            "A new optional \"Online lookup\" scan source fills in missing narrator, description, cover, year, and genres from LibriVox (with an Open Library fallback) while scanning, and fetches author and narrator photos and bios from Wikipedia and Open Library.",
            "LibriVox joined the manual metadata search, and person profiles gained a \"Find online\" button with a photo candidate picker.",
            "Authors and narrators now show their photos and biographies on their list and detail pages."
          ]
        },
        {
          version: "0.21.0",
          label: "Folder upload & companion files",
          changes: [
            "You can now upload a whole book folder (file picker or drag-and-drop): subfolders flatten into ordered track names, the folder name becomes the book title, and unrelated files are skipped just like a scan.",
            "Companion files (covers, metadata sidecars, documents) are now a per-library setting you can edit in the create wizard and edit dialog; uploads accept your scan extensions plus the configured companions.",
            "Fixed uploads being rejected over 1 MB, so real audiobooks and backups upload again — the library's maximum upload size is now the only limit."
          ]
        },
        {
          version: "0.20.0",
          label: "Audiobook upload & delete",
          changes: [
            "Upload audiobooks straight from the Audiobooks page — multi-file, one book per upload — staged and then scanned in automatically.",
            "Delete books from the catalog individually or in bulk, removing the folder on disk, its cover art, and all database rows.",
            "Both are permission-gated (contributors can upload, managers can delete) and refused on external read-only libraries."
          ]
        },
        {
          version: "0.19.0",
          label: "Control Panel management refresh",
          changes: [
            "The Control Panel management pages now share the same compact datagrid layout and page-icon headers across Libraries, Users, Groups, Invite links, Sessions, Storage, and Logs.",
            "User management gained manual account creation, profile editing, and admin password changes, with password updates revoking the user's other active sessions.",
            "Library Take ownership now asks for confirmation before granting manager access, and Groups now treats membership as plain membership so library roles remain the source of access control."
          ]
        },
        {
          version: "0.18.0",
          label: "Upload a backup file",
          changes: [
            "The Backup screen can now take a backup file from your computer: click \"Upload backup\", then drop or pick a full .zip (database + cover art) or a database-only .sqlite. It's checked to be a real isputnik backup, added to the list, and restored like any backup made here — handy for moving a library between machines.",
            "Under the hood this is a new shared upload component — drag-and-drop, a live progress bar, and files streamed straight to disk — that future upload spots (library media, and more) will reuse.",
            "Removed the \"Load testing data\" maintenance tool and its generated sample database."
          ]
        },
        {
          version: "0.17.1",
          label: "Track view polish & progress rings",
          changes: [
            "The track list on a book's page was reworked into a cleaner chapter/episode view: a play button on every row, tidied titles (the story name with the author as a byline for radio shows), and a circular progress ring — like the dial used for the context window in chat — that fills as you listen and shows a check when done. For episodic libraries the ring doubles as a played/unplayed toggle; for regular audiobooks it reflects your place, read-only.",
            "The same ring now appears on each chapter in the player, so the player and the book page share one visual language.",
            "Episodic fixes: \"Mark as finished\" and \"Reset\" now apply to every episode rather than just the last one, marking a track played fills its ring, and an episodic book's overall progress now reads \"X / N played\" instead of a misleading single-cursor percentage. A new \"Play next unplayed\" button jumps to the episode you're partway through, or the first one you haven't heard."
          ]
        },
        {
          version: "0.17.0",
          label: "Episodic libraries & smarter progress",
          changes: [
            "New \"Episodic\" progress mode for radio shows, podcasts, and other collections of standalone episodes: each track is tracked on its own — a played/unplayed toggle on every episode, a \"now playing\" marker, and a per-episode resume position — so skipping one episode never marks the others done. Turn it on per library in Edit → Scanning → Progress tracking.",
            "Fixed audiobooks being marked \"Finished\" just because you skipped or jumped ahead: a book now counts as finished only when you actually reach the end of its last track (or mark it finished yourself), so sampling the ending or skipping a chapter no longer completes the whole book."
          ]
        },
        {
          version: "0.16.0",
          label: "Members, library editing & scan status",
          changes: [
            "Editing a library is now a tabbed panel — Access, Upload, and Scanning — that matches the create wizard, replacing the old single long form.",
            "Manage members & roles was rebuilt: a public/private banner up top, an avatar for each user and group, and a role dropdown on every row that changes a member's role in place. The Everyone baseline appears as its own row, managed from the library's public-access setting.",
            "The Libraries page now shows a banner while any library is scanning, and each library's rescan button turns into a spinning, disabled indicator until its scan finishes.",
            "Create-library wizard polish: Quick setup always applies its recommended defaults (even after a detour through Custom), the last step shows a collapsible review of everything that will be created, finished steps can be clicked to jump back, and scan-source order can now be changed with up/down buttons that work by keyboard and touch — not just mouse dragging.",
            "Fixed a bug where rescanning a library emptied any series you had created by hand; books added to a series manually now stay put across rescans.",
            "Adding a library now rejects a folder that overlaps an existing library (the same folder, or one nested inside another) so the same files are not scanned twice."
          ]
        },
        {
          version: "0.15.0",
          label: "Create wizard: Upload & Scanning steps",
          changes: [
            "Creating a library in Custom mode gained dedicated Upload and Scanning steps — file extensions and the per-file upload limit, then the metadata sources and their priority order — and scan sources can be reordered by dragging."
          ]
        },
        {
          version: "0.14.0",
          label: "Standardized dialogs, buttons & messages",
          changes: [
            "Every dialog in the app now uses one shared modal component, so they all look and behave the same: Escape and clicking outside close them, and closing is blocked while a save or delete is running.",
            "Destructive actions got consistent confirmations — a question naming exactly what will be deleted, a note on what is not affected (your files on disk are never touched), and an explicit red Delete button instead of generic OK/Yes prompts.",
            "Buttons follow one vocabulary everywhere: Add attaches something existing, Create makes something new, Remove detaches without deleting data, and Delete destroys — always behind a confirmation.",
            "A new automated check (npm run check:ui) and a written UI convention guide keep future changes — human- or AI-written — on the same standard.",
            "Adding a library was redesigned around one wizard for every library type: Quick create needs only a type, name, and folder (recommended defaults cover the rest), while Custom setup walks through Basics, Access, and Scanning & upload steps.",
            "Tag text encoding is now a per-library setting: set it once (at creation or in Edit) and every scan repairs garbled legacy tags automatically — the Rescan dialog still allows a one-time override.",
            "Audiobook and ebook libraries are now managed on one Libraries page in the Control Panel, with a type column and All / Audiobooks / Ebooks filter — the old separate sections (and their duplicated code) are gone."
          ]
        },
        {
          version: "0.13.0",
          label: "Library scanning options & unified creation",
          changes: [
            "Adding an audiobook library is now a three-step wizard — Details, Scanning & upload, Source folder — and every scanning option you set there can be changed later from the Edit dialog.",
            "Metadata sources are now a prioritized list you control: \"Metadata files in folders\" (metadata.json), \"File metadata\" (embedded tags), and the new \"Folder structure\" can each be turned on or off and reordered — when two sources provide the same field, the higher one wins. The Rescan dialog is pre-filled with the library's saved sources and lets you override them for a single run.",
            "New \"Folder structure\" scan mode: each top-level folder under the library root becomes one book and every audio file beneath it becomes a track — ideal for collections organized by folder rather than by tags.",
            "Each library now has an editable file-extension list (pre-filled with sensible defaults per library type) that controls what gets scanned, and the same list will govern uploads; a per-upload size limit can also be set per library."
          ]
        },
        {
          version: "0.12.0",
          label: "Unified permissions & library modes",
          changes: [
            "Library access was rebuilt on one model: every user or group is granted a role on a library — Viewer (view), Member (view + download), Contributor (add/edit content), or Manager (full control) — plus an explicit Deny that blocks someone outright. Public access is just the built-in \"Everyone\" group's role.",
            "New library Mode: choose Managed (this app owns the files) or External / read-only — point the app at a folder managed by Plex or Audiobookshelf and use it purely as a viewer/streamer, with no risk of writing to it.",
            "Private libraries are now hidden even from admins until they explicitly Take ownership (a logged action) from the Control Panel, so a household member's private library stays private.",
            "Under the hood, one permission engine (can-user-do-this) now governs all library access, replacing several overlapping mechanisms — simpler and ready to extend to other content types."
          ]
        },
        {
          version: "0.11.0",
          label: "Library roles & permissions",
          changes: [
            "Libraries now support graduated roles you can grant to individual users or whole groups from Control Panel → Libraries / Ebooks → Members: Viewer (view only), Subscriber (view + download), Contributor (upload & edit items), Curator (manage series and structure), and Library Admin (full control including members and settings).",
            "Viewing and downloading are now separate permissions. Each public library has a \"Public access\" setting — View + download (the default) or View only — that sets what every signed-in person gets, and granting a user or group a lower role (for example Viewer) limits just them to in-app listening/reading with no file downloads.",
            "Sharing a book (guest links and user-to-user shares) now requires the Curator role, and a book's Edit, Download, and Share buttons appear only when your role on that library allows them."
          ]
        },
        {
          version: "0.10.1",
          label: "Audiobook library polish",
          changes: [
            "Audiobook tiles now use a larger cover-first layout with an expanded hover panel for play, favorite, download, collection, share, and admin actions.",
            "Book details have icon-first action controls, refreshed tag pills, and progress actions grouped directly inside the listening progress card.",
            "Library and sort dropdowns on the audiobook page stack options vertically again after the tile menu redesign."
          ]
        },
        {
          version: "0.10.0",
          label: "PWA navigation & offline reliability",
          changes: [
            "Phone and installed-PWA navigation now uses a native-style bottom tab bar: Home, Media, Downloads, Collections, and Profile.",
            "Media remembers whether you last used Audiobooks or Ebooks, while personal library pages keep a compact icon-only navigation strip on phones.",
            "Offline downloads now keep enough book metadata in IndexedDB to open downloaded details and the player even after API cache entries expire.",
            "Private runtime caches are cleared on setup reset, logout, lost auth, and account switches; public app artwork is cached separately for offline launches."
          ]
        },
        {
          version: "0.9.1",
          label: "Bookmarks & quick navigation",
          changes: [
            "New Bookmarks page — every spot you've saved while listening, gathered in one place under the user menu.",
            "A navigation toolbar now sits on the personal pages (Favorites, Bookmarks, Collections, Shared with me, Theme, Profile), so you can jump between them without opening the menu each time.",
            "Audiobook tiles: the ⋮ menu now includes \"Add to collection,\" and \"Edit metadata\" opens the full editor (the same one as the book page) instead of the bulk-overwrite dialog.",
            "Polished the remove control on the Favorites and Bookmarks tiles."
          ]
        },
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
