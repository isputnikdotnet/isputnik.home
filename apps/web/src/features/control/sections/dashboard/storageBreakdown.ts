import type { SystemStatus } from "../../types";
import type { DiskHolding, OwnedDisk } from "./useDashboardOverview";

// What is using a drive (control panel v2, phase 4): its used space split into the
// categories home keeps there, and the rest as "Other files" — a disk may hold
// things that are nothing to do with this server, and the Dashboard never implies
// its categories explain everything.
//
// Sizes come from two places: a library's from its scans (/api/status), every other
// place from the server's background folder count (overview.ts measureHoldings).
// A folder's count includes whatever else is kept inside it (thumbnails inside
// system data, the Inbox inside App files), so each place counts only what is
// not another place's: its size less the places directly inside it.

export type StorageCategory = "media" | "appData" | "thumbnails" | "backups" | "trash";
export const STORAGE_CATEGORIES: StorageCategory[] = ["media", "appData", "thumbnails", "backups", "trash"];

const CATEGORY_OF: Record<Exclude<DiskHolding["kind"], "library">, StorageCategory | null> = {
  database: "appData",
  systemData: "appData",
  appFiles: "appData",
  thumbnails: "thumbnails",
  backups: "backups",
  trash: "trash",
  // The video engine's own places: not measured by home.
  artwork: null,
  transcode: null
};

export interface DriveBreakdown {
  /** Bytes per category; a category with nothing measured is absent. */
  categories: Partial<Record<StorageCategory, number>>;
  /** Used space none of the categories account for. */
  other: number;
  /** A place is still being counted, or was counted only up to a limit. */
  measuring: boolean;
}

/** Each library's scanned size, by id. */
export function librarySizes(status: SystemStatus | null): Map<string, number> {
  const sizes = new Map<string, number>();
  if (!status) return sizes;
  // Each media type contributes its own part of /api/status; one that is not
  // installed (or a status from before it) is simply absent.
  for (const library of status.libraryStats?.libraries ?? []) sizes.set(library.id, library.totalSizeBytes);
  for (const library of status.ebookStats?.libraries ?? []) sizes.set(library.id, library.totalSizeBytes);
  for (const library of status.galleryStats?.libraries ?? []) sizes.set(library.id, library.totalSizeBytes);
  return sizes;
}

const normalise = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
const inside = (child: string, parent: string) => child !== parent && child.startsWith(`${parent}/`);

interface Place {
  path: string;
  category: StorageCategory | null;
  /** The whole folder's size (or a library's / the database's own). */
  bytes: number | null;
  /** Its bytes are its own already (a library, the database): nothing nested to take out. */
  own: boolean;
  partial: boolean;
}

export function driveBreakdown(folders: OwnedDisk[], sizes: Map<string, number>, usedBytes: number): DriveBreakdown {
  const places: Place[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    for (const hold of folder.holds) {
      const key = `${hold.kind}:${normalise(hold.path)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (hold.kind === "library") {
        const size = hold.id ? sizes.get(hold.id) : undefined;
        places.push({ path: normalise(hold.path), category: "media", bytes: size ?? null, own: true, partial: false });
      } else {
        places.push({
          path: normalise(hold.path),
          category: CATEGORY_OF[hold.kind],
          bytes: hold.bytes ?? null,
          own: hold.kind === "database",
          partial: Boolean(hold.partial)
        });
      }
    }
  }

  const categories: Partial<Record<StorageCategory, number>> = {};
  let measuring = false;
  for (const place of places) {
    if (!place.category) continue;
    if (place.bytes === null) {
      // A library its scans have not sized yet is simply not counted; a folder
      // still being counted is.
      if (place.category !== "media") measuring = true;
      continue;
    }
    if (place.partial) measuring = true;
    let own = place.bytes;
    if (!place.own) {
      // Take out the places directly inside this one (not those inside them,
      // which their own parent already accounts for).
      const nested = places.filter((other) => other !== place && other.bytes !== null && inside(other.path, place.path));
      for (const child of nested) {
        const direct = !nested.some((between) => between !== child && inside(child.path, between.path));
        if (direct) own -= child.bytes ?? 0;
      }
    }
    categories[place.category] = (categories[place.category] ?? 0) + Math.max(0, own);
  }

  const accounted = Object.values(categories).reduce((sum, bytes) => sum + (bytes ?? 0), 0);
  return { categories, other: Math.max(0, usedBytes - accounted), measuring };
}
