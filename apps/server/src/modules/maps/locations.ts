// The sign-in location databases, in the Map data room (docs/map-approach-proposal.md,
// "Storage — a new room"). core/geoip.ts reads and installs them; this file only
// says where they live, and brings in the ones from before they lived here.
//
// Until 4.5 they sat in `<data>/geoip` (the Docker image's /config/geoip). On boot
// whatever .mmdb is still there moves into Map data/Locations, once, so a house
// that fetched the country database or supplied a city one keeps it without
// noticing. A GEOIP_PATH someone set is left alone: they chose that folder.
import fs from "node:fs";
import path from "node:path";
import { legacyGeoipDirectory } from "../../core/geoip.js";
import { locationsDir } from "./storage.js";

export interface AdoptResult {
  moved: string[];
  /** Left where they were: a file of that name, but a different one, is already
   *  in the room. Nothing is overwritten on the owner's behalf. */
  kept: string[];
  from: string;
  to: string;
}

/** Move one file, across disks if it has to: a copy under a temporary name that
 *  only becomes the real one once it is whole, then the original goes. */
function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  const temp = `${to}.moving`;
  fs.copyFileSync(from, temp);
  if (fs.statSync(temp).size !== fs.statSync(from).size) {
    fs.rmSync(temp, { force: true });
    throw new Error(`${path.basename(from)} did not copy whole.`);
  }
  fs.renameSync(temp, to);
  fs.rmSync(from, { force: true });
}

/** Bring `<data>/geoip` into the room. Null when there was nothing to do.
 *  Synchronous, and run before the server listens: a lookup mid-move would find
 *  no database and place a sign-in nowhere. */
export function adoptLegacyGeoipFolder(): AdoptResult | null {
  if (process.env.GEOIP_PATH) return null;
  const from = legacyGeoipDirectory();
  const to = locationsDir();
  if (path.resolve(from) === path.resolve(to)) return null;

  let names: string[];
  try {
    names = fs.readdirSync(from).filter((name) => name.toLowerCase().endsWith(".mmdb"));
  } catch {
    return null;
  }

  const result: AdoptResult = { moved: [], kept: [], from, to };
  if (names.length > 0) fs.mkdirSync(to, { recursive: true });
  for (const name of names) {
    const source = path.join(from, name);
    const target = path.join(to, name);
    if (fs.existsSync(target)) {
      // The same database already arrived (a move that stopped half way): drop the
      // leftover. A different file of that name stays put for the owner to decide.
      if (fs.statSync(target).size === fs.statSync(source).size) {
        fs.rmSync(source, { force: true });
        result.moved.push(name);
      } else {
        result.kept.push(name);
      }
      continue;
    }
    moveFile(source, target);
    result.moved.push(name);
  }

  // The old folder goes once nothing is left in it (a download's leftovers count
  // as nothing: they are only ever half a file).
  try {
    for (const name of fs.readdirSync(from)) {
      if (/^[.](incoming|upload|download)-/.test(name) || name.endsWith(".download")) fs.rmSync(path.join(from, name), { force: true });
    }
    fs.rmdirSync(from);
  } catch {
    // Not empty, or not ours to remove.
  }
  return result.moved.length > 0 || result.kept.length > 0 ? result : null;
}
