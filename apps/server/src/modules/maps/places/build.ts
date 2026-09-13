// Building the places database from GeoNames (docs/map-approach-proposal.md,
// phase 2). The owner chose to build on each install rather than host a prebuilt
// file: nothing for the project to publish or keep fresh, at the cost of a larger
// one-time download.
//
// What is read, and why each:
//   cities500.zip          every populated place of 500+ people: name, point,
//                          country, region, population, kind (~14 MB)
//   admin1CodesASCII.txt   region names in English (~150 KB)
//   alternateNamesV2.zip   names in other languages, of which English and Russian
//                          are kept for the places above (~205 MB)
// Country names are not stored: Intl.DisplayNames gives them in any language.
//
// The zips are read as streams, never unpacked to disk — the alternate names alone
// are 750 MB extracted, and the whole point of this level is a small footprint.
// Downloads sit in Places/.build while the build runs and are deleted after,
// whether it succeeded or not. Measured on the real files: ~8 s to build, 27 MB kept.
//
// GeoNames is CC BY 4.0: wherever these names are shown, the credit goes too.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import yauzl from "yauzl";
import { fetchSafely, streamFromResponse } from "../../../core/safe-fetch.js";
import { NAME_LANGUAGES, PLACES_FORMAT, closePlaces, placesBuildDir, placesDir, placesFile, type NameLanguage } from "./dataset.js";

export function geonamesBase(): string {
  return (process.env.GEONAMES_URL ?? "https://download.geonames.org/export/dump").replace(/\/+$/, "");
}

const FILES = {
  cities: "cities500.zip",
  admin1: "admin1CodesASCII.txt",
  alternates: "alternateNamesV2.zip"
} as const;

/** Far above the real files (the largest is ~205 MB), and a hard stop on anything
 *  that is not them. */
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

export type BuildStage = "download" | "places" | "names" | "write";
export type BuildProgress = (stage: BuildStage, done: number, total: number) => void;

export interface BuildResult {
  places: number;
  regions: number;
  names: number;
  sizeBytes: number;
  sourceDate: string | null;
  /** Region names left in English because the translated one was untrustworthy. */
  regionNamesDistrusted: number;
}

async function download(file: string, dest: string, onBytes: (bytes: number) => void): Promise<string | null> {
  return fetchSafely(
    `${geonamesBase()}/${file}`,
    { timeoutMs: DOWNLOAD_TIMEOUT_MS, failureMessage: `GeoNames could not be reached for ${file}.` },
    async (response) => {
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`GeoNames answered ${response.status} for ${file}.`);
      }
      let bytes = 0;
      const counted = async function* () {
        for await (const chunk of streamFromResponse(response)) {
          bytes += chunk.byteLength;
          if (bytes > MAX_DOWNLOAD_BYTES) throw new Error(`${file} is far larger than GeoNames' file should be.`);
          onBytes(chunk.byteLength);
          yield chunk;
        }
      };
      await pipeline(Readable.from(counted()), fs.createWriteStream(dest));
      return response.headers.get("last-modified");
    }
  );
}

/** Every line of one text file inside a zip, without unpacking it. */
async function zipLines(zipPath: string, entryName: string, onLine: (line: string) => void): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, opened) => (err || !opened ? reject(err ?? new Error("Unreadable zip.")) : resolve(opened)));
  });
  try {
    const entry = await new Promise<yauzl.Entry>((resolve, reject) => {
      zip.on("entry", (candidate: yauzl.Entry) => (candidate.fileName === entryName ? resolve(candidate) : zip.readEntry()));
      zip.on("end", () => reject(new Error(`${path.basename(zipPath)} has no ${entryName}.`)));
      zip.on("error", reject);
      zip.readEntry();
    });
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      zip.openReadStream(entry, (err, opened) => (err || !opened ? reject(err ?? new Error("Unreadable entry.")) : resolve(opened)));
    });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) onLine(line);
  } finally {
    zip.close();
  }
}

// --- Region names -------------------------------------------------------------
//
// GeoNames' translated region names are mostly right and occasionally the name of
// the region's capital instead: Trentino-Alto Adige is "Больцано" (Bolzano) in
// Russian, Veneto is "Венеция" (Venice). Shown under a town in that region, the
// wrong one reads as fact. So a translated region name is distrusted when it is
// the translated name of a town in the region whose ENGLISH name does not match
// the region's English name — "Kandahar" region and "Kandahar" city agree in both
// languages and are kept; "Trentino-Alto Adige" and "Bolzano" do not. A distrusted
// name falls back to English. Measured on the real data: 30 of 2,427 Russian
// region names distrusted, ~5 of them genuinely wrong; the rest merely show their
// English spelling, which is a smaller cost than a wrong region.

// Accents left over by NFD, built from code points: an escape written into this
// file by a tool can arrive as the literal (invisible) characters instead.
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");

const GENERIC_WORDS = /\b(province|district|division|city|region|governorate|oblast|county|state|prefecture|department|municipality|parish|canton|voivodeship)\b/g;

function comparable(name: string): string {
  return name.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase().replace(GENERIC_WORDS, " ").replace(/[^a-z]/g, "");
}

function namesAgree(regionEnglish: string, placeEnglish: string): boolean {
  const region = comparable(regionEnglish);
  const place = comparable(placeEnglish);
  return place.length > 0 && region.length > 0 && (region.includes(place) || place.includes(region));
}

// --- The build ----------------------------------------------------------------

interface Candidate {
  name: string;
  score: number;
}

/**
 * Download the GeoNames files and build places.sqlite. The finished file replaces
 * any earlier one in a single rename, so a failed build never leaves the level
 * half-rebuilt: the old database keeps working until the new one is complete.
 */
export async function buildPlaces(progress: BuildProgress = () => {}): Promise<BuildResult> {
  const buildDir = placesBuildDir();
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  const temp = path.join(buildDir, "places.sqlite");
  // Held out here so the cleanup can close it: a build that fails mid-parse must
  // let go of its file, or on Windows the folder cannot be deleted — and that
  // deletion's EPERM would hide the error that actually stopped the build.
  let db: Database.Database | null = null;

  try {
    // 1. Download. Sizes are not known up front, so progress is in bytes seen.
    let downloaded = 0;
    const tick = (bytes: number) => {
      downloaded += bytes;
      progress("download", downloaded, 0);
    };
    const citiesZip = path.join(buildDir, FILES.cities);
    const admin1Txt = path.join(buildDir, FILES.admin1);
    const alternatesZip = path.join(buildDir, FILES.alternates);
    const sourceDate = await download(FILES.cities, citiesZip, tick);
    await download(FILES.admin1, admin1Txt, tick);
    await download(FILES.alternates, alternatesZip, tick);

    db = new Database(temp);
    db.pragma("journal_mode = OFF");
    db.pragma("synchronous = OFF");
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE places (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
        country TEXT NOT NULL, admin1 TEXT, population INTEGER NOT NULL, fcode TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE places_rtree USING rtree(id, min_lat, max_lat, min_lng, max_lng);
      CREATE TABLE regions (code TEXT PRIMARY KEY, id INTEGER NOT NULL, name TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE names (id INTEGER NOT NULL, lang TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (id, lang)) WITHOUT ROWID;
    `);

    // 2. Places. Region capitals are remembered for the region-name check below.
    const wanted = new Set<number>();
    const capitals = new Map<number, { region: string; english: string }>();
    const insertPlace = db.prepare("INSERT INTO places VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const insertBox = db.prepare("INSERT INTO places_rtree VALUES (?, ?, ?, ?, ?)");
    let places = 0;
    db.exec("BEGIN");
    await zipLines(citiesZip, "cities500.txt", (line) => {
      const c = line.split("\t");
      if (c.length < 15) return;
      const id = Number(c[0]);
      const lat = Number(c[4]);
      const lng = Number(c[5]);
      if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
      insertPlace.run(id, c[1], lat, lng, c[8], c[10] || null, Number(c[14]) || 0, c[7]);
      insertBox.run(id, lat, lat, lng, lng);
      wanted.add(id);
      if (c[7].startsWith("PPLA") && c[10]) capitals.set(id, { region: `${c[8]}.${c[10]}`, english: c[2] || c[1] });
      places += 1;
      if (places % 5000 === 0) progress("places", places, 0);
    });
    db.exec("COMMIT");
    progress("places", places, places);

    // 3. Regions, in English.
    const regionEnglish = new Map<number, { code: string; english: string }>();
    const insertRegion = db.prepare("INSERT OR REPLACE INTO regions VALUES (?, ?, ?)");
    db.exec("BEGIN");
    const regionLines = readline.createInterface({ input: fs.createReadStream(admin1Txt), crlfDelay: Infinity });
    for await (const line of regionLines) {
      const c = line.split("\t");
      if (c.length < 4) continue;
      const id = Number(c[3]);
      if (!Number.isFinite(id)) continue;
      insertRegion.run(c[0], id, c[1]);
      regionEnglish.set(id, { code: c[0], english: c[2] || c[1] });
      wanted.add(id);
    }
    db.exec("COMMIT");

    // 4. Names. Best per (id, language): a preferred name beats a plain one, and
    //    colloquial and historic names are never used.
    const best = new Map<string, Candidate>();
    const capitalNames = new Map<string, { name: string; english: string }[]>(); // `${region}|${lang}`
    let scanned = 0;
    await zipLines(alternatesZip, "alternateNamesV2.txt", (line) => {
      scanned += 1;
      if (scanned % 500_000 === 0) progress("names", scanned, 0);
      // Cheap reject before splitting: most of 19 million lines are other languages.
      const t1 = line.indexOf("\t");
      const t2 = line.indexOf("\t", t1 + 1);
      const t3 = line.indexOf("\t", t2 + 1);
      const lang = line.slice(t2 + 1, t3);
      if (!(NAME_LANGUAGES as readonly string[]).includes(lang)) return;
      const id = Number(line.slice(t1 + 1, t2));
      if (!wanted.has(id)) return;
      const c = line.split("\t");
      if (c[6] === "1" || c[7] === "1") return;
      const candidate = { name: c[3], score: (c[4] === "1" ? 2 : 0) + (c[5] === "1" ? 1 : 0) };
      const key = `${id}|${lang}`;
      const previous = best.get(key);
      if (!previous || candidate.score > previous.score) best.set(key, candidate);
      const capital = capitals.get(id);
      if (capital) {
        const bucket = `${capital.region}|${lang}`;
        const list = capitalNames.get(bucket) ?? [];
        list.push({ name: c[3], english: capital.english });
        capitalNames.set(bucket, list);
      }
    });
    progress("names", scanned, scanned);

    // 5. Write names, distrusting translated region names as described above.
    const insertName = db.prepare("INSERT INTO names VALUES (?, ?, ?)");
    let names = 0;
    let regionNamesDistrusted = 0;
    db.exec("BEGIN");
    for (const [key, candidate] of best) {
      const [idText, lang] = key.split("|") as [string, NameLanguage];
      const id = Number(idText);
      const region = regionEnglish.get(id);
      if (region && lang !== "en") {
        const clashes = (capitalNames.get(`${region.code}|${lang}`) ?? []).filter((capital) => capital.name === candidate.name);
        if (clashes.length > 0 && !clashes.some((capital) => namesAgree(region.english, capital.english))) {
          regionNamesDistrusted += 1;
          continue;
        }
      }
      insertName.run(id, lang, candidate.name);
      names += 1;
    }
    const setMeta = db.prepare("INSERT INTO meta VALUES (?, ?)");
    setMeta.run("format", String(PLACES_FORMAT));
    setMeta.run("built_at", new Date().toISOString());
    setMeta.run("source_date", sourceDate ? new Date(sourceDate).toISOString() : "");
    setMeta.run("places", String(places));
    db.exec("COMMIT");
    progress("write", 0, 1);
    db.exec("VACUUM");
    db.close();
    db = null;

    // 6. Swap it in. The reader lets go first: on Windows an open file cannot be
    //    replaced, and a reader holding the old one would keep answering from it.
    closePlaces();
    fs.mkdirSync(placesDir(), { recursive: true });
    fs.renameSync(temp, placesFile());
    progress("write", 1, 1);

    return {
      places,
      regions: regionEnglish.size,
      names,
      sizeBytes: fs.statSync(placesFile()).size,
      sourceDate: sourceDate ? new Date(sourceDate).toISOString() : null,
      regionNamesDistrusted
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
    try {
      fs.rmSync(buildDir, { recursive: true, force: true });
    } catch {
      // Leftovers are cleared by the next build's first step; never let tidying
      // up replace the error the caller needs to see.
    }
  }
}
