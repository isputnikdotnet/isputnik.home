import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { parseBody } from "./shared.js";

// Event-category groupings used to bucket activity_logs rows for the charts.
// Kept here (not derived generically) since the mapping is a product decision,
// not something the event-naming convention alone can infer.
const LOGIN_SUCCESS_EVENTS = "'auth.login', 'auth.passkey_login', 'auth.device_link_approved'";
const LOGIN_FAILED_EVENT = "'auth.login_failed'";
const UPLOAD_EVENTS = "'library.gallery.uploaded', 'library.ebook.book_uploaded', 'library.audiobook.book_uploaded', 'gallery.music.uploaded'";

const SERIES_CASE_SQL = `
  SUM(CASE WHEN event IN (${LOGIN_SUCCESS_EVENTS}) THEN 1 ELSE 0 END) AS logins_success,
  SUM(CASE WHEN event = ${LOGIN_FAILED_EVENT} THEN 1 ELSE 0 END) AS logins_failed,
  SUM(CASE WHEN event IN (${UPLOAD_EVENTS}) THEN 1 ELSE 0 END) AS uploads,
  SUM(CASE WHEN event LIKE '%.downloaded' THEN 1 ELSE 0 END) AS downloads,
  SUM(CASE WHEN event LIKE '%.deleted' OR event IN ('library.item_trashed', 'library.item_purged') THEN 1 ELSE 0 END) AS deletes,
  SUM(CASE WHEN event = 'library.audiobook.played' THEN 1 ELSE 0 END) AS played,
  SUM(CASE WHEN event = 'library.ebook.read' THEN 1 ELSE 0 END) AS read,
  SUM(CASE WHEN event = 'library.gallery.viewed' THEN 1 ELSE 0 END) AS viewed
`;

interface DaySeriesRow {
  day: string;
  logins_success: number;
  logins_failed: number;
  uploads: number;
  downloads: number;
  deletes: number;
  played: number;
  read: number;
  viewed: number;
}

const SERIES_KEYS = ["loginsSuccess", "loginsFailed", "uploads", "downloads", "deletes", "played", "read", "viewed"] as const;

const summaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(14)
});

const inProgressQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

function rollingCount(eventsSql: string, sinceDays: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM activity_logs
    WHERE event IN (${eventsSql}) AND datetime(created_at) > datetime('now', ?)
  `).get(`-${sinceDays} days`) as { n: number };
  return row.n;
}

function rollingLikeCount(likePattern: string, sinceDays: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM activity_logs
    WHERE event LIKE ? AND datetime(created_at) > datetime('now', ?)
  `).get(likePattern, `-${sinceDays} days`) as { n: number };
  return row.n;
}

export async function dashboardPlugin(app: FastifyInstance) {
  app.get("/api/dashboard/summary", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(summaryQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid dashboard query", details: parsed.error });
    }
    const days = parsed.data.days ?? 14;

    const rows = db.prepare(`
      SELECT date(created_at) AS day, ${SERIES_CASE_SQL}
      FROM activity_logs
      WHERE date(created_at) >= date('now', ?)
      GROUP BY day
    `).all(`-${days - 1} days`) as DaySeriesRow[];
    const byDay = new Map(rows.map((row) => [row.day, row]));

    const dayList: string[] = [];
    const series: Record<(typeof SERIES_KEYS)[number], number[]> = {
      loginsSuccess: [], loginsFailed: [], uploads: [], downloads: [], deletes: [], played: [], read: [], viewed: []
    };
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const day = d.toISOString().slice(0, 10);
      dayList.push(day);
      const row = byDay.get(day);
      series.loginsSuccess.push(row?.logins_success ?? 0);
      series.loginsFailed.push(row?.logins_failed ?? 0);
      series.uploads.push(row?.uploads ?? 0);
      series.downloads.push(row?.downloads ?? 0);
      series.deletes.push(row?.deletes ?? 0);
      series.played.push(row?.played ?? 0);
      series.read.push(row?.read ?? 0);
      series.viewed.push(row?.viewed ?? 0);
    }

    const loginMethods = db.prepare(`
      SELECT
        SUM(CASE WHEN event = 'auth.login' THEN 1 ELSE 0 END) AS password,
        SUM(CASE WHEN event = 'auth.passkey_login' THEN 1 ELSE 0 END) AS passkey,
        SUM(CASE WHEN event = 'auth.device_link_approved' THEN 1 ELSE 0 END) AS device_link
      FROM activity_logs
      WHERE datetime(created_at) > datetime('now', '-7 days')
    `).get() as { password: number; passkey: number; device_link: number };

    return reply.send({
      days: dayList,
      series,
      loginMethods: {
        password: loginMethods.password ?? 0,
        passkey: loginMethods.passkey ?? 0,
        deviceLink: loginMethods.device_link ?? 0
      },
      kpis: {
        logins24h: rollingCount(`${LOGIN_SUCCESS_EVENTS}`, 1),
        uploads7d: rollingCount(UPLOAD_EVENTS, 7),
        downloads7d: rollingLikeCount("%.downloaded", 7),
        deletes7d: rollingLikeCount("%.deleted", 7)
      }
    });
  });

  app.get("/api/dashboard/in-progress", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(inProgressQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid dashboard query", details: parsed.error });
    }

    const rows = db.prepare(`
      SELECT 'audiobook' AS kind, playback_progress.updated_at AS updated_at, playback_progress.percent_complete AS percent_complete,
        users.display_name AS user_name, COALESCE(item_metadata.title, library_items.folder_path) AS title
      FROM playback_progress
      JOIN users ON users.id = playback_progress.user_id
      JOIN library_items ON library_items.id = playback_progress.item_id AND library_items.deleted_at IS NULL
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      WHERE playback_progress.completed_at IS NULL
      UNION ALL
      SELECT 'ebook' AS kind, reading_progress.updated_at, reading_progress.percent_complete,
        users.display_name, COALESCE(item_metadata.title, library_items.folder_path)
      FROM reading_progress
      JOIN users ON users.id = reading_progress.user_id
      JOIN library_items ON library_items.id = reading_progress.item_id AND library_items.deleted_at IS NULL
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      WHERE reading_progress.completed_at IS NULL
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(parsed.data.limit ?? 50) as {
      kind: "audiobook" | "ebook";
      updated_at: string;
      percent_complete: number | null;
      user_name: string;
      title: string;
    }[];

    return reply.send({
      inProgress: rows.map((row) => ({
        kind: row.kind,
        updatedAt: row.updated_at,
        percentComplete: row.percent_complete,
        userName: row.user_name,
        title: row.title
      }))
    });
  });
}
