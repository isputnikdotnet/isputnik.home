// Which gallery libraries a query runs over: the reachable scope, and the
// narrower browsing scope the surfaces that resurface photos on their own use.
import { db } from "../../../db.js";
import { canUserAccessLibrary } from "../shared/library-access.js";
import { galleryLibrariesLeftOutOfScope, photoInboxLibraryIds } from "./system-libraries.js";
import { withAppFileOwners, withFamilyUploads } from "./app-files-access.js";
import { withSharedPeople } from "./people-access.js";
import type { LibraryRow } from "../../../db/rows.js";

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
  const rows = db.prepare("SELECT id, policy_json FROM libraries WHERE type = 'gallery'").all() as Pick<LibraryRow, "id" | "policy_json">[];
  const accessible = rows.filter((row) => canUserAccessLibrary(row, user.id, user.role));
  // A Photo Inbox holds photos nobody has kept yet, so it is left out of every
  // "everything I can see" scope. Naming it explicitly is how it is browsed, and
  // how its review page reads it. See docs/photo-inbox-proposal.md.
  //
  // This is the REACHABLE scope: what a story, an album, a slideshow or the
  // viewer may show when it names a photo by id. App files is in it for admins
  // only; for anyone else the list carries the App files rule
  // (app-files-access.ts), so a query asking through galleryScopeSql shows the
  // App files items whose owners they can see — the photos and recordings a
  // story holds keep showing (3.84.1 dropped them all, and every such block read
  // "not in a library you can see"). App files is never BROWSED
  // (resolveGalleryBrowseLibraryIds).
  if (!libraryIds || libraryIds.length === 0) {
    const inboxes = photoInboxLibraryIds();
    // And the photos shared with them by person (people-access.ts), which sit in
    // libraries they cannot open.
    return withSharedPeople(user, withAppFileOwners(user, accessible.filter((row) => !inboxes.has(row.id)).map((row) => row.id)));
  }
  const requested = new Set(libraryIds);
  return accessible.filter((row) => requested.has(row.id)).map((row) => row.id);
}

/** A library filter entry that is not a library: photos uploaded from the family
 *  tree (App files → Family tree). Off unless chosen — the Gallery's Libraries
 *  facet offers it; the photo pickers always ask for it. */
export const FAMILY_TREE_SCOPE = "family-tree";
/** A library filter entry meaning "every library I would browse by default", so
 *  a picker can ask for that AND the family-tree photos in one list. */
export const ALL_LIBRARIES_SCOPE = "all";
/** A library filter entry that is not a library: the photos shared with the
 *  viewer by person, from libraries they cannot open. On by default (they are
 *  the viewer's photos); naming it alone narrows to just them. */
export const SHARED_PEOPLE_SCOPE = "shared-people";

// The BROWSING scope: the timeline, folders, memories, the map, the facets,
// the People list and the Home feed's photo cards — the surfaces that resurface
// photos on their own. On top of the Inbox, App files (what the app keeps for
// itself) is left out unless it is named in the library filter: both are system
// libraries (system-libraries.ts). Photos uploaded from the family tree into App
// files → Family tree are the family's own, so the filter can ask for them with
// FAMILY_TREE_SCOPE: the list then carries a rule that lets them through
// (withFamilyUploads). Not by default — the owner wanted the Gallery as it was,
// with them one choice away (2026-09-23). Photos shared with the viewer by person
// are the opposite: in by default, since for a relative they ARE the Gallery
// (docs/people-sharing-plan.md, D1), and SHARED_PEOPLE_SCOPE narrows to them.
// Naming libraries leaves them out, as it leaves out every other library.
// Everything named by id elsewhere (a story's block, an album, a slideshow, the
// viewer) uses the reachable scope above.
//
// Queries must ask through galleryScopeSql, not a bare `library_id IN (...)`,
// or the rule is lost.
export function resolveGalleryBrowseLibraryIds(user: { id: string; role: string }, libraryIds?: string[]): string[] {
  const asked = libraryIds ?? [];
  const familyTree = asked.includes(FAMILY_TREE_SCOPE);
  const sharedPeople = asked.includes(SHARED_PEOPLE_SCOPE);
  const all = asked.includes(ALL_LIBRARIES_SCOPE);
  const named = asked.filter((id) => id !== FAMILY_TREE_SCOPE && id !== ALL_LIBRARIES_SCOPE && id !== SHARED_PEOPLE_SCOPE);
  const everything = all || (named.length === 0 && !familyTree && !sharedPeople);
  const defaultScope = () => {
    const leftOut = galleryLibrariesLeftOutOfScope();
    return resolveGalleryScopeLibraryIds(user).filter((id) => !leftOut.has(id));
  };
  const base = everything
    ? defaultScope()
    : named.length > 0 ? resolveGalleryScopeLibraryIds(user, named) : [];
  // A fresh array: the rules are attached to this list, never to one another caller holds.
  const scope = [...base];
  if (everything || sharedPeople) withSharedPeople(user, scope);
  if (familyTree) withFamilyUploads(user, scope);
  return scope;
}
