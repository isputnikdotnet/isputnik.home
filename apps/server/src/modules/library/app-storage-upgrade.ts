// The 4.6 App storage conversion — docs/system-data-plan.md, "Upgrading an existing
// install". Runs once at startup, after the system data conversion (index.ts), and
// rewrites the rooms shape of the `app_storage` setting as the one switch.
//
// It moves nothing:
//
//   - a folder was chosen            → on, at that folder; renders and map data
//                                      that stayed in their own place ("own")
//                                      are marked outside
//   - no folder, but any part in use → on, in system data; renders and map data
//     (a Photo Inbox, App files, music   stay where they are, marked outside
//     waiting in the render buckets,
//     kept maps or place names)
//   - nothing in use                 → off
//
// A system library outside App storage needs no mark: its source path says where
// it is, and the Storage page offers to move it in.
import fs from "node:fs";
import path from "node:path";
import { logActivity } from "../../db.js";
import { readAppStorageRaw, saveAppStorageSetting, type AppStorageSetting } from "../../core/app-storage.js";
import { getSystemDataPath } from "../../core/system-data.js";
import { configuredThumbnailPathValue, RENDER_BUCKETS } from "./shared/thumbnail.js";
import { libraryWithRole, dirHasEntries } from "./app-storage.js";
import { pendingBucketMusic } from "./gallery/music.js";
import { getMapSettings } from "../maps/settings.js";
import { ownMapDataDir } from "../maps/storage.js";
import { placesDir } from "../maps/places/dataset.js";

export function convertAppStorageSetting(): AppStorageSetting | null {
  const raw = readAppStorageRaw();
  if (raw && typeof raw.enabled === "boolean") return null;

  const folder = raw && typeof raw.path === "string" && raw.path.trim() ? raw.path : null;
  const rooms = raw?.rooms && typeof raw.rooms === "object" ? raw.rooms as Record<string, unknown> : {};

  let next: AppStorageSetting;
  if (folder) {
    next = {
      enabled: true,
      where: "custom",
      path: folder,
      outside: { ...(rooms.renders === "own" ? { renders: true } : {}), ...(rooms.maps === "own" ? { maps: true } : {}) }
    };
  } else {
    const thumbs = configuredThumbnailPathValue();
    const ownMaps = ownMapDataDir();
    const inUse = Boolean(libraryWithRole("inbox"))
      || Boolean(libraryWithRole("app-files"))
      || pendingBucketMusic() > 0
      || Boolean(thumbs && RENDER_BUCKETS.some((bucket) => dirHasEntries(path.join(thumbs, bucket))))
      || getMapSettings().cache
      || dirHasEntries(path.join(ownMaps, "Tiles"))
      || fs.existsSync(placesDir());
    next = inUse && getSystemDataPath()
      ? { enabled: true, where: "system", path: null, outside: { renders: true, maps: true } }
      : { enabled: false, where: "system", path: null, outside: {} };
  }

  saveAppStorageSetting(next, null);
  logActivity({
    event: "config.updated",
    actorUserId: null,
    targetType: "setting",
    targetId: "app_storage",
    detail: next.enabled
      ? `App storage converted for 4.6 without moving any file: on, ${next.where === "custom" ? `at ${next.path}` : "in system data"}${Object.keys(next.outside).length > 0 ? `; ${Object.keys(next.outside).join(" and ")} stay in their own place until moved in` : ""}.`
      : "App storage converted for 4.6: off, since nothing used it."
  });
  return next;
}
