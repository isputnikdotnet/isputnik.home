import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import {
  downloadGeoip,
  downloadGeoipFromUrl,
  geoipStatus,
  installGeoipDatabase,
  lookupLocation,
  receiveGeoipUpload
} from "./geoip.js";
import { isPrivateIp } from "./cidr.js";
import { getHomeLocation, homeLocationSchema, setHomeLocation } from "./home-location.js";
import { parseBody } from "./shared.js";

// Event-category groupings used to bucket activity_logs rows for the charts.
// Kept here (not derived generically) since the mapping is a product decision,
// not something the event-naming convention alone can infer.
// What counts as getting in. 'auth.mfa_verified' is the one that is easy to miss
// and the one that matters most: when a second factor is on, the password route
// stops at 'auth.mfa_required' and the session is issued by the MFA route, which
// logs mfa_verified — so a household using two-factor logs NO auth.login at all.
// Leaving it out made every such sign-in invisible here while the Logs page
// showed them plainly.
const LOGIN_SUCCESS_EVENTS = "'auth.login', 'auth.passkey_login', 'auth.mfa_verified', 'auth.device_link_approved'";
// A wrong code is a failed sign-in as much as a wrong password is.
const LOGIN_FAILED_EVENTS = "'auth.login_failed', 'auth.mfa_failed'";
const UPLOAD_EVENTS = "'library.gallery.uploaded', 'library.ebook.book_uploaded', 'library.audiobook.book_uploaded', 'gallery.music.uploaded'";

const SERIES_CASE_SQL = `
  SUM(CASE WHEN event IN (${LOGIN_SUCCESS_EVENTS}) THEN 1 ELSE 0 END) AS logins_success,
  SUM(CASE WHEN event IN (${LOGIN_FAILED_EVENTS}) THEN 1 ELSE 0 END) AS logins_failed,
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

// Bounded window for the Logins view. `from`/`to` are ISO instants (the client
// resolves its 1h/24h/30d presets before asking), and the bucket width follows the
// span: hourly for anything up to two days, daily beyond that, so a 1h range isn't
// one lonely point and a 30d range isn't 720 of them.
const isoInstant = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Expected an ISO date-time");

// Only http(s), and only a URL — the address it resolves to is checked separately,
// per hop, by the fetch itself.
const databaseUrlSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    }, "Expected an http(s) URL")
});

const loginsQuerySchema = z.object({
  from: isoInstant,
  to: isoInstant
});

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Spans up to this length bucket by hour; longer ones bucket by day. */
const HOURLY_MAX_SPAN_MS = 2 * DAY_MS;

function floorToBucket(date: Date, bucket: "hour" | "day"): Date {
  const out = new Date(date);
  out.setUTCMinutes(0, 0, 0);
  if (bucket === "day") out.setUTCHours(0);
  return out;
}

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

    return reply.send({
      days: dayList,
      series,
      kpis: {
        logins24h: rollingCount(`${LOGIN_SUCCESS_EVENTS}`, 1),
        uploads7d: rollingCount(UPLOAD_EVENTS, 7),
        downloads7d: rollingLikeCount("%.downloaded", 7),
        deletes7d: rollingLikeCount("%.deleted", 7)
      }
    });
  });

  app.get("/api/dashboard/logins", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(loginsQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid logins query", details: parsed.error });
    }

    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (to.getTime() <= from.getTime()) {
      return reply.code(400).send({ error: "Invalid logins range", details: "The end of the range must come after its start." });
    }

    const bucket: "hour" | "day" = to.getTime() - from.getTime() <= HOURLY_MAX_SPAN_MS ? "hour" : "day";
    const bucketFormat = bucket === "hour" ? "%Y-%m-%dT%H:00:00.000Z" : "%Y-%m-%dT00:00:00.000Z";
    const range = { from: from.toISOString(), to: to.toISOString() };

    const rows = db.prepare(`
      SELECT
        strftime('${bucketFormat}', created_at) AS bucket,
        SUM(CASE WHEN event IN (${LOGIN_SUCCESS_EVENTS}) THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN event IN (${LOGIN_FAILED_EVENTS}) THEN 1 ELSE 0 END) AS failed
      FROM activity_logs
      WHERE event IN (${LOGIN_SUCCESS_EVENTS}, ${LOGIN_FAILED_EVENTS})
        AND datetime(created_at) >= datetime(@from)
        AND datetime(created_at) <= datetime(@to)
      GROUP BY bucket
    `).all(range) as { bucket: string; success: number; failed: number }[];
    const byBucket = new Map(rows.map((row) => [row.bucket, row]));

    // Every bucket in the window is emitted, empty ones included — a gap in the
    // chart should read as "no logins then", not as a missing sample.
    const buckets: string[] = [];
    const success: number[] = [];
    const failed: number[] = [];
    const step = bucket === "hour" ? HOUR_MS : DAY_MS;
    for (let cursor = floorToBucket(from, bucket).getTime(); cursor <= to.getTime(); cursor += step) {
      const key = new Date(cursor).toISOString();
      buckets.push(key);
      success.push(byBucket.get(key)?.success ?? 0);
      failed.push(byBucket.get(key)?.failed ?? 0);
    }

    // The equal-length window immediately before this one, so each card can say
    // how the range compares with the stretch that came before it.
    const previousRange = {
      from: new Date(from.getTime() - (to.getTime() - from.getTime())).toISOString(),
      to: range.from
    };

    const totalsStatement = db.prepare(`
      SELECT
        SUM(CASE WHEN event = 'auth.login' THEN 1 ELSE 0 END) AS password,
        SUM(CASE WHEN event = 'auth.passkey_login' THEN 1 ELSE 0 END) AS passkey,
        SUM(CASE WHEN event = 'auth.mfa_verified' THEN 1 ELSE 0 END) AS two_factor,
        SUM(CASE WHEN event = 'auth.device_link_approved' THEN 1 ELSE 0 END) AS device_link,
        SUM(CASE WHEN event IN (${LOGIN_FAILED_EVENTS}) THEN 1 ELSE 0 END) AS failed,
        COUNT(DISTINCT CASE WHEN event IN (${LOGIN_SUCCESS_EVENTS}) THEN actor_user_id END) AS people
      FROM activity_logs
      WHERE datetime(created_at) >= datetime(@from) AND datetime(created_at) <= datetime(@to)
    `);
    // Blocks are counted by when they were placed, not by which are still live —
    // this card describes what happened during the window, like the ones beside it.
    const blockedStatement = db.prepare(`
      SELECT COUNT(*) AS blocked FROM blocked_ips
      WHERE datetime(created_at) >= datetime(@from) AND datetime(created_at) <= datetime(@to)
    `);

    const totalsFor = (window: { from: string; to: string }) => {
      const row = totalsStatement.get(window) as {
        password: number | null;
        passkey: number | null;
        two_factor: number | null;
        device_link: number | null;
        failed: number | null;
        people: number | null;
      };
      const password = row.password ?? 0;
      const passkey = row.passkey ?? 0;
      const twoFactor = row.two_factor ?? 0;
      const deviceLink = row.device_link ?? 0;
      const failed = row.failed ?? 0;
      const success = password + passkey + twoFactor + deviceLink;
      const blocked = (blockedStatement.get(window) as { blocked: number }).blocked;
      return {
        methods: { password, passkey, twoFactor, deviceLink },
        attempts: success + failed,
        success,
        failed,
        people: row.people ?? 0,
        blockedIps: blocked
      };
    };

    const current = totalsFor(range);
    const previous = totalsFor(previousRange);

    return reply.send({
      from: range.from,
      to: range.to,
      bucket,
      buckets,
      series: { success, failed },
      methods: current.methods,
      totals: {
        attempts: current.attempts,
        success: current.success,
        failed: current.failed,
        people: current.people,
        blockedIps: current.blockedIps
      },
      previous: {
        attempts: previous.attempts,
        success: previous.success,
        failed: previous.failed,
        blockedIps: previous.blockedIps
      }
    });
  });

  // Where the sign-ins in a window came from. The grouping is done here rather
  // than in SQL because the country of an address is a file lookup, not a column:
  // one row per distinct address, resolved locally, then summed.
  app.get("/api/dashboard/locations", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(loginsQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid locations query", details: parsed.error });
    }
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (to.getTime() <= from.getTime()) {
      return reply.code(400).send({ error: "Invalid locations range", details: "The end of the range must come after its start." });
    }

    const rows = db.prepare(`
      SELECT
        activity_logs.ip_address AS ip,
        COUNT(*) AS connections,
        SUM(CASE WHEN event IN (${LOGIN_FAILED_EVENTS}) THEN 1 ELSE 0 END) AS failed,
        COUNT(DISTINCT activity_logs.actor_user_id) AS people
      FROM activity_logs
      WHERE event IN (${LOGIN_SUCCESS_EVENTS}, ${LOGIN_FAILED_EVENTS})
        AND datetime(created_at) >= datetime(@from)
        AND datetime(created_at) <= datetime(@to)
      GROUP BY activity_logs.ip_address
    `).all({ from: from.toISOString(), to: to.toISOString() }) as {
      ip: string | null;
      connections: number;
      failed: number;
      people: number;
    }[];

    const byCountry = new Map<string, { code: string; name: string | null; connections: number; failed: number; addresses: number }>();
    // Only filled when the owner has supplied a city-level database; the country
    // tier has no city or coordinates to group by.
    const byPlace = new Map<
      string,
      { code: string; country: string | null; city: string | null; region: string | null; latitude: number | null; longitude: number | null; connections: number; failed: number; addresses: number }
    >();
    const local = { connections: 0, failed: 0, addresses: 0 };
    const unknown = { connections: 0, failed: 0, addresses: 0 };
    let total = 0;

    for (const row of rows) {
      total += row.connections;
      if (!row.ip || isPrivateIp(row.ip)) {
        local.connections += row.connections;
        local.failed += row.failed;
        local.addresses += 1;
        continue;
      }
      const hit = lookupLocation(row.ip);
      if (!hit) {
        unknown.connections += row.connections;
        unknown.failed += row.failed;
        unknown.addresses += 1;
        continue;
      }
      const entry = byCountry.get(hit.code) ?? { code: hit.code, name: hit.name, connections: 0, failed: 0, addresses: 0 };
      entry.connections += row.connections;
      entry.failed += row.failed;
      entry.addresses += 1;
      byCountry.set(hit.code, entry);

      if (hit.city || hit.latitude !== null) {
        const key = `${hit.code}|${hit.region ?? ""}|${hit.city ?? ""}`;
        const place = byPlace.get(key) ?? {
          code: hit.code,
          country: hit.name,
          city: hit.city,
          region: hit.region,
          latitude: hit.latitude,
          longitude: hit.longitude,
          connections: 0,
          failed: 0,
          addresses: 0
        };
        place.connections += row.connections;
        place.failed += row.failed;
        place.addresses += 1;
        byPlace.set(key, place);
      }
    }

    return reply.send({
      from: from.toISOString(),
      to: to.toISOString(),
      geoip: geoipStatus(),
      // Where the household says it lives, so its own connections get a dot too.
      home: getHomeLocation(),
      total,
      local,
      unknown,
      countries: [...byCountry.values()].sort((a, b) => b.connections - a.connections),
      places: [...byPlace.values()].sort((a, b) => b.connections - a.connections).slice(0, 100)
    });
  });

  // Fetching the database is the one outbound call the Locations page makes, and
  // an admin asks for it by name. Lookups afterwards never leave the machine.
  app.post("/api/dashboard/locations/database", { preHandler: app.requireAdmin }, async (request, reply) => {
    const result = await downloadGeoip(request.user!.id);
    if (!result.ok) {
      return reply.code(502).send({ error: `Unable to download the location database. ${result.error ?? ""}`.trim() });
    }
    return reply.send({ geoip: result.status });
  });

  // Where home is. Null clears it — a household that would rather not draw its own
  // dot should be able to take it back off the map.
  app.put("/api/dashboard/locations/home", { preHandler: app.requireAdmin }, async (request, reply) => {
    const body = request.body as { latitude?: unknown } | null;
    if (!body || body.latitude === null || body.latitude === undefined) {
      setHomeLocation(null, request.user!.id);
      return reply.send({ home: null });
    }

    const parsed = parseBody(homeLocationSchema, body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid home location", details: parsed.error });
    }
    setHomeLocation(parsed.data, request.user!.id);
    return reply.send({ home: getHomeLocation() });
  });

  // A database the owner points us at by URL — DB-IP City Lite, a GeoLite2
  // permalink with their key, a mirror. Streamed straight to disk through the
  // same SSRF-pinned fetch the rest of the app uses, so a pasted link can never
  // become a way to make this server talk to its own network.
  app.post("/api/dashboard/locations/database/url", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(databaseUrlSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid database URL", details: parsed.error });
    }
    const result = await downloadGeoipFromUrl(parsed.data.url, request.user!.id);
    if (!result.ok) {
      return reply.code(502).send({ error: result.error ?? "Unable to fetch that database." });
    }
    return reply.send({ geoip: result.status, installed: result.installed });
  });

  // The same thing for an install with no route to the internet: the file comes
  // up from the browser instead. Streamed to a temp file and validated before it
  // is allowed into the folder — an upload that is not a database is deleted.
  app.post("/api/dashboard/locations/database/upload", { preHandler: app.requireAdmin }, async (request, reply) => {
    let received: { tmpPath: string; filename: string };
    try {
      received = await receiveGeoipUpload(request);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "The upload failed." });
    }

    const result = await installGeoipDatabase(received.tmpPath, received.filename, request.user!.id);
    if (!result.ok) {
      return reply.code(400).send({ error: result.error ?? "That file is not a location database." });
    }
    return reply.send({ geoip: result.status, installed: result.installed });
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
