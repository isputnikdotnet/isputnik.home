import { controlHref } from "../../router";
import { APP_PARTS, type ApplicationState } from "./applications";
import { librariesHref } from "./links";
import type { AppKey } from "./nav";
import type { Contents } from "./sections/StorageContentsSection";

export type UsageKind = "media" | "inbox" | "voiceNotes" | "music" | "movies" | "recordings" | "familyTree" | "container";
export interface UsageRow { kind: UsageKind; bytes: number | null; complete: boolean; href?: string }

export const usesAppFiles = (app: AppKey) => app === "gallery" || app === "stories" || app === "familyTree";

/** Only attribute data with a known owner. Shared Home data and caches are not
 * assigned to each app, and the shared App files library is never counted twice. */
export function applicationDiskUsage(app: AppKey, state: ApplicationState, contents: Contents | null) {
  const rows: UsageRow[] = [];
  if (APP_PARTS[app].libraryType) rows.push({
    kind: "media", bytes: state.sizeBytes, complete: state.sizeComplete,
    href: librariesHref(APP_PARTS[app].libraryType)
  });
  if (app === "gallery") {
    const inbox = contents?.rooms.find((room) => room.room === "inbox");
    rows.push({ kind: "inbox", bytes: inbox?.bytes ?? null, complete: inbox?.complete ?? false, href: controlHref("storageContents") });
  }
  const folders = app === "gallery" ? ["voiceNotes", "music", "movies"] as const
    : app === "stories" ? ["recordings"] as const
    : app === "familyTree" ? ["familyTree"] as const : [];
  for (const kind of folders) {
    const folder = contents?.appFiles.folders.find((entry) => entry.key === kind);
    // No App files library is a known empty state; a failed request is unknown.
    const bytes = folder?.bytes ?? (contents && !contents.appFiles.library ? 0 : null);
    rows.push({ kind, bytes, complete: bytes !== null, href: `${controlHref("storageContents")}?folder=${kind}` });
  }
  // Games currently exposes health, not a per-application storage measurement.
  if (app === "games") rows.push({ kind: "container", bytes: null, complete: false });
  const measured = rows.filter((row) => row.bytes !== null);
  return {
    rows,
    bytes: measured.length ? measured.reduce((sum, row) => sum + row.bytes!, 0) : null,
    complete: rows.length > 0 && rows.every((row) => row.complete)
  };
}
