// What the duplicate cleanup server says, and the words the pages put on it.
//
// Kept apart from the components so the page, the job card, the wizard and the result
// cards all read the same shapes — and so a label like "." for the library's own folder
// has exactly one definition. No JSX in here on purpose: everything is a type, a
// constant, or a pure function of one.

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
  status: string;
  reviewStatus: "unreviewed" | "reviewed" | "skipped";
  reclaimableBytes: number;
  keeperReason: string | null;
  coverUrls?: string[];
  folders: SnapshotFolder[];
  members: SnapshotMember[];
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

export const STATUS_WORDS: Record<JobStatus, string> = {
  draft: "Not started",
  scanning: "Scanning",
  review: "Ready to review",
  processing: "Deleting",
  paused: "Paused",
  completed: "Finished",
  failed: "Stopped by an error",
  cancelled: "Cancelled"
};

/** A heading on the page. Not the same thing as a result_type: single files split into
 *  two sections by TIER, because "identical copies" and "the same picture as a different
 *  file" are different promises and must never be read as one list. */
export type SectionKey = "folder_set" | "contained" | "overlap" | "photo_set" | "near_set";

export const SECTION_HEADINGS: Record<SectionKey, { title: string; note: string }> = {
  folder_set: {
    title: "Identical folders",
    note: "The same pictures, file for file, whatever the folders are called. One is kept; the others can go whole."
  },
  contained: {
    title: "Folders already stored elsewhere",
    note: "Every photo in these folders also sits somewhere else, so the folder itself can go and nothing is lost."
  },
  overlap: {
    title: "Folders sharing some photos",
    note: "Two folders that hold some of the same pictures without either being a copy of the other — half a card re-imported, a \"best of\" pulled from several trips. Both folders stay: only the shared copies leave one side, and whatever each holds on its own is untouched."
  },
  photo_set: {
    title: "Identical files",
    note: "Byte-identical copies of one picture — the same file twice. One is kept and the rest can go."
  },
  // Deliberately does NOT say one copy is derived from the other. On a real library
  // most of what lands here is consecutive camera frames — IMG_1109 beside IMG_1110,
  // a second apart, near-identical sizes — and calling those "a re-compressed copy"
  // tells someone to delete a photograph they have never seen twice.
  near_set: {
    title: "Near-identical",
    note: "Pictures that LOOK the same but are different files. That can mean a resized or re-compressed copy — or two shots taken moments apart, which are two different photographs. Nothing here is a certainty: open them before deleting anything."
  }
};

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
      { value: "", label: "Everything" },
      { value: "folder_set", label: "Identical folders" },
      { value: "contained", label: "Stored elsewhere" },
      { value: "overlap", label: "Sharing photos" }
    ]
    : [
      { value: "", label: "Everything" },
      { value: "photo_set", label: "Identical files" },
      { value: "near_set", label: "Near-identical" }
    ];

export const REVIEW_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "Any state" },
  { value: "unreviewed", label: "Not looked at" },
  { value: "reviewed", label: "Looked at" },
  { value: "skipped", label: "Skipped" }
];

export const cleanupKindSummary = (kind: DuplicateKind): string =>
  kind === "folders" ? "whole folders" : "single files";

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
  `${count} photo${count === 1 ? "" : "s"}`;

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
