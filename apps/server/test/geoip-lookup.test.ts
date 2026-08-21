// Location lookups read a file on this disk and never call out. These pin the
// two rules that make that arrangement work: the folder is SCANNED (so someone
// can drop a database in without touching configuration), and a city-level
// database the owner supplied always beats the country one the app fetches.
//
// Fixtures are MaxMind's own test databases (MaxMind-DB, Apache-2.0), which know
// a handful of documentation ranges — small enough to commit, real enough to
// exercise the reader.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { geoipDirectory, geoipStatus, installGeoipDatabase, lookupLocation } from "../src/core/geoip.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "geoip");

let dir = "";

function install(fixture: string, as = fixture): void {
  fs.copyFileSync(path.join(FIXTURES, fixture), path.join(dir, as));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-geoip-"));
  process.env.GEOIP_PATH = dir;
});

afterEach(() => {
  delete process.env.GEOIP_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("geoipStatus", () => {
  it("reports nothing available, and where to put a database", () => {
    const status = geoipStatus();
    expect(status.available).toBe(false);
    expect(status.tier).toBeNull();
    expect(status.directory).toBe(geoipDirectory());
    expect(status.databases).toEqual([]);
  });

  it("finds a database by scanning, whatever it is called", () => {
    install("GeoIP2-Country-Test.mmdb", "whatever-the-owner-named-it.mmdb");
    const status = geoipStatus();
    expect(status.available).toBe(true);
    expect(status.tier).toBe("country");
    expect(status.databaseType).toBe("GeoIP2-Country");
    expect(status.databases[0].name).toBe("whatever-the-owner-named-it.mmdb");
  });

  it("prefers a city database over a country one, and says so", () => {
    install("GeoIP2-Country-Test.mmdb", "dbip-country-lite.mmdb");
    install("GeoIP2-City-Test.mmdb");
    const status = geoipStatus();
    expect(status.tier).toBe("city");
    expect(status.databases).toHaveLength(2);
    expect(status.databases[0].tier).toBe("city"); // the one in use is first
    expect(status.countryFilePresent).toBe(true);
  });

  it("ignores a file that is not a database rather than failing", () => {
    fs.writeFileSync(path.join(dir, "half-a-download.mmdb"), "not a database");
    install("GeoIP2-Country-Test.mmdb");
    const status = geoipStatus();
    expect(status.available).toBe(true);
    expect(status.databases).toHaveLength(1);
  });
});

describe("lookupLocation", () => {
  it("gives the country from a country database, and nothing finer", () => {
    install("GeoIP2-Country-Test.mmdb");
    const hit = lookupLocation("2.125.160.216");
    expect(hit?.code).toBe("GB");
    expect(hit?.city).toBeNull();
    expect(hit?.latitude).toBeNull();
  });

  it("gives city, region and coordinates once a city database is present", () => {
    install("GeoIP2-City-Test.mmdb");
    const hit = lookupLocation("2.125.160.216");
    expect(hit?.code).toBe("GB");
    expect(hit?.city).toBe("Boxford");
    expect(hit?.region).toBeTruthy();
    expect(typeof hit?.latitude).toBe("number");
    expect(typeof hit?.longitude).toBe("number");
  });

  it("never looks up an address inside the house", () => {
    install("GeoIP2-City-Test.mmdb");
    for (const ip of ["127.0.0.1", "192.168.1.20", "10.0.0.5", "::1"]) {
      expect(lookupLocation(ip)).toBeNull();
    }
  });

  it("answers null for an address the database doesn't know, and with no database at all", () => {
    expect(lookupLocation("203.0.113.9")).toBeNull();
    install("GeoIP2-City-Test.mmdb");
    expect(lookupLocation("203.0.113.9")).toBeNull();
  });

  it("picks up a database dropped in after the first lookup, with no restart", () => {
    expect(lookupLocation("2.125.160.216")).toBeNull();
    install("GeoIP2-City-Test.mmdb");
    expect(lookupLocation("2.125.160.216")?.city).toBe("Boxford");
  });
});

describe("installGeoipDatabase", () => {
  // Everything the owner hands over — an upload's temp file or a finished
  // download — goes through this. It has to accept what the vendors actually
  // ship (a .mmdb.gz), refuse what is not a database at all, and never leave a
  // rejected file where the next lookup would try to open it.
  const staging = () => path.join(dir, "incoming");

  it("installs a plain .mmdb and starts using it", async () => {
    fs.copyFileSync(path.join(FIXTURES, "GeoIP2-City-Test.mmdb"), staging());
    const result = await installGeoipDatabase(staging(), "dbip-city-lite-2026-08.mmdb", null);

    expect(result.ok).toBe(true);
    expect(result.installed).toMatchObject({ tier: "city", databaseType: "GeoIP2-City" });
    expect(result.installed?.name).toBe("dbip-city-lite-2026-08.mmdb");
    expect(fs.existsSync(staging())).toBe(false); // the source is consumed
    expect(lookupLocation("2.125.160.216")?.city).toBe("Boxford");
  });

  it("unpacks a .mmdb.gz, which is how every vendor ships one", async () => {
    const gz = zlib.gzipSync(fs.readFileSync(path.join(FIXTURES, "GeoIP2-Country-Test.mmdb")));
    fs.writeFileSync(staging(), gz);
    const result = await installGeoipDatabase(staging(), "dbip-country-lite-2026-08.mmdb.gz", null);

    expect(result.ok).toBe(true);
    expect(result.installed?.name).toBe("dbip-country-lite-2026-08.mmdb"); // .gz dropped
    expect(geoipStatus().tier).toBe("country");
  });

  it("refuses a file that is not a database, and leaves nothing behind", async () => {
    fs.writeFileSync(staging(), "this is an HTML error page, not a database");
    const result = await installGeoipDatabase(staging(), "dbip-city-lite.mmdb", null);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not an IP-location database/i);
    expect(fs.existsSync(staging())).toBe(false);
    // Nothing was installed, and nothing was staged for the next lookup to open.
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("keeps a supplied name from escaping the folder", async () => {
    fs.copyFileSync(path.join(FIXTURES, "GeoIP2-City-Test.mmdb"), staging());
    const result = await installGeoipDatabase(staging(), "../../etc/passwd", null);

    expect(result.ok).toBe(true);
    expect(result.installed?.name).toBe("passwd.mmdb");
    expect(fs.readdirSync(dir)).toEqual(["passwd.mmdb"]);
  });
});
