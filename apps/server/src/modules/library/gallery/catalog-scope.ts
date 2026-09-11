// Which gallery libraries a query runs over: the reachable scope, and the
// narrower browsing scope the surfaces that resurface photos on their own use.
import { db } from "../../../db.js";
import { canUserAccessLibrary } from "../shared/library-access.js";
import { galleryLibrariesLeftOutOfScope, photoInboxLibraryIds } from "./inbox-flag.js";

// A `?libraryIds=id1,id2` query param, the GET-route counterpart of the timeline
// POST's `filters.libraries` array. Bounded generously — the number of libraries
// on an install, not a payload someone controls the size of.
export function parseLibraryIds(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((id) => id.trim()).filter(Boolean).slice(0, 200);
}

// Which gallery libraries a query runs over: every one the user can reach, or —
// when `libraryIds` narrows it — the intersection with that set. Narrows only,
// never widens: an id the caller can't reach (or that isn't a gallery library at
// all) simply drops out rather than granting access to it.
export function resolveGalleryScopeLibraryIds(user: { id: string; role: string }, libraryIds?: string[]): string[] {
  const rows = db.prepare("SELECT id, policy_json FROM libraries WHERE type = 'gallery'").all() as { id: string; policy_json: string }[];
  const accessible = rows.filter((row) => canUserAccessLibrary(row, user.id, user.role));
  // A Photo Inbox holds photos nobody has kept yet, so it is left out of every
  // "everything I can see" scope. Naming it explicitly is how it is browsed, and
  // how its review page reads it. See docs/photo-inbox-proposal.md.
  //
  // This is the REACHABLE scope: what a story, an album, a slideshow or the
  // viewer may show when it names a photo by id. A library inside App storage
  // (App files) is reachable — the photos placed in a story from it must
  // keep showing — but is left out of BROWSING (resolveGalleryBrowseLibraryIds).
  // 3.84.1 excluded it here too and every story block from that library read
  // "not in a library you can see".
  if (!libraryIds || libraryIds.length === 0) {
    const inboxes = photoInboxLibraryIds();
    return accessible.filter((row) => !inboxes.has(row.id)).map((row) => row.id);
  }
  const requested = new Set(libraryIds);
  return accessible.filter((row) => requested.has(row.id)).map((row) => row.id);
}

// The BROWSING scope: the timeline, folders, memories, the year review, the
// map, the facets, the People list and the Home feed's photo cards — the
// surfaces that resurface photos on their own. On top of the Inbox, a library
// inside App storage (what the app keeps for itself) is left out unless it is
// named in the library filter. Everything named by id elsewhere (a story's
// block, an album, a slideshow, the viewer) uses the reachable scope above.
export function resolveGalleryBrowseLibraryIds(user: { id: string; role: string }, libraryIds?: string[]): string[] {
  if (libraryIds && libraryIds.length > 0) return resolveGalleryScopeLibraryIds(user, libraryIds);
  const leftOut = galleryLibrariesLeftOutOfScope();
  return resolveGalleryScopeLibraryIds(user).filter((id) => !leftOut.has(id));
}
