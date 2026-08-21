import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { FastifyRequest } from "fastify";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Reader, type CityResponse, type CountryResponse } from "maxmind";
import { fetchSafely, streamFromResponse } from "./safe-fetch.js";
import { config } from "../config.js";
import { isPrivateIp } from "./cidr.js";
import { logActivity } from "../db.js";

// Where a connection came from, answered from a file on this disk. A lookup is a
// binary search in bytes already in memory, so nothing about an address is ever
// sent anywhere to draw the Locations page. The only outbound call in this file
// is downloading the database, which an admin asks for by name.
//
// TWO tiers, and the second one is entirely optional:
//
//   country  DB-IP Country Lite, ~9 MB, fetched by the app itself (CC BY 4.0,
//            no account, no key). Enough to say which country a sign-in came
//            from, which is what makes a strange sign-in look strange.
//   city     any city-level database the owner downloads themselves and drops in
//            the same folder — DB-IP City Lite, MaxMind GeoLite2-City, whatever
//            their licence terms suit. Adds region, city and coordinates.
//
// The folder is scanned rather than a fixed filename being required, because the
// point is that someone can drop a file in without editing configuration; a city
// database wins when one is present. Nothing here downloads the city tier: those
// files are 70–400 MB and their licences differ, so that stays the owner's call.

const COUNTRY_FILE = "dbip-country-lite.mmdb";
const DOWNLOAD_BASE = process.env.GEOIP_URL_BASE ?? "https://download.db-ip.com/free";

export type GeoipTier = "city" | "country";

export interface GeoipDatabase {
  file: string;
  name: string;
  tier: GeoipTier;
  databaseType: string;
  buildDate: string | null;
  sizeBytes: number;
  updatedAt: string;
}

export interface GeoipStatus {
  available: boolean;
  /** Which tier is in use — "city" only when the owner supplied one. */
  tier: GeoipTier | null;
  databaseType: string | null;
  buildDate: string | null;
  updatedAt: string | null;
  sizeBytes: number | null;
  /** Where to put a database by hand. Shown in the UI, so it must be the real path. */
  directory: string;
  /** Every .mmdb found there, so the page can say what it is ignoring and why. */
  databases: GeoipDatabase[];
  /** Whether the country tier this app can fetch itself is present. */
  countryFilePresent: boolean;
  source: string;
}

export function geoipDirectory(): string {
  if (process.env.GEOIP_PATH) return process.env.GEOIP_PATH;
  return path.join(path.dirname(path.dirname(config.dbPath)), "geoip");
}

function listDatabases(): GeoipDatabase[] {
  const dir = geoipDirectory();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".mmdb"));
  } catch {
    return [];
  }

  const found: GeoipDatabase[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      const reader = new Reader<CityResponse>(fs.readFileSync(file));
      const meta = reader.metadata;
      const databaseType = meta?.databaseType ?? "Unknown";
      found.push({
        file,
        name,
        tier: /city/i.test(databaseType) ? "city" : "country",
        databaseType,
        buildDate: meta?.buildEpoch instanceof Date ? meta.buildEpoch.toISOString() : null,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString()
      });
    } catch {
      // A partial download or an unrelated file: skipped rather than announced.
    }
  }
  // City first, then the newest build — the richest database wins.
  return found.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "city" ? -1 : 1;
    return (b.buildDate ?? b.updatedAt).localeCompare(a.buildDate ?? a.updatedAt);
  });
}

let reader: Reader<CityResponse> | null = null;
let readerFile = "";
let readerMtime = 0;
let readerTier: GeoipTier = "country";

function activeDatabase(): GeoipDatabase | null {
  return listDatabases()[0] ?? null;
}

function getReader(): { reader: Reader<CityResponse>; tier: GeoipTier } | null {
  const active = activeDatabase();
  if (!active) {
    reader = null;
    return null;
  }
  const mtime = Date.parse(active.updatedAt);
  if (reader && active.file === readerFile && mtime === readerMtime) return { reader, tier: readerTier };
  try {
    reader = new Reader<CityResponse>(fs.readFileSync(active.file));
    readerFile = active.file;
    readerMtime = mtime;
    readerTier = active.tier;
    return { reader, tier: active.tier };
  } catch {
    reader = null;
    return null;
  }
}

export function geoipStatus(): GeoipStatus {
  const databases = listDatabases();
  const active = databases[0] ?? null;
  return {
    available: Boolean(active),
    tier: active?.tier ?? null,
    databaseType: active?.databaseType ?? null,
    buildDate: active?.buildDate ?? null,
    updatedAt: active?.updatedAt ?? null,
    sizeBytes: active?.sizeBytes ?? null,
    directory: geoipDirectory(),
    databases,
    countryFilePresent: databases.some((entry) => path.basename(entry.file) === COUNTRY_FILE),
    source: "DB-IP Country Lite (CC BY 4.0), or any city database you supply"
  };
}

export interface GeoipHit {
  code: string;
  name: string | null;
  /** City tier only — null on a country database. */
  city: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
}

// A private address has no country and never will: the answer is "this house",
// which the caller renders itself rather than pretending it is a place on a map.
export function lookupLocation(ip: string | null | undefined): GeoipHit | null {
  if (!ip || isPrivateIp(ip)) return null;
  const active = getReader();
  if (!active) return null;
  try {
    const found = active.reader.get(ip) as (CityResponse & CountryResponse) | null;
    const code = found?.country?.iso_code ?? found?.registered_country?.iso_code ?? null;
    if (!code) return null;
    return {
      code,
      name: found?.country?.names?.en ?? found?.registered_country?.names?.en ?? null,
      city: active.tier === "city" ? found?.city?.names?.en ?? null : null,
      region: active.tier === "city" ? found?.subdivisions?.[0]?.names?.en ?? null : null,
      latitude: active.tier === "city" ? found?.location?.latitude ?? null : null,
      longitude: active.tier === "city" ? found?.location?.longitude ?? null : null
    };
  } catch {
    return null;
  }
}

// Anything arriving from outside — a pasted URL or an uploaded file — lands here.
// Three rules, in order: gunzip if it is gzipped (every vendor ships .mmdb.gz),
// prove it parses as a database before it is allowed near the folder, and only
// then move it into place. A file that is not a database never becomes one that
// the next lookup tries to open.
const GZIP_MAGIC = [0x1f, 0x8b];
/** Big enough for DB-IP City Lite unpacked (~400 MB), small enough to refuse a disk. */
export const MAX_DATABASE_BYTES = 700 * 1024 * 1024;

function safeDatabaseName(name: string): string {
  const base = path.basename(name).replace(/.gz$/i, "");
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "-");
  return cleaned.toLowerCase().endsWith(".mmdb") ? cleaned : `${cleaned || "database"}.mmdb`;
}

export interface InstallResult {
  ok: boolean;
  status: GeoipStatus;
  installed?: { name: string; tier: GeoipTier; databaseType: string; sizeBytes: number };
  error?: string;
}

function finishInstall(staged: string, sourcePath: string, suggestedName: string, actorUserId: string | null): InstallResult {
  try {
    const bytes = fs.readFileSync(staged);
    let databaseType: string;
    try {
      databaseType = new Reader<CityResponse>(bytes).metadata?.databaseType ?? "Unknown";
    } catch {
      throw new Error("That file is not an IP-location database (.mmdb).");
    }

    const name = safeDatabaseName(suggestedName);
    const target = path.join(geoipDirectory(), name);
    fs.renameSync(staged, target);
    fs.rmSync(sourcePath, { force: true });
    reader = null;

    const tier: GeoipTier = /city/i.test(databaseType) ? "city" : "country";
    logActivity({
      event: "security.geoip_updated",
      actorUserId,
      detail: `Installed the location database "${name}" (${databaseType}, ${(bytes.byteLength / 1_048_576).toFixed(1)} MB).`
    });
    return {
      ok: true,
      status: geoipStatus(),
      installed: { name, tier, databaseType, sizeBytes: bytes.byteLength }
    };
  } catch (err) {
    fs.rmSync(staged, { force: true });
    fs.rmSync(sourcePath, { force: true });
    return { ok: false, status: geoipStatus(), error: err instanceof Error ? err.message : "The file could not be installed." };
  }
}

/**
 * Installs a database from a file already on disk — an upload's temp file, or a
 * finished download. The source is consumed either way: moved into place, or
 * deleted when it turns out not to be a database.
 */
export async function installGeoipDatabase(
  sourcePath: string,
  suggestedName: string,
  actorUserId: string | null
): Promise<InstallResult> {
  const dir = geoipDirectory();
  fs.mkdirSync(dir, { recursive: true });
  const staged = path.join(dir, `.incoming-${process.pid}-${Date.now()}.mmdb`);

  try {
    const head = Buffer.alloc(2);
    const handle = await fs.promises.open(sourcePath, "r");
    try {
      await handle.read(head, 0, 2, 0);
    } finally {
      await handle.close();
    }

    if (head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1]) {
      await pipeline(fs.createReadStream(sourcePath), zlib.createGunzip(), fs.createWriteStream(staged));
    } else {
      await fs.promises.copyFile(sourcePath, staged);
    }
    return finishInstall(staged, sourcePath, suggestedName, actorUserId);
  } catch (err) {
    fs.rmSync(staged, { force: true });
    fs.rmSync(sourcePath, { force: true });
    return { ok: false, status: geoipStatus(), error: err instanceof Error ? err.message : "The file could not be read." };
  }
}

// The upload half of the same job. Multipart handling is done here rather than
// through the library's upload helpers because the policy is different in kind:
// what makes this file acceptable is not its extension but whether it parses as a
// database, which installGeoipDatabase decides after the bytes have landed.
export async function receiveGeoipUpload(
  request: FastifyRequest
): Promise<{ tmpPath: string; filename: string }> {
  if (!request.isMultipart()) {
    throw new Error("Expected a multipart/form-data upload.");
  }
  const part = await request.file({ limits: { fileSize: MAX_DATABASE_BYTES } });
  if (!part) {
    throw new Error("No file was uploaded.");
  }

  const dir = geoipDirectory();
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.upload-${process.pid}-${Date.now()}`);

  try {
    await pipeline(part.file, fs.createWriteStream(temp));
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err instanceof Error ? err : new Error("The upload failed.");
  }

  if (part.file.truncated) {
    fs.rmSync(temp, { force: true });
    throw new Error("That file is larger than this server will accept.");
  }

  return { tmpPath: temp, filename: part.filename || "database.mmdb" };
}

// A database the owner points us at. The URL is theirs, so it goes through the
// same SSRF-pinned fetch every other outbound request uses — an admin pasting a
// link must not become a way to make this server talk to its own network.
export async function downloadGeoipFromUrl(url: string, actorUserId: string | null): Promise<InstallResult> {
  const dir = geoipDirectory();
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.download-${process.pid}-${Date.now()}`);

  try {
    const suggested = await fetchSafely(
      url,
      { timeoutMs: 600_000, failureMessage: "The download failed." },
      async (response) => {
        if (!response.ok) throw new Error(`The download failed (HTTP ${response.status}).`);
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > MAX_DATABASE_BYTES) throw new Error("That file is larger than this server will accept.");

        let total = 0;
        await pipeline(
          Readable.from(
            (async function* () {
              for await (const chunk of streamFromResponse(response)) {
                total += chunk.byteLength;
                if (total > MAX_DATABASE_BYTES) throw new Error("That file is larger than this server will accept.");
                yield chunk;
              }
            })()
          ),
          fs.createWriteStream(temp)
        );
        return path.basename(new URL(url).pathname) || "database.mmdb";
      }
    );

    return await installGeoipDatabase(temp, suggested, actorUserId);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    return { ok: false, status: geoipStatus(), error: err instanceof Error ? err.message : "The download failed." };
  }
}

/** The month DB-IP publishes under, and the one before it as a fallback. */
function candidateUrls(now: Date): string[] {
  const stamp = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [
    `${DOWNLOAD_BASE}/dbip-country-lite-${stamp(now)}.mmdb.gz`,
    `${DOWNLOAD_BASE}/dbip-country-lite-${stamp(previous)}.mmdb.gz`
  ];
}

export interface GeoipDownload {
  ok: boolean;
  status: GeoipStatus;
  url?: string;
  error?: string;
}

// Fetch the country tier. Written to a temp file and renamed, so a half-finished
// download never replaces a working database; the reader reopens on the next
// lookup because the file's mtime changed.
export async function downloadGeoip(actorUserId: string | null): Promise<GeoipDownload> {
  const target = path.join(geoipDirectory(), COUNTRY_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let lastError = "The download failed.";
  for (const url of candidateUrls(new Date())) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) {
        lastError = `${url.split("/").pop()} — HTTP ${response.status}`;
        continue;
      }
      const mmdb = zlib.gunzipSync(Buffer.from(await response.arrayBuffer()));
      // A country database is several megabytes; anything tiny is an error page.
      if (mmdb.byteLength < 1_000_000) {
        lastError = "The downloaded file is too small to be the database.";
        continue;
      }
      const temp = `${target}.download`;
      fs.writeFileSync(temp, mmdb);
      fs.renameSync(temp, target);
      reader = null;

      logActivity({
        event: "security.geoip_updated",
        actorUserId,
        detail: `Downloaded the DB-IP Country Lite database (${(mmdb.byteLength / 1_048_576).toFixed(1)} MB).`
      });
      return { ok: true, status: geoipStatus(), url };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return { ok: false, status: geoipStatus(), error: lastError };
}
