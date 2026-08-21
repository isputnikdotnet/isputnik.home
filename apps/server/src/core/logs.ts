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

const isoInstant = z
  .string()
  .trim()
  .refine((value) => !value || !Number.isNaN(Date.parse(value)), "Expected an ISO date-time")
  .optional();

const logQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  // Facet selections (multi-select). `event` holds event categories (the part
  // before the first ".", e.g. "share"); `user` holds actor display names, with
  // the literal "System" matching automated/null-actor rows; `ip` holds addresses.
  event: multiParam,
  user: multiParam,
  ip: multiParam,
  // Optional time window (ISO instants). The Dashboard's Logins view sends the
  // range its picker resolved, so its table always describes the same window as
  // the chart above it; the Logs page leaves these off and gets everything.
  from: isoInstant,
  to: isoInstant,
  // Column sorting for the tables that offer it (the Dashboard's Logins view).
  // Time stays the default and the tiebreaker, so equal keys keep a stable order.
  sort: z.enum(["time", "user", "event", "ip"]).default("time"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25)
});

const SYSTEM_ACTOR = "System";

// Whitelisted sort expressions — the column never comes from the query string
// itself, only the key that selects one of these.
const SORT_COLUMNS: Record<"time" | "user" | "event" | "ip", string> = {
  time: "datetime(activity_logs.created_at)",
  user: "users.display_name",
  event: "activity_logs.event",
  ip: "activity_logs.ip_address"
};

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
  actor_id: string | null;
}

// The WHERE and ORDER BY for one log query, built once and shared by the page
// and the export — so a CSV is exactly the rows the screen was showing, never a
// near miss from a second implementation of the same filters.
function buildLogQuery(data: z.infer<typeof logQuerySchema>) {
    const query = data.q ?? "";
    const events = toArray(data.event);
    const usersFilter = toArray(data.user);
    const ips = toArray(data.ip);
    const from = data.from?.trim() ? new Date(data.from).toISOString() : "";
    const to = data.to?.trim() ? new Date(data.to).toISOString() : "";

    // Build the WHERE clause from the active filters. Each facet OR's its own
    // selections; the facets AND together (and with the free-text search). Only
    // params that actually appear are bound, so better-sqlite3 stays happy.
    const conditions: string[] = [];
    const filterParams: Record<string, string> = {};

    if (events.length) {
      // A bare category (no dot, e.g. "auth" from the Logs page's own facet list)
      // matches every event under it; a full event name (has a dot, e.g.
      // "auth.login" from the Dashboard's curated event lists) matches exactly —
      // otherwise "auth.login" would LIKE-match as a prefix of "auth.login_failed" too.
      const clauses = events.map((value, i) => {
        if (value.includes(".")) {
          filterParams[`ev${i}`] = value;
          return `activity_logs.event = @ev${i}`;
        }
        filterParams[`ev${i}`] = `${value}.%`;
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

    if (from) {
      conditions.push("datetime(activity_logs.created_at) >= datetime(@from)");
      filterParams.from = from;
    }

    if (to) {
      conditions.push("datetime(activity_logs.created_at) <= datetime(@to)");
      filterParams.to = to;
    }

    if (query) {
      conditions.push(`(activity_logs.event LIKE @search
          OR activity_logs.detail LIKE @search
          OR activity_logs.ip_address LIKE @search
          OR users.display_name LIKE @search)`);
      filterParams.search = `%${query}%`;
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const sortKey = data.sort ?? "time";
    const direction = (data.dir ?? "desc") === "asc" ? "ASC" : "DESC";
    // A NULL display name (the System actor) or IP sorts last either way, rather
    // than clumping at the top of a descending sort where it reads as data.
    const nullsLast = sortKey === "time" ? "" : `${SORT_COLUMNS[sortKey]} IS NULL, `;
    const orderBy =
      sortKey === "time"
        ? `datetime(activity_logs.created_at) ${direction}, activity_logs.id ${direction}`
        : `${nullsLast}${SORT_COLUMNS[sortKey]} ${direction}, datetime(activity_logs.created_at) DESC, activity_logs.id DESC`;

    return { where, orderBy, filterParams };
}

const LOG_SELECT = `
  SELECT
    activity_logs.id,
    activity_logs.event,
    activity_logs.detail,
    activity_logs.ip_address,
    activity_logs.created_at,
    users.display_name AS actor_name,
    users.id AS actor_id
  FROM activity_logs
  LEFT JOIN users ON users.id = activity_logs.actor_user_id
`;

/** How many rows one CSV may carry — far past any family server's log, short of a runaway. */
const EXPORT_ROW_CAP = 50_000;

function csvCell(value: string | null): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // A leading formula character is neutralised so a crafted detail string can't
  // become a formula when the file opens in a spreadsheet.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function logsPlugin(app: FastifyInstance) {
  app.get("/api/logs", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(logQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid log query", details: parsed.error });
    }
    const pageSize = parsed.data.pageSize ?? 25;
    const requestedPage = parsed.data.page ?? 1;
    const { where, orderBy, filterParams } = buildLogQuery(parsed.data);

    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM activity_logs
      LEFT JOIN users ON users.id = activity_logs.actor_user_id
      ${where}
    `).get(filterParams) as { count: number };
    const totalPages = Math.max(1, Math.ceil(count.count / pageSize));
    const page = Math.min(requestedPage, totalPages);

    const rows = db.prepare(`
      ${LOG_SELECT}
      ${where}
      ORDER BY ${orderBy}
      LIMIT @pageSize OFFSET @offset
    `).all({
      ...filterParams,
      pageSize,
      offset: (page - 1) * pageSize
    }) as LogRow[];

    // Facet option lists across the whole table (unfiltered), so the Filter
    // surface always reflects reality: event categories, actor names, and IPs.
    // Full event names, not just their category: "auth.login_failed" is the
    // filter an audit actually wants, and the list is searchable so typing a
    // category still narrows to its events.
    const eventRows = db.prepare(`
      SELECT DISTINCT event AS value
      FROM activity_logs
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
        actorName: row.actor_name,
        actorId: row.actor_id
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

  // The same query as the page, as a CSV download: whatever filters, search and
  // sort are in force, every matching row (up to the cap) rather than one page.
  // Built through the same buildLogQuery so the file can never disagree with the
  // screen it was exported from.
  app.get("/api/logs/export", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(logQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid log query", details: parsed.error });
    }
    const { where, orderBy, filterParams } = buildLogQuery(parsed.data);
    const rows = db.prepare(`
      ${LOG_SELECT}
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${EXPORT_ROW_CAP}
    `).all(filterParams) as LogRow[];

    const lines = ["time,event,user,ip_address,detail"];
    for (const row of rows) {
      lines.push(
        [row.created_at, row.event, row.actor_name ?? SYSTEM_ACTOR, row.ip_address, row.detail].map(csvCell).join(",")
      );
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="isputnik-logs-${stamp}.csv"`)
      .send(`\ufeff${lines.join("\r\n")}\r\n`);
  });

  app.delete("/api/logs", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(logCleanupSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid log cleanup period", details: parsed.error });
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

    return reply.send({ deleted: result.changes, olderThanDays: parsed.data.olderThanDays });
  });
}
