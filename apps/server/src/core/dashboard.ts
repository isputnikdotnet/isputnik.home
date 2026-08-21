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
import { currentSessionHash } from "../auth.js";
import { isPrivateIp } from "./cidr.js";
import { describeUserAgent, deviceType } from "./device-link.js";
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

// The Sign-in details page: the same window, narrowed to at most one scope.
// `ip` wins over `user` wins over `country` (with optional region/city refining
// it) — the client only ever sends one, but the precedence keeps a hand-typed
// URL from meaning two things at once.
const signinsQuerySchema = z.object({
  from: isoInstant,
  to: isoInstant,
  country: z.string().trim().length(2).optional(),
  region: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
  ip: z.string().trim().min(1).max(60).optional(),
  user: z.string().trim().min(1).max(40).optional()
});

/** The reader's name for a country when no lookup supplied one ("DE" → "Germany"). */
function countryDisplayName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

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

  // ── Sign-in details ────────────────────────────────────────────────────────
  // The deep-dive behind the arrows on the Locations tables: the same window as
  // the Logins and Locations views, narrowed to one scope — a country, a town,
  // one address, or one person — and answered from every table that watches the
  // door. activity_logs says what happened, login_attempts what the lockout and
  // auto-block counted (including the anonymous scanner traffic no page shows),
  // sessions what is still signed in from there, and blocked_ips who has been
  // shut out. One endpoint rather than four, so every panel of the page
  // describes the same scope over the same window.
  app.get("/api/dashboard/signins", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(signinsQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid sign-ins query", details: parsed.error });
    }
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (to.getTime() <= from.getTime()) {
      return reply.code(400).send({ error: "Invalid sign-ins range", details: "The end of the range must come after its start." });
    }
    const query = parsed.data;
    const params: Record<string, string> = { from: from.toISOString(), to: to.toISOString() };

    // Resolve the scope down to either one person or a set of addresses. A
    // country or town is a set of addresses too: the distinct IPs of the window,
    // resolved locally and kept when they land inside the asked-for place.
    let scope: {
      kind: "all" | "country" | "place" | "ip" | "user";
      label: string;
      code?: string;
      region?: string | null;
      city?: string | null;
      ip?: string;
      userId?: string;
      email?: string;
    };
    let ipSet: string[] | null = null;
    let userId: string | null = null;
    let truncated = false;

    if (query.ip) {
      ipSet = [query.ip];
      scope = { kind: "ip", label: query.ip, ip: query.ip };
    } else if (query.user) {
      const person = db.prepare("SELECT id, display_name, email FROM users WHERE id = ?").get(query.user) as
        | { id: string; display_name: string; email: string }
        | undefined;
      if (!person) {
        return reply.code(404).send({ error: "No such user" });
      }
      userId = person.id;
      scope = { kind: "user", label: person.display_name, userId: person.id, email: person.email };
    } else if (query.country) {
      const code = query.country.toUpperCase();
      const distinct = db.prepare(`
        SELECT DISTINCT ip_address AS ip FROM activity_logs
        WHERE event IN (${LOGIN_SUCCESS_EVENTS}, ${LOGIN_FAILED_EVENTS})
          AND datetime(created_at) >= datetime(@from)
          AND datetime(created_at) <= datetime(@to)
          AND ip_address IS NOT NULL
      `).all(params) as { ip: string }[];
      const wanted: string[] = [];
      let placeName: string | null = null;
      for (const row of distinct) {
        if (isPrivateIp(row.ip)) continue;
        const hit = lookupLocation(row.ip);
        if (!hit || hit.code.toUpperCase() !== code) continue;
        if (query.city !== undefined && (hit.city ?? "") !== query.city) continue;
        if (query.region !== undefined && (hit.region ?? "") !== query.region) continue;
        placeName ??= hit.name;
        wanted.push(row.ip);
        // A family server never gets near this; the cap exists so a pathological
        // log can't build an unbounded IN clause. Announced, not silent.
        if (wanted.length >= 1000) {
          truncated = true;
          break;
        }
      }
      ipSet = wanted;
      const country = placeName ?? countryDisplayName(code);
      scope = {
        kind: query.city || query.region ? "place" : "country",
        label: query.city ? `${query.city}, ${country}` : country,
        code,
        region: query.region ?? null,
        city: query.city ?? null
      };
    } else {
      scope = { kind: "all", label: "All sign-ins" };
    }

    // An IN () is a syntax error and an empty scope is a real answer (a country
    // with no sign-ins), so zero addresses becomes a clause that matches nothing.
    // Parameterised by column name because three tables apply the same set —
    // activity_logs, sessions and login_attempts each against their own column.
    (ipSet ?? []).forEach((ip, i) => {
      params[`ip${i}`] = ip;
    });
    const ipConditionFor = (column: string): string => {
      if (!ipSet) return "";
      if (ipSet.length === 0) return "1 = 0";
      return `${column} IN (${ipSet.map((_, i) => `@ip${i}`).join(", ")})`;
    };

    // The one WHERE clause every aggregate below shares — the guarantee that the
    // chart, the tables and the totals are all describing the same rows. Columns
    // are qualified because half the queries join users, which has created_at too.
    const conditions = [
      `activity_logs.event IN (${LOGIN_SUCCESS_EVENTS}, ${LOGIN_FAILED_EVENTS})`,
      "datetime(activity_logs.created_at) >= datetime(@from)",
      "datetime(activity_logs.created_at) <= datetime(@to)"
    ];
    if (userId) {
      conditions.push("activity_logs.actor_user_id = @userId");
      params.userId = userId;
    }
    if (ipSet) conditions.push(ipConditionFor("activity_logs.ip_address"));
    const where = conditions.join(" AND ");

    const totalsRow = db.prepare(`
      SELECT
        COUNT(*) AS attempts,
        SUM(CASE WHEN event IN (${LOGIN_SUCCESS_EVENTS}) THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN event IN (${LOGIN_FAILED_EVENTS}) THEN 1 ELSE 0 END) AS failed,
        COUNT(DISTINCT actor_user_id) AS people,
        COUNT(DISTINCT ip_address) AS addresses,
        MIN(created_at) AS first_seen,
        MAX(created_at) AS last_seen,
        SUM(CASE WHEN event = 'auth.login' THEN 1 ELSE 0 END) AS m_password,
        SUM(CASE WHEN event = 'auth.passkey_login' THEN 1 ELSE 0 END) AS m_passkey,
        SUM(CASE WHEN event = 'auth.mfa_verified' THEN 1 ELSE 0 END) AS m_two_factor,
        SUM(CASE WHEN event = 'auth.device_link_approved' THEN 1 ELSE 0 END) AS m_device_link
      FROM activity_logs WHERE ${where}
    `).get(params) as {
      attempts: number;
      success: number | null;
      failed: number | null;
      people: number;
      addresses: number;
      first_seen: string | null;
      last_seen: string | null;
      m_password: number | null;
      m_passkey: number | null;
      m_two_factor: number | null;
      m_device_link: number | null;
    };

    // Same bucketing rule as /api/dashboard/logins: a short window by hour, a
    // long one by day, empty buckets emitted so a gap reads as "nothing then".
    const bucket: "hour" | "day" = to.getTime() - from.getTime() <= HOURLY_MAX_SPAN_MS ? "hour" : "day";
    const bucketFormat = bucket === "hour" ? "%Y-%m-%dT%H:00:00.000Z" : "%Y-%m-%dT00:00:00.000Z";
    const seriesRows = db.prepare(`
      SELECT strftime('${bucketFormat}', created_at) AS bucket,
        SUM(CASE WHEN event IN (${LOGIN_SUCCESS_EVENTS}) THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN event IN (${LOGIN_FAILED_EVENTS}) THEN 1 ELSE 0 END) AS failed
      FROM activity_logs WHERE ${where}
      GROUP BY bucket
    `).all(params) as { bucket: string; success: number; failed: number }[];
    const byBucket = new Map(seriesRows.map((row) => [row.bucket, row]));
    const buckets: string[] = [];
    const seriesSuccess: number[] = [];
    const seriesFailed: number[] = [];
    const step = bucket === "hour" ? HOUR_MS : DAY_MS;
    for (let cursor = floorToBucket(from, bucket).getTime(); cursor <= to.getTime(); cursor += step) {
      const key = new Date(cursor).toISOString();
      buckets.push(key);
      seriesSuccess.push(byBucket.get(key)?.success ?? 0);
      seriesFailed.push(byBucket.get(key)?.failed ?? 0);
    }

    // Per-address: what each IP did, where it is, whether it is shut out, and
    // the scanner traffic the auto-block counted against it — the last two come
    // from blocked_ips and login_attempts, which no other row of this page shows.
    const ipRows = db.prepare(`
      SELECT ip_address AS ip, COUNT(*) AS connections,
        SUM(CASE WHEN event IN (${LOGIN_FAILED_EVENTS}) THEN 1 ELSE 0 END) AS failed,
        COUNT(DISTINCT actor_user_id) AS people,
        MAX(created_at) AS last_seen
      FROM activity_logs WHERE ${where} AND ip_address IS NOT NULL
      GROUP BY ip_address ORDER BY connections DESC LIMIT 100
    `).all(params) as { ip: string; connections: number; failed: number | null; people: number; last_seen: string }[];

    const blockedStatement = db.prepare(
      "SELECT auto, expires_at FROM blocked_ips WHERE ip_address = ?"
    );
    const abuseStatement = db.prepare(`
      SELECT SUM(CASE WHEN kind = 'probe' THEN 1 ELSE 0 END) AS probes,
             SUM(CASE WHEN kind = 'token' THEN 1 ELSE 0 END) AS tokens
      FROM login_attempts
      WHERE ip_address = ? AND successful = 0
        AND datetime(created_at) >= datetime(?) AND datetime(created_at) <= datetime(?)
    `);
    const now = Date.now();
    const ips = ipRows.map((row) => {
      const isLocal = isPrivateIp(row.ip);
      const hit = isLocal ? null : lookupLocation(row.ip);
      const block = blockedStatement.get(row.ip) as { auto: number; expires_at: string | null } | undefined;
      const abuse = abuseStatement.get(row.ip, params.from, params.to) as
        | { probes: number | null; tokens: number | null }
        | undefined;
      return {
        ip: row.ip,
        connections: row.connections,
        failed: row.failed ?? 0,
        people: row.people,
        lastSeen: row.last_seen,
        local: isLocal,
        location: isLocal
          ? "Your home network"
          : hit
            ? [hit.city, hit.region, hit.name ?? hit.code].filter(Boolean).join(", ")
            : null,
        code: hit?.code ?? null,
        blocked: block
          ? {
              auto: block.auto === 1,
              expiresAt: block.expires_at,
              lapsed: block.expires_at !== null && Date.parse(block.expires_at) <= now
            }
          : null,
        probes: abuse?.probes ?? 0,
        tokens: abuse?.tokens ?? 0
      };
    });

    // Per-person. Failures carry no actor — a wrong password does not prove who
    // typed it — so they gather under the null row, which the page labels rather
    // than hiding: "someone at the door" is a fact worth a row.
    const userRows = db.prepare(`
      SELECT actor_user_id AS user_id, users.display_name AS name, users.email AS email,
        COUNT(*) AS connections,
        SUM(CASE WHEN event IN (${LOGIN_FAILED_EVENTS}) THEN 1 ELSE 0 END) AS failed,
        COUNT(DISTINCT ip_address) AS addresses,
        MAX(activity_logs.created_at) AS last_seen,
        SUM(CASE WHEN event = 'auth.login' THEN 1 ELSE 0 END) AS m_password,
        SUM(CASE WHEN event = 'auth.passkey_login' THEN 1 ELSE 0 END) AS m_passkey,
        SUM(CASE WHEN event = 'auth.mfa_verified' THEN 1 ELSE 0 END) AS m_two_factor,
        SUM(CASE WHEN event = 'auth.device_link_approved' THEN 1 ELSE 0 END) AS m_device_link
      FROM activity_logs LEFT JOIN users ON users.id = activity_logs.actor_user_id
      WHERE ${where}
      GROUP BY actor_user_id ORDER BY connections DESC LIMIT 100
    `).all(params) as {
      user_id: string | null;
      name: string | null;
      email: string | null;
      connections: number;
      failed: number | null;
      addresses: number;
      last_seen: string;
      m_password: number | null;
      m_passkey: number | null;
      m_two_factor: number | null;
      m_device_link: number | null;
    }[];
    const users = userRows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      connections: row.connections,
      failed: row.failed ?? 0,
      addresses: row.addresses,
      lastSeen: row.last_seen,
      methods: {
        password: row.m_password ?? 0,
        passkey: row.m_passkey ?? 0,
        twoFactor: row.m_two_factor ?? 0,
        deviceLink: row.m_device_link ?? 0
      }
    }));

    // Devices still signed in FROM this scope — live sessions only, because the
    // question this panel answers is "what can still get in from there today",
    // not what once could.
    const sessionConditions = ["sessions.revoked_at IS NULL", "datetime(sessions.expires_at) > datetime('now')", "users.deleted_at IS NULL"];
    if (userId) sessionConditions.push("sessions.user_id = @userId");
    if (ipSet) sessionConditions.push(ipConditionFor("sessions.ip_address"));
    // Every live session, not a page of them: the client draws the type counters
    // (3 displays, 8 phones…) from this list, and a truncated list would count
    // wrong. A household's sessions number in the dozens; 500 is a backstop, not
    // an expectation.
    // The asking admin's own session is flagged so the client can pin it first
    // and withhold the revoke button — ending your own session is what sign-out
    // is for, and the DELETE route refuses it anyway.
    const currentHash = currentSessionHash(request) ?? "";
    const sessionRows = db.prepare(`
      SELECT sessions.id, sessions.label, sessions.device_name, sessions.ip_address AS ip, sessions.kind,
        sessions.last_seen_at AS last_seen, sessions.expires_at AS expires,
        (sessions.token_hash = @currentHash) AS current,
        users.display_name AS person, users.id AS person_id
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE ${sessionConditions.join(" AND ")}
      ORDER BY datetime(sessions.last_seen_at) DESC LIMIT 500
    `).all({ ...params, currentHash }) as {
      id: string;
      label: string | null;
      device_name: string | null;
      ip: string | null;
      kind: "browser" | "device";
      last_seen: string;
      expires: string;
      current: 0 | 1;
      person: string;
      person_id: string;
    }[];
    const devices = sessionRows.map((row) => ({
      id: row.id,
      name: row.label ?? describeUserAgent(row.device_name),
      agent: describeUserAgent(row.device_name),
      type: deviceType(row.device_name, row.kind),
      person: row.person,
      personId: row.person_id,
      ip: row.ip,
      lastSeen: row.last_seen,
      expiresAt: row.expires,
      current: row.current === 1
    }));

    // Names a stranger tried that belong to no account here — the guessing wordlist,
    // straight out of login_attempts. Meaningless for a person scope (attempt rows
    // carry emails, not user ids), so a person's page leaves it empty.
    let guessedNames: { email: string; attempts: number; lastSeen: string }[] = [];
    if (!userId) {
      const attemptConditions = [
        "successful = 0",
        "email IS NOT NULL",
        "datetime(created_at) >= datetime(@from)",
        "datetime(created_at) <= datetime(@to)",
        "email NOT IN (SELECT LOWER(email) FROM users)"
      ];
      if (ipSet) attemptConditions.push(ipConditionFor("ip_address"));
      guessedNames = (db.prepare(`
        SELECT email, COUNT(*) AS attempts, MAX(created_at) AS last_seen
        FROM login_attempts WHERE ${attemptConditions.join(" AND ")}
        GROUP BY email ORDER BY attempts DESC LIMIT 20
      `).all(params) as { email: string; attempts: number; last_seen: string }[]).map((row) => ({
        email: row.email,
        attempts: row.attempts,
        lastSeen: row.last_seen
      }));
    }

    // The raw tail of the story, newest first. Thirty is enough to read what has
    // been happening; the Logs page carries the full archive.
    const events = (db.prepare(`
      SELECT activity_logs.id, event, detail, ip_address AS ip, activity_logs.created_at, users.display_name AS actor
      FROM activity_logs LEFT JOIN users ON users.id = activity_logs.actor_user_id
      WHERE ${where}
      ORDER BY datetime(activity_logs.created_at) DESC, activity_logs.rowid DESC LIMIT 30
    `).all(params) as {
      id: string;
      event: string;
      detail: string;
      ip: string | null;
      created_at: string;
      actor: string | null;
    }[]).map((row) => ({
      id: row.id,
      event: row.event,
      detail: row.detail,
      ip: row.ip,
      at: row.created_at,
      actor: row.actor,
      failed: row.event === "auth.login_failed" || row.event === "auth.mfa_failed"
    }));

    return reply.send({
      from: params.from,
      to: params.to,
      scope,
      truncated,
      totals: {
        attempts: totalsRow.attempts,
        success: totalsRow.success ?? 0,
        failed: totalsRow.failed ?? 0,
        people: totalsRow.people,
        addresses: totalsRow.addresses,
        firstSeen: totalsRow.first_seen,
        lastSeen: totalsRow.last_seen
      },
      methods: {
        password: totalsRow.m_password ?? 0,
        passkey: totalsRow.m_passkey ?? 0,
        twoFactor: totalsRow.m_two_factor ?? 0,
        deviceLink: totalsRow.m_device_link ?? 0
      },
      series: { bucket, buckets, success: seriesSuccess, failed: seriesFailed },
      ips,
      users,
      devices,
      guessedNames,
      events
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
