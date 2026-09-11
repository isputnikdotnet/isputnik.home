// What every tier of a cleanup job's snapshot shares: the file rows the scan reads
// once, the writer each tier writes through, what may never be deleted, and the
// (library, folder) keys they compare by. The tiers themselves are snapshot-*.ts;
// job-scan.ts runs them.

/** A folder holding a single photo is a duplicate photo, not a duplicate folder —
 *  the same gate the cached tier applies. */
export const MIN_FOLDER_FILES = 2;

export type MemberRole = "keep" | "delete" | "protected";

export interface ScanFile {
  itemId: string;
  libraryId: string;
  /** Path of the FILE relative to its library, which is what library_items stores. */
  path: string;
  hash: string | null;
  /** 64-bit dHash, for the near-identical tier. NULL on every video and on photos the
   *  catalog scan has not backfilled — those simply never join a near set. */
  phash: string | null;
  size: number | null;
  /** Both stamps are kept: `mtime` is what revalidation compares before deleting,
   *  `discoveredAt` is what the "added first" tiebreak reads. */
  mtime: string | null;
  discoveredAt: string;
  kind: string;
}

export const dirOf = (filePath: string): string => {
  const cut = filePath.lastIndexOf("/");
  return cut === -1 ? "" : filePath.slice(0, cut);
};

/** What may never be deleted, from two sources the scan treats identically: a
 *  protected LIBRARY (external / deleting turned off) and a locked FOLDER. `path`
 *  answers for one file or folder path — is it covered by either? `subtree` answers
 *  for a folder the scan wants to clear OUT — also true when a lock sits somewhere
 *  inside it, because clearing the folder would have to delete the locked part. */
export interface DeletionBlocks {
  path(libraryId: string, relPath: string): boolean;
  subtree(libraryId: string, folderPath: string): boolean;
}

// A (library, folder) pair as a map key. NUL separates the two because a folder
// path may contain anything else a filesystem allows — and because a plain space
// here once went in as a literal NUL through a tooling quirk, leaving two key
// formats that never matched and a folder answered twice.
export const SEP = String.fromCharCode(0);
export const folderKeyOf = (ref: { libraryId: string; folderPath: string }): string =>
  ref.libraryId + SEP + ref.folderPath;

export const isUnder = (folderPath: string, filePath: string): boolean =>
  folderPath === "" || filePath.startsWith(`${folderPath}/`);

// ── Writing the snapshot ────────────────────────────────────────────────────

export interface Writer {
  result: (input: {
    type: "photo_set" | "folder_set" | "contained" | "overlap";
    reclaimableBytes: number;
    keeperReason: string | null;
    /** Defaults to the byte-identical answer, which is what every tier but near is. */
    matchConfidence?: "certain" | "likely" | "unsure";
    /** Which criterion settled the keeper; -1 when nothing did. */
    keeperRank?: number;
  }) => string;
  folder: (resultId: string, input: {
    libraryId: string; folderPath: string; role: MemberRole; itemCount: number; bytes: number;
  }) => string;
  member: (resultId: string, input: {
    file: ScanFile; role: MemberRole; folderId?: string | null; keeperMemberId?: string | null;
    /** Bits from the keeper. Omitted — and so 0 — everywhere except a near-identical set. */
    distance?: number;
  }) => string;
}
