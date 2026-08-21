import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import { config } from "../config.js";
import { RECENT_VERSION_COUNT, VERSION_UPDATES } from "../changelog.js";
import { collectStatusContributions } from "./status-contributors.js";

// Paging for the changelog tail. `limit` is capped so a caller cannot ask for
// the whole history in one response; a bad value falls back to the defaults
// rather than erroring, since this only ever feeds a "show earlier" button.
const changelogQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(25)
});

function databaseSize() {
  return [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`].reduce((total, file) => (
    total + (fs.existsSync(file) ? fs.statSync(file).size : 0)
  ), 0);
}

// Free space on the volume the database lives on — for a media server the one
// number that turns a quiet evening into a full disk. Measured, not configured:
// statfs on the data directory answers for whatever is actually mounted there.
// Null when the platform can't say (an exotic mount, a read-only filesystem),
// which the page shows as unknown rather than as zero.
function dataDisk(): { path: string; freeBytes: number; totalBytes: number } | null {
  const directory = path.dirname(config.dbPath);
  try {
    const stats = fs.statfsSync(directory);
    return {
      path: directory,
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize)
    };
  } catch {
    return null;
  }
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

    const memory = process.memoryUsage();
    return {
      status: {
        health: "Operational",
        version: config.version,
        runtime: process.version,
        memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal },
        disk: dataDisk(),
        databaseBytes: databaseSize(),
        users: users.count,
        activeSessions: sessions.count,
        activeInvites: activeInvites.count,
        logEntries: events.count,
        // Per-media-type numbers (audiobookLibraries/audiobookBooks/libraryStats,
        // ebookStats, galleryStats, faceStats) come from whichever media types
        // registered a contributor. Spread before the fields below so a module
        // cannot overwrite the platform's own figures.
        ...collectStatusContributions(app.log),
        uptimeSeconds: Math.floor(process.uptime()),
        generatedAt: new Date().toISOString()
      }
    };
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
      // Only the newest releases travel with /api/about; the rest are paged in
      // from the endpoint below when the reader asks for them. See changelog.ts.
      versionUpdates: VERSION_UPDATES.slice(0, RECENT_VERSION_COUNT),
      versionUpdatesTotal: VERSION_UPDATES.length
    }
  }));

  // Older releases, oldest-page-last, for the About timeline's "show earlier"
  // control. Bounded per request so no caller can ask for the whole history in
  // one go — the reason any of this was split out in the first place.
  app.get("/api/about/changelog", { preHandler: app.authenticate }, async (request) => {
    const query = changelogQuery.safeParse(request.query);
    const { offset, limit } = query.success ? query.data : { offset: 0, limit: 25 };
    return {
      versionUpdates: VERSION_UPDATES.slice(offset, offset + limit),
      total: VERSION_UPDATES.length
    };
  });
}