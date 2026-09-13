// Where the Recycle Bin keeps files and for how long: the bin folder setting (the
// library's own .trash, or one install-wide folder), the retention windows, and the
// bin's error type.
import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";
import { pathIsInside, normaliseRelativePath, findStorageRootForPath } from "./storage-roots.js";
import type { AppSettingRow, LibraryRow } from "../../../db/rows.js";

const TRASH_DIR = ".trash";

/** Where a library's deleted files sit by default: inside the library's own folder, so
 *  deleting is a rename within one filesystem rather than a copy across shares — which
 *  also means one bin per library, not one for the install. Only the default; an
 *  install-wide folder can be chosen on the Storage page (see getTrashRootSetting). */
export const trashFolderFor = (sourcePath: string): string => path.join(sourcePath, TRASH_DIR);
const TRASH_RETENTION_KEY = "trash_retention_days";
const DEFAULT_RETENTION_DAYS = 30;
const TRASH_ROOT_KEY = "trash_root_path";

/** The install-wide bin folder, or null for the per-library default.
 *
 *  Why offer it at all: other software walking the same share indexes `.trash` — Immich's
 *  external libraries add every file in an import path, and its own docs call the exclusion
 *  globs unreliable — so a month of deleted photos keeps showing up as live in whatever else
 *  reads that folder. Moving the bin out of the library tree is the only fix that doesn't
 *  depend on another tool's ignore rules. */
export function getTrashRootSetting(): string | null {
  return getOwnTrashRootSetting();
}

/** The bin folder setting itself. The same answer as getTrashRootSetting since 4.6,
 *  when the bin stopped being a room of App storage (docs/system-data-plan.md,
 *  decision 18); kept as its own name for the callers that meant "the setting". */
export function getOwnTrashRootSetting(): string | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(TRASH_ROOT_KEY) as Pick<AppSettingRow, "value"> | undefined;
  const value = row?.value.trim();
  return value ? value : null;
}

/** Is there anything in the bin at all? Changing the location used to be allowed only
 *  while there was not; since App storage (plan decision 10) a change moves what is in
 *  the bin instead (trash-move.ts), and this only decides whether there is anything to move. */
export function binIsEmpty(): boolean {
  return (db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get() as { n: number }).n === 0;
}

/** The bin's two layouts, in one place: `<source>/.trash/<token>` for the per-library
 *  default and `<bin>/<library>/<token>` for a shared folder. The move job rewrites rows
 *  from one to the other. */
export function trashPathFor(libraryId: string, token: string, trashRoot: string | null): string {
  return normaliseRelativePath(trashRoot ? path.join(libraryId, token) : path.join(TRASH_DIR, token));
}

/** Vet a candidate bin folder. Same containment rule as a library source — it must sit in
 *  a configured storage container — plus the rules that are specific to this: it cannot be
 *  inside a library (the scanner would catalogue deleted files straight back in) and cannot
 *  contain one (emptying the bin would then be pointed at live files). */
export function validateTrashRootPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (!path.isAbsolute(resolved)) {
    throw new TrashError("Use an absolute server path for the Recycle Bin folder.");
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new TrashError(`That folder is missing or not accessible: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new TrashError("The Recycle Bin location must be a folder.");

  const real = fs.realpathSync(resolved);
  if (!findStorageRootForPath(real)) {
    throw new TrashError("Choose a folder inside a configured Digital Library container.");
  }

  const libraries = db.prepare("SELECT name, source_path FROM libraries").all() as Pick<LibraryRow, "name" | "source_path">[];
  for (const library of libraries) {
    const source = path.resolve(library.source_path);
    if (pathIsInside(real, source)) {
      throw new TrashError(
        `That folder is inside the library "${library.name}", so deleted files would be scanned straight back in. Choose one outside every library.`
      );
    }
    if (pathIsInside(source, real)) {
      throw new TrashError(
        `The library "${library.name}" is inside that folder. The Recycle Bin must not contain a library.`
      );
    }
  }

  return real;
}

export function setTrashRootSetting(rootPath: string | null, userId: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(TRASH_ROOT_KEY, rootPath ?? "", userId);
}

/** What a row's trash_path is relative to. NULL trash_root = the library's own folder,
 *  which is what every row written before the setting existed means. */
export const binRootFor = (item: { source_path: string; trash_root?: string | null }): string =>
  path.resolve(item.trash_root || item.source_path);

/** The folder holding this row's item directory — `<source>/.trash`, or `<bin>/<library>`.
 *  Shown on the Recycle Bin page: "restore it from the app" is no help when the app is
 *  down, or when the question is which disk the space is still on. */
export function binFolderFor(item: { source_path: string; trash_root?: string | null; trash_path: string }): string {
  return path.dirname(path.resolve(binRootFor(item), item.trash_path));
}

export class TrashError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "TrashError";
    this.statusCode = statusCode;
  }
}

/** Why an item was removed. Two levels only, deliberately: the bin's own setting is the
 *  default, and duplicate cleanup gets one override. Room for more, but a general
 *  per-source policy system is more machinery than two answers need. */
/** manual = a hand delete; duplicate_cleanup = a cleanup's removal; photo_inbox =
 *  a photo discarded from a Photo Inbox review, which shares the cleanup's clock:
 *  a rejected scan is the same kind of removal a cleanup makes. */
export type TrashSource = "manual" | "duplicate_cleanup" | "photo_inbox";

const CLEANUP_RETENTION_KEY = "trash_retention_days_duplicate_cleanup";

/** How long a cleanup's removals are kept, or null to follow the bin's own setting.
 *  Stored as a string so "unset" and "0 = keep for ever" stay distinguishable — the
 *  difference between "I never chose" and "I chose never to purge". */
export function getCleanupRetentionDays(): number | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(CLEANUP_RETENTION_KEY) as Pick<AppSettingRow, "value"> | undefined;
  if (!row || row.value === "") return null;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function setCleanupRetentionDays(days: number | null): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(CLEANUP_RETENTION_KEY, days == null ? "" : String(days));
}

/** The moment this item will be purged, decided ONCE, now. Null = keep until the bin is
 *  emptied by hand. */
export function expiryFor(source: TrashSource, at = new Date()): string | null {
  const days = source === "duplicate_cleanup" || source === "photo_inbox"
    ? getCleanupRetentionDays() ?? getTrashRetentionDays()
    : getTrashRetentionDays();
  if (days <= 0) return null;
  return new Date(at.getTime() + days * 86_400_000).toISOString();
}

export function getTrashRetentionDays(): number {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(TRASH_RETENTION_KEY) as Pick<AppSettingRow, "value"> | undefined;
  if (!row) return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETENTION_DAYS; // 0 = never auto-purge
}

export function setTrashRetentionDays(days: number): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(TRASH_RETENTION_KEY, String(days));
}
