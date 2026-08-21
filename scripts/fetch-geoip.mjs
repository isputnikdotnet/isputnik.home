// Fetches the DB-IP Country Lite database into data/geoip/, which is what the
// control panel's Locations page reads to say where a sign-in came from.
//
// The file is about 9 MB unpacked (a 4 MB download), country granularity, and is
// published monthly under CC BY 4.0 — no account, no API key. It deliberately
// does NOT live in the image: GeoIP data goes stale within months, so it belongs
// in the data volume where it can be replaced without a new release. An admin can
// also fetch it from the Locations page; this script is the same download for
// developers and for anyone who would rather do it from a shell.
//
// Usage:  node scripts/fetch-geoip.mjs [--dest <dir>] [--force]
// Env:    GEOIP_URL_BASE overrides the source (mirrors, air-gapped installs).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const FILE_NAME = "dbip-country-lite.mmdb";
const BASE = process.env.GEOIP_URL_BASE ?? "https://download.db-ip.com/free";
const MIN_BYTES = 1_000_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { dest: path.join(repoRoot, "data", "geoip"), force: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dest") {
      const value = argv[i + 1];
      if (!value) throw new Error("--dest needs a directory");
      args.dest = path.resolve(value);
      i += 1;
    } else if (argv[i] === "--force") {
      args.force = true;
    }
  }
  return args;
}

/** This month's file, and last month's — the new one appears a few days in. */
function candidateUrls(now = new Date()) {
  const stamp = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [`${BASE}/dbip-country-lite-${stamp(now)}.mmdb.gz`, `${BASE}/dbip-country-lite-${stamp(previous)}.mmdb.gz`];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = path.join(args.dest, FILE_NAME);

  if (!args.force && fs.existsSync(target)) {
    const stat = fs.statSync(target);
    const age = Math.round((Date.now() - stat.mtimeMs) / 86_400_000);
    console.log(`${target} already exists (${(stat.size / 1_048_576).toFixed(1)} MB, ${age} days old). Use --force to replace it.`);
    return;
  }

  fs.mkdirSync(args.dest, { recursive: true });
  const errors = [];

  for (const url of candidateUrls()) {
    process.stdout.write(`Fetching ${url} … `);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.log(`HTTP ${response.status}`);
        errors.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      const mmdb = zlib.gunzipSync(Buffer.from(await response.arrayBuffer()));
      if (mmdb.byteLength < MIN_BYTES) {
        console.log("too small");
        errors.push(`${url}: ${mmdb.byteLength} bytes is too small to be the database`);
        continue;
      }
      const temp = `${target}.download`;
      fs.writeFileSync(temp, mmdb);
      fs.renameSync(temp, target);
      console.log(`done (${(mmdb.byteLength / 1_048_576).toFixed(1)} MB)`);
      console.log(`Wrote ${target}`);
      console.log("Data © DB-IP.com, licensed CC BY 4.0 — the About page carries the attribution.");
      return;
    } catch (err) {
      console.log("failed");
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.error("Could not fetch the database:");
  for (const line of errors) console.error(`  ${line}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
