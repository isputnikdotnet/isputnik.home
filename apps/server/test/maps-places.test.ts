// Named places (docs/map-approach-proposal.md, phase 2): building the database
// from GeoNames, and naming a point from it.
//
// The fixtures are tiny hand-made GeoNames files, each row standing for a case the
// prototype against the real data turned up:
//  - Times Square is nearer Weehawken, NJ than Manhattan's point — population pull
//    has to name Manhattan.
//  - Central Minsk is nearest one of its own districts (PPLX) — a district is never
//    the answer.
//  - A village of 600 must still win when you stand in it, with a city of a million
//    12 km off.
//  - GeoNames calls Veneto "Венеция" and Trentino-Alto Adige "Больцано" in Russian
//    (their capitals' names) — distrusted, English instead. Kandahar region is
//    "Кандагар" in Russian and that is right — kept.
//  - Somewhere too far from anywhere is not named at all.
//  - GeoNames files the Paris arrondissements as towns: the Eiffel Tower is nearer
//    "Paris 16 Passy" than Paris's point, and must still be Paris. Cocoa Beach is a
//    town of its own, not a part of Cocoa, however alike the names.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ZipArchive } from "archiver";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db.js";
import { makeUser, resetDb } from "./helpers/seed.js";
import { bootApp } from "./helpers/boot.js";

// --- GeoNames stub ------------------------------------------------------------

const served = new Map<string, Buffer | Error>();
const requested: string[] = [];

vi.mock("../src/core/safe-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/safe-fetch.js")>();
  return {
    ...actual,
    fetchSafely: async <T>(url: string, _opts: unknown, consume: (response: never) => Promise<T>): Promise<T> => {
      requested.push(url.split("/").pop()!);
      const file = served.get(url.split("/").pop()!);
      if (file instanceof Error) throw file;
      const body = file ?? Buffer.alloc(0);
      return consume({
        ok: Boolean(file),
        status: file ? 200 : 404,
        headers: new Headers({ "last-modified": "Sat, 12 Sep 2026 01:56:16 GMT" }),
        body: undefined,
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length)
      } as never);
    }
  };
});

const { buildPlaces } = await import("../src/modules/maps/places/build.js");
const { placesFile, placesBuildDir, placesStatus, closePlaces } = await import("../src/modules/maps/places/dataset.js");
const { geoNamesNamer } = await import("../src/modules/maps/places/namer.js");
const { enqueuePlacesBuild, placesBuildStatus, waitForPlacesBuild } = await import("../src/modules/maps/places/job.js");
const { mapsPlugin } = await import("../src/modules/maps/index.js");
const { removePlaces } = await import("../src/modules/maps/places/dataset.js");
const { namesLanguageFor } = await import("../src/modules/maps/places/namer.js");
const { signInPlaceNames } = await import("../src/modules/dashboard/place-names.js");
const { ingestGalleryAsset } = await import("../src/modules/library/gallery/scanner.js");
const { getGalleryAsset } = await import("../src/modules/library/gallery/catalog-asset.js");
const { galleryFacets, queryGalleryPlaces, queryGalleryTimeline } = await import("../src/modules/library/gallery/catalog.js");
const { EMPTY_GALLERY_FILTERS } = await import("../src/modules/library/gallery/catalog-filters.js");
const { sweepPhotoPlaces, startPhotoPlaceNaming } = await import("../src/modules/library/gallery/places.js");

function zipOf(name: string, text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (chunk: Buffer) => chunks.push(chunk));
    out.on("end", () => resolve(Buffer.concat(chunks)));
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on("error", reject);
    archive.pipe(out);
    archive.append(text, { name });
    void archive.finalize();
  });
}

// id, name, asciiname, alternatenames, lat, lng, class, code, country, cc2, admin1, admin2, admin3, admin4, population, …
const city = (id: number, name: string, lat: number, lng: number, code: string, country: string, admin1: string, population: number) =>
  [id, name, name, "", lat, lng, "P", code, country, "", admin1, "", "", "", population, "", "", "", "2026-01-01"].join("\t");

const CITIES = [
  city(625144, "Minsk", 53.9, 27.56667, "PPLC", "BY", "04", 1742124),
  city(9000001, "Kastrychnitski District", 53.9004, 27.559, "PPLX", "BY", "04", 0),
  city(5125771, "Manhattan", 40.78343, -73.96625, "PPLA2", "US", "NY", 1487536),
  city(5106160, "Weehawken", 40.76954, -74.02042, "PPL", "US", "NJ", 14104),
  city(3181913, "Bolzano", 46.49067, 11.33982, "PPLA2", "IT", "17", 107436),
  city(3164603, "Venice", 45.43713, 12.33265, "PPLA", "IT", "20", 270816),
  city(3164527, "Verona", 45.43419, 10.99779, "PPLA2", "IT", "20", 257353),
  city(1138336, "Kandahar", 31.61332, 65.71013, "PPLA", "AF", "23", 391190),
  city(1138400, "Spin Boldak", 31.0, 66.4, "PPL", "AF", "23", 50000),
  city(9000010, "Tiny", 50.0, 10.0, "PPL", "DE", "02", 600),
  city(9000011, "Bigtown", 50.108, 10.0, "PPLA", "DE", "02", 1000000),
  city(2988507, "Paris", 48.85341, 2.3488, "PPLC", "FR", "11", 2138551),
  city(6618622, "Paris 16 Passy", 48.8637, 2.2769, "PPL", "FR", "11", 159386),
  city(4151871, "Cocoa", 28.38612, -80.74200, "PPL", "US", "FL", 17711),
  city(4151920, "Cocoa Beach", 28.32055, -80.60922, "PPL", "US", "FL", 11595)
].join("\n");

const ADMIN1 = [
  "BY.04\tMinsk City\tMinsk City\t625143",
  "US.NY\tNew York\tNew York\t5128638",
  "US.NJ\tNew Jersey\tNew Jersey\t5101760",
  "IT.17\tTrentino-Alto Adige\tTrentino-Alto Adige\t3165244",
  "IT.20\tVeneto\tVeneto\t3164604",
  "AF.23\tKandahar\tKandahar\t1138335",
  "DE.02\tBavaria\tBavaria\t2951839",
  "FR.11\tÎle-de-France\tIle-de-France\t3012874",
  "US.FL\tFlorida\tFlorida\t4155751"
].join("\n");

// altId, geonameid, lang, name, preferred, short, colloquial, historic
const alt = (id: number, lang: string, name: string, flags: Partial<Record<"preferred" | "colloquial" | "historic", boolean>> = {}) =>
  ["1", id, lang, name, flags.preferred ? "1" : "", "", flags.colloquial ? "1" : "", flags.historic ? "1" : "", "", ""].join("\t");

const ALTERNATES = [
  alt(625144, "ru", "Минск-город", { colloquial: true }),
  alt(625144, "ru", "Минск", { preferred: true }),
  alt(625144, "fr", "Minsk"),
  alt(625143, "ru", "Минск"),
  alt(5125771, "ru", "Манхэттен"),
  alt(5128638, "ru", "Нью-Йорк"),
  alt(3181913, "ru", "Больцано"),
  alt(3165244, "ru", "Больцано"),
  alt(3164603, "ru", "Венеция"),
  alt(3164604, "ru", "Венеция"),
  alt(3164527, "ru", "Верона"),
  alt(1138336, "ru", "Кандагар"),
  alt(1138335, "ru", "Кандагар")
].join("\n");

async function serveGeoNames() {
  served.clear();
  served.set("cities500.zip", await zipOf("cities500.txt", CITIES));
  served.set("admin1CodesASCII.txt", Buffer.from(ADMIN1));
  served.set("alternateNamesV2.zip", await zipOf("alternateNamesV2.txt", ALTERNATES));
}

let dataDir = "";

beforeEach(async () => {
  resetDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-places-"));
  process.env.MAP_DATA_PATH = dataDir;
  requested.length = 0;
  await serveGeoNames();
});

afterEach(() => {
  closePlaces();
  delete process.env.MAP_DATA_PATH;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// --- Building -----------------------------------------------------------------

describe("building the places database", () => {
  it("builds from the three GeoNames files, keeps nothing it downloaded, and says what it built", async () => {
    const result = await buildPlaces();
    expect(requested).toEqual(["cities500.zip", "admin1CodesASCII.txt", "alternateNamesV2.zip"]);
    expect(result.places).toBe(15);
    expect(result.regions).toBe(9);
    expect(result.regionNamesDistrusted).toBe(2);
    expect(fs.existsSync(placesFile())).toBe(true);
    expect(fs.existsSync(placesBuildDir())).toBe(false);
    expect(placesStatus()).toMatchObject({ present: true, places: 15, sourceDate: "2026-09-12T01:56:16.000Z" });
  });

  it("leaves the database it had when a rebuild fails, and nothing half-built", async () => {
    await buildPlaces();
    const before = fs.statSync(placesFile()).size;
    served.set("alternateNamesV2.zip", new Error("GeoNames could not be reached."));
    await expect(buildPlaces()).rejects.toThrow(/could not be reached/);
    expect(fs.statSync(placesFile()).size).toBe(before);
    expect(fs.existsSync(placesBuildDir())).toBe(false);
    expect(geoNamesNamer()).not.toBeNull();
  });

  it("refuses a zip that does not hold the file it should", async () => {
    served.set("cities500.zip", await zipOf("something-else.txt", CITIES));
    await expect(buildPlaces()).rejects.toThrow(/has no cities500\.txt/);
    expect(placesStatus().present).toBe(false);
  });
});

// --- Naming -------------------------------------------------------------------

describe("naming a point", () => {
  beforeEach(async () => {
    await buildPlaces();
  });

  const name = (lat: number, lng: number, language = "en") => {
    const namer = geoNamesNamer()!;
    const hit = namer.nearest(lat, lng);
    return hit ? { ...namer.describe(hit.id, language)!, km: hit.distanceKm } : null;
  };

  it("names Manhattan in Times Square, not Weehawken across the river", () => {
    expect(name(40.758, -73.9855)).toMatchObject({ place: "Manhattan", region: "New York", countryCode: "US" });
  });

  it("names the city, never one of its districts, even when the district is nearer", () => {
    expect(name(53.9005, 27.5592)?.place).toBe("Minsk");
  });

  it("names the village you are standing in over a big city 12 km away", () => {
    expect(name(50.0, 10.0)?.place).toBe("Tiny");
  });

  it("names the city for a point in one of its numbered parts, and leaves a lookalike town alone", () => {
    expect(name(48.8584, 2.2945)).toMatchObject({ place: "Paris", region: "Île-de-France", countryCode: "FR" });
    expect(name(28.32, -80.61)?.place).toBe("Cocoa Beach");
  });

  it("names nothing too far from anywhere", () => {
    expect(name(51.0, 10.0)).toBeNull();
  });

  it("speaks the reader's language, drops a region that only repeats the place, and never uses a colloquial name", () => {
    expect(name(53.9005, 27.5592, "ru")).toMatchObject({ place: "Минск", region: null, country: "Беларусь" });
    expect(name(53.9005, 27.5592, "en")).toMatchObject({ place: "Minsk", region: "Minsk City", country: "Belarus" });
  });

  it("shows a distrusted region in English rather than a wrong translation, and keeps a trustworthy one", () => {
    // Veneto is not "Венеция", Trentino-Alto Adige is not "Больцано".
    expect(name(45.43419, 10.99779, "ru")).toMatchObject({ place: "Верона", region: "Veneto", country: "Италия" });
    expect(name(46.49067, 11.33982, "ru")).toMatchObject({ place: "Больцано", region: "Trentino-Alto Adige" });
    // Kandahar region really is "Кандагар", and says so under another town in it.
    expect(name(31.0, 66.4, "ru")).toMatchObject({ place: "Spin Boldak", region: "Кандагар", country: "Афганистан" });
  });

  it("falls back to English for a language it has no names for", () => {
    expect(name(40.758, -73.9855, "de")).toMatchObject({ place: "Manhattan", country: "United States" });
  });
});

// --- The task and the routes --------------------------------------------------

describe("the build task", () => {
  it("runs once however many times it is asked for, and reports what it built", async () => {
    enqueuePlacesBuild("u1");
    enqueuePlacesBuild("u1");
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'BUILD_PLACES'").get() as { n: number }).n).toBe(1);
    await waitForPlacesBuild();
    expect(placesBuildStatus()).toMatchObject({ running: false, error: null });
    expect(placesStatus().present).toBe(true);
  });

  it("records a failure the page can show, and builds nothing", async () => {
    served.set("cities500.zip", new Error("GeoNames could not be reached for cities500.zip."));
    enqueuePlacesBuild(null);
    await waitForPlacesBuild();
    expect(placesBuildStatus().error).toMatch(/could not be reached/);
    expect(placesStatus().present).toBe(false);
  });
});

describe("sign-in places in the reader's language", () => {
  it("keeps the location database's words without named places, and names the town from its point with them", async () => {
    expect(signInPlaceNames("ru", undefined).town(53.9, 27.56667)).toBeNull();
    expect(signInPlaceNames("ru", undefined).country("BY", "Belarus")).toBe("Беларусь");

    await buildPlaces();
    expect(signInPlaceNames("ru", undefined).town(53.9, 27.56667)).toEqual({ place: "Минск", region: null });
    expect(signInPlaceNames(null, "en-GB").town(40.758, -73.9855)).toEqual({ place: "Manhattan", region: "New York" });
    // An IP location far from any named place is not forced onto one.
    expect(signInPlaceNames("en", undefined).town(51.0, 10.0)).toBeNull();
    expect(signInPlaceNames("en", undefined).town(null, null)).toBeNull();
  });

  it("keeps the town the location database named, translated, rather than swapping it for a nearer or bigger one", async () => {
    await buildPlaces();
    const names = signInPlaceNames("ru", undefined);
    // Standing in Times Square the rule for photos says Manhattan; a sign-in the
    // database placed in Weehawken stays Weehawken.
    expect(names.town(40.758, -73.9855, "Weehawken")?.place).toBe("Weehawken");
    // Its habit of adding the district in brackets does not stop the match.
    expect(names.town(53.9, 27.56, "Minsk (Tsentralny)")?.place).toBe("Минск");
    // A town the place names database does not know keeps its English name: no label.
    expect(names.town(53.9, 27.56, "Somewhere Else")).toBeNull();
  });
});

describe("which language names are spelled in", () => {
  it("takes the person's own choice, else their browser's, else English", () => {
    expect(namesLanguageFor("ru", "en-US,en;q=0.9")).toBe("ru");
    expect(namesLanguageFor(null, "ru-RU,ru;q=0.9,en;q=0.8")).toBe("ru");
    expect(namesLanguageFor(null, "de-DE,fr;q=0.9")).toBe("en");
    expect(namesLanguageFor(undefined, undefined)).toBe("en");
  });
});

// --- Photos -------------------------------------------------------------------

describe("naming photos", () => {
  let stopNaming: () => void;

  const photo = async (name: string, lat: number | null, lng: number | null) => {
    const id = (await ingestGalleryAsset("GAL", {
      absolutePath: `/src/GAL/${name}`, relativePath: name, fileName: name, extension: ".jpg", kind: "photo", size: 1000, modifiedAtMs: Date.now()
    }, false))!;
    db.prepare("UPDATE gallery_details SET gps_lat = ?, gps_lng = ? WHERE item_id = ?").run(lat, lng, id);
    return id;
  };
  const timeline = (places: string[]) =>
    queryGalleryTimeline("dad", ["GAL"], { q: "", kinds: [], limit: 50, offset: 0, filters: { ...EMPTY_GALLERY_FILTERS, places } })
      .assets.map((asset) => asset.id).sort();
  const named = () => db.prepare("SELECT COUNT(*) AS n FROM gallery_places").get() as { n: number };

  beforeEach(async () => {
    makeUser("dad", "admin");
    db.prepare("INSERT INTO libraries (id, name, type, source_path, created_by) VALUES ('GAL', 'GAL', 'gallery', '/src/GAL', 'dad')").run();
    stopNaming = startPhotoPlaceNaming();
  });

  afterEach(() => {
    stopNaming();
  });

  it("names nothing while there is no database, then every photo with a pin once there is", async () => {
    const minsk = await photo("minsk.jpg", 53.9005, 27.5592);
    const nowhere = await photo("nowhere.jpg", 51.0, 10.0);
    const unpinned = await photo("plain.jpg", null, null);
    expect(await sweepPhotoPlaces()).toBe(0);

    await buildPlaces();
    expect(await sweepPhotoPlaces()).toBe(2);
    expect(await sweepPhotoPlaces()).toBe(0); // nothing left to do
    expect(getGalleryAsset("dad", ["GAL"], minsk, "ru")).toMatchObject({ place: { id: 625144 }, placeLabel: { place: "Минск", country: "Беларусь" } });
    expect(getGalleryAsset("dad", ["GAL"], minsk, "en")?.placeLabel).toMatchObject({ place: "Minsk", region: "Minsk City" });
    expect(getGalleryAsset("dad", ["GAL"], nowhere, "en")).toMatchObject({ place: null, placeLabel: null });
    expect(getGalleryAsset("dad", ["GAL"], unpinned, "en")).toMatchObject({ place: null, placeLabel: null });
  });

  it("names a photo on the spot when its read comes before the sweep", async () => {
    await buildPlaces();
    const manhattan = await photo("nyc.jpg", 40.758, -73.9855);
    expect(getGalleryAsset("dad", ["GAL"], manhattan, "en")?.placeLabel).toMatchObject({ place: "Manhattan" });
  });

  it("filters and offers places in the viewer's language, and a moved pin leaves its old place at once", async () => {
    await buildPlaces();
    const a = await photo("a.jpg", 53.9005, 27.5592);
    const b = await photo("b.jpg", 53.9, 27.56);
    const c = await photo("c.jpg", 40.758, -73.9855);
    await sweepPhotoPlaces();

    expect(galleryFacets(["GAL"], "ru").places).toEqual([
      { id: 625144, name: "Минск", region: null, country: "Беларусь", count: 2 },
      { id: 5125771, name: "Манхэттен", region: "Нью-Йорк", country: new Intl.DisplayNames(["ru"], { type: "region" }).of("US"), count: 1 }
    ]);
    expect(timeline(["625144"])).toEqual([a, b].sort());
    expect(timeline(["625144", "5125771"])).toHaveLength(3);

    db.prepare("UPDATE gallery_details SET gps_lat = 45.43419, gps_lng = 10.99779 WHERE item_id = ?").run(b);
    expect(timeline(["625144"])).toEqual([a]);
    await sweepPhotoPlaces();
    expect(timeline(["3164527"])).toEqual([b]);
    expect(timeline([])).toContain(c);
  });

  it("lists the places for the Places view, most photographed first, each with a cover from that place", async () => {
    expect(queryGalleryPlaces("dad", ["GAL"], "en").places).toEqual([]);
    await buildPlaces();
    await photo("a.jpg", 53.9005, 27.5592);
    const newest = await photo("b.jpg", 53.9, 27.56);
    db.prepare("UPDATE gallery_details SET taken_at = '2030-01-01T00:00:00.000Z' WHERE item_id = ?").run(newest);
    await photo("c.jpg", 40.758, -73.9855);
    await sweepPhotoPlaces();

    const { places } = queryGalleryPlaces("dad", ["GAL"], "ru");
    expect(places.map((place) => [place.name, place.countryCode, place.count])).toEqual([["Минск", "BY", 2], ["Манхэттен", "US", 1]]);
    expect(places[0].cover).not.toBeNull();
    // Nothing in scope, nothing listed.
    expect(queryGalleryPlaces("dad", [], "ru").places).toEqual([]);
  });

  it("names again after a rebuild, and forgets every name when the database is removed", async () => {
    await buildPlaces();
    await photo("a.jpg", 53.9005, 27.5592);
    await photo("b.jpg", 40.758, -73.9855);
    await sweepPhotoPlaces();
    db.prepare("UPDATE gallery_places SET dataset = 'an older build'").run();
    expect(await sweepPhotoPlaces()).toBe(2);

    removePlaces();
    expect(named().n).toBe(0);
    expect(galleryFacets(["GAL"], "en").places).toEqual([]);
  });

  it("forgets the name of a photo whose pin was cleared", async () => {
    await buildPlaces();
    const a = await photo("a.jpg", 53.9005, 27.5592);
    await sweepPhotoPlaces();
    db.prepare("UPDATE gallery_details SET gps_lat = NULL, gps_lng = NULL WHERE item_id = ?").run(a);
    await sweepPhotoPlaces();
    expect(named().n).toBe(0);
  });
});

describe("the places routes", () => {
  let app: FastifyInstance;
  let signIn: (userId: string) => Promise<string>;

  beforeEach(async () => {
    makeUser("dad", "admin");
    makeUser("kid");
    ({ app, signIn } = await bootApp({ plugins: [mapsPlugin] }));
  });

  afterEach(async () => {
    await app.close();
  });

  it("keeps building and removing to admins", async () => {
    const kid = await signIn("kid");
    expect((await app.inject({ method: "POST", url: "/api/map/places", headers: { cookie: kid } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/api/map/places", headers: { cookie: kid } })).statusCode).toBe(403);
  });

  it("queues a build, refuses removal while it runs, then removes and says what that freed", async () => {
    const cookie = await signIn("dad");
    const queued = await app.inject({ method: "POST", url: "/api/map/places", headers: { cookie } });
    expect(queued.json().places.build.running).toBe(true);
    expect((await app.inject({ method: "DELETE", url: "/api/map/places", headers: { cookie } })).statusCode).toBe(409);

    await waitForPlacesBuild();
    const settings = await app.inject({ method: "GET", url: "/api/map/settings", headers: { cookie } });
    expect(settings.json().places).toMatchObject({ present: true, places: 15, build: { running: false } });

    const removed = await app.inject({ method: "DELETE", url: "/api/map/places", headers: { cookie } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().freedBytes).toBeGreaterThan(0);
    expect(removed.json().places.present).toBe(false);
    expect(fs.existsSync(placesFile())).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE event = 'maps.places_removed'").get() as { n: number }).n).toBe(1);
  });
});
