// The sign-in location databases live in the Map data room (Map data/Locations),
// and the ones from before — `<data>/geoip`, the Docker image's /config/geoip —
// are brought in on boot. What must hold: a house keeps the databases it had
// without doing anything; nothing the owner supplied is overwritten; a GEOIP_PATH
// someone set still wins; and the room's move task carries the databases too.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { geoipDirectory, geoipStatus, legacyGeoipDirectory, lookupLocation } from "../src/core/geoip.js";
import { mapsPlugin } from "../src/modules/maps/index.js";
import { MAP_DATA_FOLDERS, locationsDir } from "../src/modules/maps/storage.js";
import { resetDb } from "./helpers/seed.js";
import { bootApp } from "./helpers/boot.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "geoip");

let mapData = "";
let app: FastifyInstance | null = null;

const legacy = () => legacyGeoipDirectory();
const putLegacy = (fixture: string, as = fixture) => {
  fs.mkdirSync(legacy(), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, fixture), path.join(legacy(), as));
};
const boot = async () => {
  ({ app } = await bootApp({ plugins: [mapsPlugin] }));
};

beforeEach(() => {
  resetDb();
  mapData = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-mapdata-"));
  process.env.MAP_DATA_PATH = mapData;
});

afterEach(async () => {
  await app?.close();
  app = null;
  delete process.env.MAP_DATA_PATH;
  delete process.env.GEOIP_PATH;
  fs.rmSync(mapData, { recursive: true, force: true });
  fs.rmSync(legacy(), { recursive: true, force: true });
});

describe("the location databases in the Map data room", () => {
  it("brings the old folder's databases in on boot, clears its leftovers, and reads them from there", async () => {
    putLegacy("GeoIP2-Country-Test.mmdb", "dbip-country-lite.mmdb");
    putLegacy("GeoIP2-City-Test.mmdb", "owner-city.mmdb");
    fs.writeFileSync(path.join(legacy(), ".download-123-456"), "half a file");

    await boot();

    expect(geoipDirectory()).toBe(path.join(mapData, "Locations"));
    expect(fs.readdirSync(locationsDir()).sort()).toEqual(["dbip-country-lite.mmdb", "owner-city.mmdb"]);
    expect(fs.existsSync(legacy())).toBe(false);
    const status = geoipStatus();
    expect(status.directory).toBe(locationsDir());
    expect(status.databases.map((database) => database.name)).toEqual(["owner-city.mmdb", "dbip-country-lite.mmdb"]);
    expect(lookupLocation("2.125.160.216")?.city).toBe("Boxford");
  });

  it("never overwrites a different database of the same name, and leaves the old one where it was", async () => {
    putLegacy("GeoIP2-City-Test.mmdb", "db.mmdb");
    fs.mkdirSync(locationsDir(), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, "GeoIP2-Country-Test.mmdb"), path.join(locationsDir(), "db.mmdb"));

    await boot();

    expect(geoipStatus().databases).toEqual([expect.objectContaining({ name: "db.mmdb", tier: "country" })]);
    expect(fs.existsSync(path.join(legacy(), "db.mmdb"))).toBe(true);
  });

  it("drops the old copy when the same database already arrived", async () => {
    putLegacy("GeoIP2-Country-Test.mmdb", "dbip-country-lite.mmdb");
    fs.mkdirSync(locationsDir(), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, "GeoIP2-Country-Test.mmdb"), path.join(locationsDir(), "dbip-country-lite.mmdb"));

    await boot();

    expect(fs.existsSync(legacy())).toBe(false);
    expect(geoipStatus().databases).toHaveLength(1);
  });

  it("leaves a GEOIP_PATH someone set alone, and reads from it", async () => {
    const chosen = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-chosen-geoip-"));
    try {
      process.env.GEOIP_PATH = chosen;
      putLegacy("GeoIP2-Country-Test.mmdb");
      await boot();
      expect(geoipDirectory()).toBe(chosen);
      expect(fs.existsSync(path.join(legacy(), "GeoIP2-Country-Test.mmdb"))).toBe(true);
      expect(fs.existsSync(locationsDir())).toBe(false);
    } finally {
      fs.rmSync(chosen, { recursive: true, force: true });
    }
  });

  it("is part of what the room's move carries", () => {
    expect(MAP_DATA_FOLDERS).toContain("Locations");
  });
});
