import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { db, logActivity } from "../db.js";
import { parseBody } from "./shared.js";

const logQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25)
});

const logCleanupSchema = z.object({
  olderThanDays: z.number().int().min(1).max(3650).default(365)
});

interface LogRow {
  id: string;
  event: string;
  detail: string;
  ip_address: string | null;
  created_at: string;
  actor_name: string | null;
}

export async function logsPlugin(app: FastifyInstance) {
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
}
