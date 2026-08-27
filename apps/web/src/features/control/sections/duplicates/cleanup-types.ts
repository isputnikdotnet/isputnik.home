// What the duplicate cleanup server says, and the words the pages put on it.
//
// Kept apart from the components so the page, the job card, the wizard and the result
// cards all read the same shapes — and so a label like "." for the library's own folder
// has exactly one definition. No JSX in here on purpose: everything is a type, a
// constant, or a pure function of one.
//
// The word-lookup helpers below are plain functions rather than components, so they
// call i18n.t() directly (see docs/i18n-plan.md's namespace-key typing pitfall #3)
// instead of the useTranslation() hook.
import i18n from "../../../../i18n";

export type JobStatus =
  | "draft" | "scanning" | "review" | "processing" | "paused"
  | "completed" | "failed" | "cancelled";

export type ResultType = "photo_set" | "folder_set" | "contained" | "overlap";
export type MemberRole = "keep" | "delete" | "protected";

/** How sure the match is, as opposed to what SHAPE the result has. `exact` means
 *  identical bytes; `near` means a perceptual fingerprint a few bits apart — the same
 *  picture as a different file. Two axes on purpose: a byte-identical set is certain
 *  about the match and can still be a coin toss about which copy to keep. */
export type ResultTier = "exact" | "near";

/** How sure the MATCH is — identical bytes, or a perceptual match and how much to
 *  trust it. Separate from the keeper answer: a byte-identical set is certain about
 *  the match and can still be a coin toss about which copy stays. */
export type MatchConfidence = "certain" | "likely" | "unsure";

/** How sure the KEEPER CHOICE is: decided by something a person did, by a property of
 *  the file, or by nothing at all. */
export type KeeperConfidence = "evidence" | "guess" | "tossup";

/** The two confidences folded to one reading for the card's gauge: how carefully to
 *  look before letting this result go through. Folded on the server, so every page
 *  that shows a gauge shows the same fold. */
export interface ResultRisk {
  /** 0 = none (green) … 3 = check first (red). */
  severity: 0 | 1 | 2 | 3;
  label: string;
  explanation: string;
}

export interface JobLibrary {
  libraryId: string;
  name: string;
  included: boolean;
  mode: "managed" | "external";
  isProtected: boolean;
  currentMode: "managed" | "external";
  currentlyProtected: boolean;
  missing: boolean;
}

export interface JobTotals {
  results: number;
  reviewed: number;
  skipped: number;
  deleted: number;
  remaining: number;
  errors: number;
  reclaimableBytes: number;
  reclaimedBytes: number;
}

export interface DuplicateJob {
  id: string;
  ownerUserId: string;
  ownerName: string;
  status: JobStatus;
  /** Folders OR files — a cleanup is one kind of work or the other, never both. */
  duplicateType: "folders" | "files";
  mediaType: "photo" | "video" | "both";
  currentStep: number;
  /** How far through the fingerprint pass, 0–100. Only moves while `scanning`. */
  scanProgress: number;
  statusDetail: string | null;
  createdAt: string;
  lastActivityAt: string;
  scanCompletedAt: string | null;
  libraries: JobLibrary[];
  folderPreferences: { libraryId: string; folderPath: string; mode: "keep" | "clear" }[];
  totals: JobTotals;
}

export type DuplicateKind = DuplicateJob["duplicateType"];
export type MediaKind = DuplicateJob["mediaType"];

export interface LibraryOption {
  id: string;
  name: string;
  sourcePath: string;
  mode: "managed" | "external";
  isProtected: boolean;
  /** Photos sharing a byte size with another photo — everything worth checking here. */
  candidateCount: number;
  /** Of those, how many the scan would open and read right now. Zero means the
   *  fingerprints are current and this library costs nothing to scan. */
  pendingCount: number;
}

export interface JobsPayload {
  activeJob: DuplicateJob | null;
  isOwner: boolean;
  libraries: LibraryOption[];
  history: DuplicateJob[];
}

export interface SnapshotFolder {
  /** What a member's `folderId` points at. */
  id: string;
  libraryId: string;
  libraryName: string;
  folderPath: string;
  role: MemberRole;
  itemCount: number;
  bytes: number;
}

export interface SnapshotMember {
  id: string;
  itemId: string | null;
  /** Which of the result's folders this file belongs to; NULL on a photo set. */
  folderId: string | null;
  libraryId: string;
  libraryName: string;
  path: string;
  size: number | null;
  role: MemberRole;
  status: string;
  /** Bits from the keeper: 0 on a byte-identical copy, 1–3 on a near-identical one. */
  distance: number;
  keeperPath: string | null;
  /** WHICH member that is — for pairing two folders row by row. */
  keeperMemberId: string | null;
  /** All NULL once the photo itself is gone — the snapshot outlives what it describes. */
  coverUrl: string | null;
  previewUrl: string | null;
  fileUrl: string | null;
  width: number | null;
  height: number | null;
}

export interface SnapshotResult {
  id: string;
  type: ResultType;
  tier: ResultTier;
  matchConfidence: MatchConfidence;
  keeperConfidence: KeeperConfidence;
  risk: ResultRisk;
  status: string;
  reviewStatus: "unreviewed" | "reviewed" | "skipped";
  reclaimableBytes: number;
  keeperReason: string | null;
  coverUrls?: string[];
  folders: SnapshotFolder[];
  members: SnapshotMember[];
}

/** How much smaller one copy of a near set is than the set's biggest, said on its
 *  tile. Pixels, not bytes: bytes are already printed and compression makes them lie
 *  about detail, while pixel count is the thing that can't be re-encoded back. Only
 *  said when the gap is real — a few percent of crop is not a difference worth a
 *  word, and a tag on every tile teaches people to ignore tags. */
export interface SizeShortfall {
  /** Rounded pixel ratio against the biggest copy, ≥ 2. */
  times: number;
  /** True from 4× up (half the width per side) — the tag turns from a fact into a
   *  warning when a copy this much smaller is the one being KEPT. */
  severe: boolean;
  label: string;
}

const pixelsOf = (member: SnapshotMember): number => (member.width ?? 0) * (member.height ?? 0);

/** The most pixels any copy of the set carries — the yardstick every tile is read
 *  against. 0 when no copy has known dimensions. */
export function largestPixelsOf(members: SnapshotMember[]): number {
  return members.reduce((best, member) => Math.max(best, pixelsOf(member)), 0);
}

export function sizeShortfallOf(member: SnapshotMember, largestPixels: number): SizeShortfall | null {
  const pixels = pixelsOf(member);
  // Unknown is not small: a copy whose dimensions never got read gets no tag.
  if (pixels <= 0 || largestPixels <= 0) return null;
  const ratio = largestPixels / pixels;
  if (ratio < 2) return null;
  const times = Math.round(ratio);
  return { times, severe: ratio >= 4, label: i18n.t("controlDash:dupes.timesSmaller", { times }) };
}

/** The sentence the card must not swallow: a copy being deleted carries far more
 *  pixels than the copy being kept. The scan never proposes this any more (the keeper
 *  ladder rules it out), but a hand-flipped role can create it live, and it is the
 *  single most expensive mistake this page can let through. */
export function keeperMuchSmaller(members: SnapshotMember[]): boolean {
  const kept = members.filter((member) => member.role !== "delete" && pixelsOf(member) > 0);
  const doomed = members.filter((member) => member.role === "delete" && pixelsOf(member) > 0);
  if (kept.length === 0 || doomed.length === 0) return false;
  const bestKept = Math.max(...kept.map(pixelsOf));
  const bestDoomed = Math.max(...doomed.map(pixelsOf));
  return bestDoomed >= bestKept * 4;
}

/** Why a copy can no longer be acted on. Each is a different sentence on the page,
 *  because each has a different remedy. */
export type StaleReason = "missing" | "modified" | "protected";

export interface MemberCheck {
  memberId: string;
  path: string;
  libraryId: string;
  role: MemberRole;
  stale: StaleReason | null;
}

/** What GET …/check answers, and what a refused delete returns alongside its 409. */
export interface ResultCheck {
  resultId: string;
  ok: boolean;
  members: MemberCheck[];
  /** The copies standing in the way — empty when the offer is still good. */
  problems: MemberCheck[];
}

/** What "Delete all identical" would take under the filters currently on screen.
 *  Byte-identical sets only — never near-identical, which are judgements. */
export interface SweepPreview {
  results: number;
  copies: number;
  bytes: number;
}

export interface ResultsPage {
  results: SnapshotResult[];
  total: number;
  allResults: number;
  sweep: SweepPreview;
  page: number;
  perPage: number;
  isOwner: boolean;
}

export const EMPTY_PAYLOAD: JobsPayload = { activeJob: null, isOwner: false, libraries: [], history: [] };
export const EMPTY_RESULTS: ResultsPage = {
  results: [], total: 0, allResults: 0,
  sweep: { results: 0, copies: 0, bytes: 0 },
  page: 1, perPage: 25, isOwner: false
};

// ── Words for states ────────────────────────────────────────────────────────

/** JobStatus's own values already match the `dupes.status.*` key suffixes, so no
 *  lookup map is needed — the literal union types the template directly. */
export const statusWord = (status: JobStatus): string => i18n.t(`controlDash:dupes.status.${status}`);

/** A heading on the page. Not the same thing as a result_type: single files split into
 *  two sections by TIER, because "identical copies" and "the same picture as a different
 *  file" are different promises and must never be read as one list. */
export type SectionKey = "folder_set" | "contained" | "overlap" | "photo_set" | "near_set";

const SECTION_KEY_PREFIX: Record<SectionKey, "folderSet" | "contained" | "overlap" | "photoSet" | "nearSet"> = {
  folder_set: "folderSet",
  contained: "contained",
  overlap: "overlap",
  photo_set: "photoSet",
  near_set: "nearSet"
};

export function sectionHeading(key: SectionKey): { title: string; note: string } {
  const prefix = SECTION_KEY_PREFIX[key];
  return {
    title: i18n.t(`controlDash:dupes.sections.${prefix}Title`),
    note: i18n.t(`controlDash:dupes.sections.${prefix}Note`)
  };
}

/** The order sections are shown in: strongest statement about a folder first, loose
 *  files after it, and the judgement calls last. The server sorts results the same way,
 *  so a page can straddle the boundaries without headings jumping about. */
export const RESULT_SECTIONS: { key: SectionKey; type: ResultType; tier?: ResultTier }[] = [
  { key: "folder_set", type: "folder_set" },
  { key: "contained", type: "contained" },
  { key: "overlap", type: "overlap" },
  { key: "photo_set", type: "photo_set", tier: "exact" },
  { key: "near_set", type: "photo_set", tier: "near" }
];

/** The filter select speaks in sections; the API takes a type and a tier. One place
 *  translates, so the two can't drift. */
export const sectionQuery = (key: string): { type?: ResultType; tier?: ResultTier } => {
  const section = RESULT_SECTIONS.find((entry) => entry.key === key);
  return section ? { type: section.type, tier: section.tier } : {};
};

// What a cleanup of this kind can actually contain. A folder cleanup never holds a
// single-photo set and vice versa, so offering the other kind is a filter that can
// only ever empty the page.
export const typeFilters = (kind: DuplicateKind): { value: string; label: string }[] =>
  kind === "folders"
    ? [
      { value: "", label: i18n.t("controlDash:dupes.filterEverything") },
      { value: "folder_set", label: i18n.t("controlDash:dupes.filterFolderSet") },
      { value: "contained", label: i18n.t("controlDash:dupes.filterContained") },
      { value: "overlap", label: i18n.t("controlDash:dupes.filterOverlap") }
    ]
    : [
      { value: "", label: i18n.t("controlDash:dupes.filterEverything") },
      { value: "photo_set", label: i18n.t("controlDash:dupes.filterPhotoSet") },
      { value: "near_set", label: i18n.t("controlDash:dupes.filterNearSet") }
    ];

/** Order within each section of the results page. Both descending — either sort
 *  exists to surface the results worth doing first. */
export const sortOrders = (): { value: string; label: string }[] => [
  { value: "size", label: i18n.t("controlDash:dupes.sortLargest") },
  { value: "copies", label: i18n.t("controlDash:dupes.sortMostCopies") }
];

export const reviewFilters = (): { value: string; label: string }[] => [
  { value: "", label: i18n.t("controlDash:dupes.reviewAny") },
  { value: "unreviewed", label: i18n.t("controlDash:dupes.reviewUnreviewed") },
  { value: "reviewed", label: i18n.t("controlDash:dupes.reviewReviewed") },
  { value: "skipped", label: i18n.t("controlDash:dupes.reviewSkipped") }
];

export const cleanupKindSummary = (kind: DuplicateKind): string =>
  kind === "folders" ? i18n.t("controlDash:dupes.kindWholeFolders") : i18n.t("controlDash:dupes.kindSingleFiles");

/** The folders a result's copies survive in — the union the snapshot records, which
 *  is the sentence the older card could not say. */
export const keeperFolders = (result: SnapshotResult): SnapshotFolder[] =>
  result.folders.filter((folder) => folder.role !== "delete");

export const doomedFolder = (result: SnapshotResult): SnapshotFolder | undefined =>
  result.folders.find((folder) => folder.role === "delete");

/** A folder as a person reads it. An empty path means the file sits directly in the
 *  library's own folder, in no subfolder at all, and "." is what that place is
 *  called — the same label the older duplicate pages use (ROOT_LABEL in shared.tsx),
 *  so one place has one name across the whole app.
 *
 *  Tried and rejected: "Everything in this library" (reads as a claim about the
 *  library, not a location), "the top level" (reads as a folder somebody named),
 *  and the source directory's real name (accurate, but a third word for a place
 *  the card already identifies by library). */
export const folderLabel = (folder: Pick<SnapshotFolder, "folderPath">): string =>
  folder.folderPath || ".";

// The folder's path inside its library, written the way a shell writes a path: a
// leading slash meaning "the top of this library", not of the filesystem. The tile
// names the library on its own line, so repeating it here was both redundant and
// untrue — "/Test/FolderTwo" reads as a path, but "Test" is the library's NAME and
// the directory on disk is whatever its source is set to, so that path points at
// nothing.
export const folderLocation = (folder: SnapshotFolder): string =>
  folder.folderPath ? `/${folder.folderPath}` : "/";

// The gallery's own address for this folder. Each segment is encoded separately so
// a folder called "Holiday #2" or "50% off" survives the trip, while the slashes
// that separate them stay slashes. The library root has no segments at all, and the
// route's trailing slash is optional, so it lands on the library's top view.
export const galleryFolderHref = (folder: SnapshotFolder): string => {
  const path = folder.folderPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/gallery/folders/${path}?library=${encodeURIComponent(folder.libraryId)}`;
};

export const photoCountLabel = (count: number): string =>
  i18n.t("controlDash:dupes.photoCount", { count });

/** A copy's own name. Every path in a photo set ends in the same filename often enough
 *  that the folder is what tells them apart — but the name still leads, because it is
 *  what the set is called. */
export const fileNameOf = (path: string): string => path.split("/").pop() || path;

/** The folder holding a copy, as a path inside its library. Empty when the copy sits in
 *  no subfolder at all; the caller names that place, since the word for it belongs to
 *  the UI rather than to this file. */
export const folderOfPath = (path: string): string => {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
};
