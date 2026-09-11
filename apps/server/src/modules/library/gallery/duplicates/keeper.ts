import { db } from "../../../../db.js";
import { libraryAllowsDelete } from "../../shared/trash.js";
import { allFolderLocks, lockCoveredIn } from "../../shared/folder-locks.js";
import type { DetailRow } from "./details.js";
import type { LibraryRow } from "../../../../db/rows.js";

// Filename shapes a file manager or download produces for a second copy. Deliberately
// narrow: a trailing "-1"/"_1" is NOT included, because IMG_1234.jpg would match it.
// ── Folder preferences ──────────────────────────────────────────────────────
//
// Two standing instructions the admin can attach to a folder:
//
//   "keep"   when copies of a photo are in more than one place, keep the one here.
//   "clear"  keep the copies elsewhere and let this folder's go — the way you retire
//            a folder whose contents have already been filed properly somewhere else.
//
// Both outrank every heuristic below, because they are instructions rather than
// guesses, and neither costs anything: whatever a losing copy carries is merged onto
// the keeper before it goes.
//
// "clear" can never empty a folder on its own. A photo with no copy outside it is
// nobody's duplicate, so it is never in a set at all; and a set every one of whose
// copies is inside cleared folders has no preferred survivor, falls through to the
// ordinary criteria, and still keeps one. Retiring a folder means "these photos are
// safe elsewhere", not "delete these photos".
export type FolderPreferenceMode = "keep" | "clear";

export interface FolderPreference {
  libraryId: string;
  /** Relative to the library root. "" means the whole library. */
  folderPath: string;
  mode: FolderPreferenceMode;
}

export function preferenceFor(
  folders: FolderPreference[],
  libraryId: string,
  /** A file's path, or a folder's — both answer the same question. */
  path: string
): FolderPreferenceMode | null {
  let best: FolderPreference | null = null;
  for (const folder of folders) {
    if (folder.libraryId !== libraryId) continue;
    const covers = folder.folderPath === "" || path === folder.folderPath || path.startsWith(`${folder.folderPath}/`);
    if (!covers) continue;
    if (!best || folder.folderPath.length > best.folderPath.length) best = folder;
  }
  return best?.mode ?? null;
}

export const COPY_MARKERS = [/ \(\d+\)$/, /\bcopy\b/i, /^copy of /i, /[-_ ]duplicate$/i];

const baseNameOf = (relativePath: string): string =>
  (relativePath.split("/").pop() ?? "").replace(/\.[^.]+$/, "");

// A name has to START one of these to count as an appended suffix, so "IMG_110" does
// not get read as the original of "IMG_1109" — that 9 is part of the frame number, not
// a counter somebody bolted on.
const APPENDED_SUFFIX = /^[-_ (]/;

/** Which copies in this set are named as copies OF another copy in it.
 *
 *  Relational on purpose, rather than another entry in COPY_MARKERS. The observed case
 *  is "Picture 071.jpg" beside "Picture 071-001.jpg", and no pattern reliably says
 *  which of those is the original: "-001" is a counter to scanner software and part of
 *  the name to anyone whose camera writes it. Set one name beside the other and it is
 *  obvious — one is the other with something stuck on the end — and it costs no
 *  guessing, catches every suffix convention at once, and cannot misfire on a lone file
 *  whose real name happens to look like a copy. */
function derivedCopyIds(rows: DetailRow[]): Set<string> {
  const stems = rows.map((row) => ({ id: row.item_id, stem: baseNameOf(row.relative_path) }));
  const derived = new Set<string>();
  for (const longer of stems) {
    for (const shorter of stems) {
      if (longer.id === shorter.id || longer.stem.length <= shorter.stem.length) continue;
      if (!longer.stem.startsWith(shorter.stem)) continue;
      if (!APPENDED_SUFFIX.test(longer.stem.slice(shorter.stem.length))) continue;
      derived.add(longer.id);
      break;
    }
  }
  return derived;
}

// Folders that hold received or derived copies rather than originals.
export const DERIVED_FOLDERS = /^(downloads?|whatsapp|telegram|viber|messenger|screenshots?|thumbnails?|cache|te?mp)\b|whatsapp|telegram/i;

/** Below this share of the set's best pixel count, a copy is a preview rather than a
 *  variant of it. A quarter of the pixels is half the width — well past anything a crop,
 *  a re-encode or a moderate downscale produces (4000×3000 beside 6000×4000 is half the
 *  pixels and still a photograph), and well above where thumbnails and index scans land:
 *  the Fuji index print below is an eighth. Deliberately generous to the small copy,
 *  because everything this criterion outranks is recoverable and a wrong call here is
 *  not. */
const PREVIEW_PIXEL_RATIO = 0.25;

/** Ids that are plainly a downscale of something else in the set.
 *
 *  Film scanners are the case that forced this: a Fuji Frontier writes FL000003.jpg at
 *  432×640 beside FH000003.jpg at 1215×1800, and it is the LOW-resolution index scan
 *  that carries the camera make and model. Judged on metadata the preview wins, and the
 *  set is resolved by deleting the only copy of the photo that has any detail in it.
 *
 *  Rows whose dimensions are unknown are never flagged: unknown is not small. */
function previewCopyIds(rows: DetailRow[]): Set<string> {
  const pixelsOf = (row: DetailRow) => (row.width ?? 0) * (row.height ?? 0);
  const best = Math.max(...rows.map(pixelsOf));
  if (best <= 0) return new Set();
  return new Set(rows.filter((row) => pixelsOf(row) > 0 && pixelsOf(row) < best * PREVIEW_PIXEL_RATIO).map((r) => r.item_id));
}

interface Scored extends DetailRow {
  linkCount: number;
  manualCount: number;
  exifCount: number;
  pixels: number;
  copyMarker: boolean;
  derivedFolder: boolean;
  /** A fraction of the best resolution in its set — a preview, not a candidate. */
  previewCopy: boolean;
  preference: FolderPreferenceMode | null;
  /** Its library forbids deleting — external, or deleting turned off. */
  protectedLibrary: boolean;
  /** A folder lock covers its path, so this copy can't be deleted. */
  lockedFolder: boolean;
}

// Which libraries refuse deletion, answered once and reused for every copy scored.
function protectedLibraries(): Set<string> {
  const rows = db.prepare("SELECT id FROM libraries WHERE type = 'gallery'").all() as Pick<LibraryRow, "id">[];
  return new Set(rows.filter((row) => !libraryAllowsDelete(row.id)).map((row) => row.id));
}

function score(
  row: DetailRow,
  preferences: FolderPreference[] = [],
  protectedLibs: Set<string> = protectedLibraries(),
  locks: Map<string, string[]> = allFolderLocks(),
  /** Ids this set's own names give away as copies. Empty when a row is scored on its
   *  own — the read paths do that for display, and only read linkCount from it. */
  derived: Set<string> = new Set(),
  /** Ids the set's own resolutions give away as previews. Same story: empty when a row
   *  is scored alone, since "a fraction of the best" needs the rest of the set. */
  previews: Set<string> = new Set()
): Scored {
  const segments = row.relative_path.split("/");
  const baseName = baseNameOf(row.relative_path);
  return {
    ...row,
    preference: preferenceFor(preferences, row.library_id, row.relative_path),
    linkCount:
      row.face_count + row.album_count + row.slideshow_count + row.collection_count
      + row.tag_count + row.save_count + row.share_count + row.ft_person_count + row.ft_event_count,
    manualCount:
      (row.metadata_source === "manual" ? 1 : 0)
      + (row.taken_at_source === "manual" ? 1 : 0)
      + (row.gps_source === "manual" ? 1 : 0),
    exifCount:
      (row.taken_at && row.taken_at_source === "scan" ? 1 : 0)
      + (row.camera_make ? 1 : 0)
      + (row.camera_model ? 1 : 0),
    pixels: (row.width ?? 0) * (row.height ?? 0),
    copyMarker: derived.has(row.item_id) || COPY_MARKERS.some((re) => re.test(baseName)),
    derivedFolder: segments.slice(0, -1).some((seg) => DERIVED_FOLDERS.test(seg)),
    previewCopy: previews.has(row.item_id),
    protectedLibrary: protectedLibs.has(row.library_id),
    lockedFolder: lockCoveredIn(locks.get(row.library_id), row.relative_path)
  };
}

// Ordered, not weighted: the copies are compared criterion by criterion and the first
// difference decides. That keeps "which copy survives" explainable — the winning
// criterion IS the reason shown to the admin — and avoids the tuning problem a weighted
// sum creates. User work outranks everything, because it's the only thing that can't be
// recovered from the file itself.
// `decision` marks the criteria that are somebody's choice — a library made
// undeletable, a folder instruction, hand-filed work, hand-edited details — as opposed
// to properties read off the files. The confidence grading in job-results.ts derives its
// evidence/guess boundary from these flags, so inserting a criterion here cannot
// silently shift what "chosen on evidence" means (it did once, when the preview rule
// landed above the boundary that was then a bare count).
const KEEPER_CRITERIA: { label: string; decision?: boolean; value: (row: Scored) => number }[] = [
  // Above even the explicit instructions, because this one is not a preference: a copy
  // in an external library CANNOT be deleted, so naming it the loser proposes an action
  // that will be refused. Where a photo sits in both an ordinary library and one the app
  // only reads, the readable one keeps its copy and the ordinary one gives its up — the
  // only outcome that is actually available.
  { label: "in a library its files can't be deleted from", decision: true, value: (r) => (r.protectedLibrary ? 1 : 0) },
  // The same fact one level down: a folder lock covers this copy, so naming it the
  // loser proposes an action trashBook will refuse. A lock is somebody's decision.
  { label: "in a locked folder", decision: true, value: (r) => (r.lockedFolder ? 1 : 0) },
  // Explicit instructions beat every guess below them, in both directions. Nothing is
  // lost by obeying them: the losing copies' tags and people are merged onto the
  // keeper either way. "Clearing out" ranks above hand-filed work for the same reason
  // — the work moves to the copy that survives.
  { label: "in a folder you chose to keep", decision: true, value: (r) => (r.preference === "keep" ? 1 : 0) },
  { label: "not in a folder you're clearing out", decision: true, value: (r) => (r.preference === "clear" ? 0 : 1) },
  // Above every guess below it, because it is the one difference nothing can undo. The
  // criteria that follow are all recoverable: tags, albums, people and hand-edited
  // details are merged onto the keeper, a copy marker and a folder name are inferences
  // about where a file came from, and camera info is metadata — donated below where the
  // keeper has none. Pixels are not recoverable from any other copy in the set, so a
  // preview must never win on metadata it happens to carry and the full-size copy
  // happens to lack. Explicit instructions still outrank it: an admin naming the folder
  // to keep is answering this question themselves.
  { label: "not a low-resolution copy", value: (r) => (r.previewCopy ? 0 : 1) },
  { label: "has tags, albums or people", decision: true, value: (r) => r.linkCount },
  { label: "has hand-edited details", decision: true, value: (r) => r.manualCount },
  { label: "not a copy", value: (r) => (r.copyMarker ? 0 : 1) },
  { label: "in an original folder", value: (r) => (r.derivedFolder ? 0 : 1) },
  { label: "has date and camera info", value: (r) => r.exifCount },
  { label: "highest resolution", value: (r) => r.pixels },
  { label: "largest file", value: (r) => r.size ?? 0 },
  {
    label: "added first",
    value: (r) => {
      const t = new Date(r.discovered_at).getTime();
      return Number.isFinite(t) ? -t : 0;
    }
  }
];

/** Whether the ladder rung a keeper choice was decided on is somebody's decision
 *  (true), or a property read off the files (false). Answered by the ladder itself, so
 *  it stays right when a criterion is added or moved. -1 — the tiebreak — is not a
 *  decision. */
export function keeperRankIsDecision(rank: number): boolean {
  return Boolean(KEEPER_CRITERIA[rank]?.decision);
}

function compareCandidates(a: Scored, b: Scored): number {
  for (const criterion of KEEPER_CRITERIA) {
    const diff = criterion.value(b) - criterion.value(a);
    if (diff !== 0) return diff; // descending — higher wins
  }
  return a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0;
}

export interface KeeperChoice {
  keeperId: string;
  reason: string | null;
  /** Where in KEEPER_CRITERIA the decision was actually made — 0 is the first and
   *  strongest, and -1 means nothing separated the copies and the stable tiebreak had
   *  to settle it.
   *
   *  Free, and worth having: because the ladder is ORDERED rather than weighted, the
   *  rank IS how confident the choice is. A keeper that won on "has tags, albums or
   *  people" was chosen on evidence a person created; one that fell through to "added
   *  first" won a coin toss, and a page that shows both the same way is overstating
   *  one of them. */
  rank: number;
}

// Pick the copy to keep, plus a short explanation naming the criteria on which it beat
// the runner-up. Identical copies (the normal case for byte-identical files with no
// links either side) fall through to the stable "added first" tiebreak.
export function pickKeeper(rows: DetailRow[], instructions?: FolderPreference[]): KeeperChoice | null {
  if (rows.length === 0) return null;
  // Read the preferences and the protected libraries once per set, not once per copy.
  // A cleanup job passes its OWN instructions here: they are seeded from the global
  // ones and diverge from then on, and a keeper picked under the wrong set is a
  // choice the page that set it would not recognise.
  const preferences = instructions ?? [];
  const protectedLibs = protectedLibraries();
  const locks = allFolderLocks();
  const derived = derivedCopyIds(rows);
  const previews = previewCopyIds(rows);
  const scored = rows.map((row) => score(row, preferences, protectedLibs, locks, derived, previews)).sort(compareCandidates);
  const winner = scored[0];
  const runnerUp = scored[1];
  if (!runnerUp) return { keeperId: winner.item_id, reason: null, rank: -1 };

  // Every copy is somewhere the admin asked to clear out. One is still kept — the
  // instruction says which copy survives, never whether one does — but keeping a copy
  // in a folder you told it to empty needs saying, or it reads as the setting being
  // ignored. It is usually a folder marked at the wrong level: mark the inner one.
  if (scored.every((row) => row.preference === "clear")) {
    return {
      keeperId: winner.item_id,
      reason: "every copy is in a folder you're clearing out, so one was kept anyway",
      // Decided by an explicit instruction, even though it reads as an apology.
      rank: KEEPER_CRITERIA.findIndex((c) => c.label.includes("clearing out"))
    };
  }

  const decided = KEEPER_CRITERIA.findIndex((c) => c.value(winner) > c.value(runnerUp));
  const reasons = KEEPER_CRITERIA
    .filter((c) => c.value(winner) > c.value(runnerUp))
    .map((c) => c.label)
    .slice(0, 2);
  return {
    keeperId: winner.item_id,
    reason: reasons.length > 0 ? reasons.join(", ") : "identical in every way — kept the one added first",
    rank: decided
  };
}
