import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { db, logActivity } from "../db.js";
import { parseBody } from "./shared.js";

// Repeated query params (?event=a&event=b) arrive as string | string[] | undefined
// depending on how many were sent; normalise each to a trimmed string[].
const multiParam = z.union([z.string(), z.array(z.string().max(200))]).optional();
const toArray = (value: string | string[] | undefined): string[] =>
  (value === undefined ? [] : Array.isArray(value) ? value : [value])
    .map((entry) => entry.trim())
    .filter(Boolean);

const logQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  // Facet selections (multi-select). `event` holds event categories (the part
  // before the first ".", e.g. "share"); `user` holds actor display names, with
  // the literal "System" matching automated/null-actor rows; `ip` holds addresses.
  event: multiParam,
  user: multiParam,
  ip: multiParam,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25)
});

const SYSTEM_ACTOR = "System";

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
    const events = toArray(parsed.data.event);
    const usersFilter = toArray(parsed.data.user);
    const ips = toArray(parsed.data.ip);
    const pageSize = parsed.data.pageSize ?? 25;
    const requestedPage = parsed.data.page ?? 1;

    // Build the WHERE clause from the active filters. Each facet OR's its own
    // selections; the facets AND together (and with the free-text search). Only
    // params that actually appear are bound, so better-sqlite3 stays happy.
    const conditions: string[] = [];
    const filterParams: Record<string, string> = {};

    if (events.length) {
      const clauses = events.map((category, i) => {
        filterParams[`ev${i}`] = `${category}.%`;
        return `activity_logs.event LIKE @ev${i}`;
      });
      conditions.push(`(${clauses.join(" OR ")})`);
    }

    if (usersFilter.length) {
      const named = usersFilter.filter((name) => name !== SYSTEM_ACTOR);
      const parts: string[] = [];
      if (named.length) {
        const placeholders = named.map((name, i) => {
          filterParams[`user${i}`] = name;
          return `@user${i}`;
        });
        parts.push(`users.display_name IN (${placeholders.join(", ")})`);
      }
      if (usersFilter.includes(SYSTEM_ACTOR)) {
        parts.push("activity_logs.actor_user_id IS NULL");
      }
      conditions.push(`(${parts.join(" OR ")})`);
    }

    if (ips.length) {
      const placeholders = ips.map((ip, i) => {
        filterParams[`ip${i}`] = ip;
        return `@ip${i}`;
      });
      conditions.push(`activity_logs.ip_address IN (${placeholders.join(", ")})`);
    }

    if (query) {
      conditions.push(`(activity_logs.event LIKE @search
          OR activity_logs.detail LIKE @search
          OR activity_logs.ip_address LIKE @search
          OR users.display_name LIKE @search)`);
      filterParams.search = `%${query}%`;
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM activity_logs
      LEFT JOIN users ON users.id = activity_logs.actor_user_id
      ${where}
    `).get(filterParams) as { count: number };
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
      ...filterParams,
      pageSize,
      offset: (page - 1) * pageSize
    }) as LogRow[];

    // Facet option lists across the whole table (unfiltered), so the Filter
    // surface always reflects reality: event categories, actor names, and IPs.
    const eventRows = db.prepare(`
      SELECT DISTINCT substr(event, 1, instr(event, '.') - 1) AS value
      FROM activity_logs
      WHERE instr(event, '.') > 0
      ORDER BY value
    `).all() as { value: string }[];
    const userRows = db.prepare(`
      SELECT DISTINCT users.display_name AS value
      FROM activity_logs
      JOIN users ON users.id = activity_logs.actor_user_id
      WHERE users.display_name IS NOT NULL
      ORDER BY value
    `).all() as { value: string }[];
    const hasSystem = db.prepare(
      "SELECT 1 FROM activity_logs WHERE actor_user_id IS NULL LIMIT 1"
    ).get() != null;
    const ipRows = db.prepare(`
      SELECT DISTINCT ip_address AS value
      FROM activity_logs
      WHERE ip_address IS NOT NULL
      ORDER BY value
    `).all() as { value: string }[];

    return {
      logs: rows.map((row) => ({
        id: row.id,
        event: row.event,
        detail: row.detail,
        ipAddress: row.ip_address,
        createdAt: row.created_at,
        actorName: row.actor_name
      })),
      facets: {
        event: eventRows.map((row) => row.value),
        user: [...(hasSystem ? [SYSTEM_ACTOR] : []), ...userRows.map((row) => row.value)],
        ip: ipRows.map((row) => row.value)
      },
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
