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
        try {
          const p = JSON.parse(r.payload) as { result?: typeof result };
          result = p.result ?? null;
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
          result
        };
      })
    };
  });

  app.post("/api/jobs/:id/cancel", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const job = db.prepare("SELECT id, status FROM jobs WHERE id = ?").get(id) as { id: string; status: string } | undefined;
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
