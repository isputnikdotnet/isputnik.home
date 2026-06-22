// Dynamic series inference for the scanner. Pure functions over pre-computed
// folder context so they are unit-testable without touching disk. The engine is
// deliberately conservative: it only claims a series when confident, and falls
// back to "standalone" otherwise — it never turns an arbitrary folder (an author
// bin, a loose "collections" folder) into a series.
//
// Confidence order: in-file series metadata > a numbered sibling set > standalone.

export type SeriesReason = "file-series" | "numbered-folder" | "standalone";

// Counts for the folder that directly contains a book (computed once per folder
// by the scanner from its grouped books).
export interface FolderContext {
  bookCount: number;
  numberedBookCount: number;
}

export interface InferSeriesInput {
  // Book key relative to the library root, POSIX-separated, extension removed
  // (e.g. "ВСЕЛЕННАЯ/1. Земля лишних/1. Исход").
  groupKey: string;
  // Series carried by the file itself (FB2 <sequence>, EPUB calibre:series).
  fileSeries?: { name?: string | null; index?: number | null } | null;
  folder: FolderContext;
}

export interface InferredSeries {
  series?: string;
  position?: number;
  reason: SeriesReason;
}

const LEADING_ORDINAL = /^\s*(\d{1,4})\s*[.)\-]/;
const STRIP_LEADING_ORDINAL = /^\s*\d{1,4}\s*[.)\-]\s+/;

function baseName(groupKey: string): string {
  const i = groupKey.lastIndexOf("/");
  return i >= 0 ? groupKey.slice(i + 1) : groupKey;
}

function parentFolder(groupKey: string): string {
  const i = groupKey.lastIndexOf("/");
  if (i < 0) return "";
  const dir = groupKey.slice(0, i);
  const j = dir.lastIndexOf("/");
  return j >= 0 ? dir.slice(j + 1) : dir;
}

// The leading "1." / "01)" / "3 -" of a filename → its series position.
export function leadingPosition(name: string): number | undefined {
  const m = name.match(LEADING_ORDINAL);
  return m ? parseInt(m[1], 10) : undefined;
}

// Folder names often carry the same ordinal ("1. Земля лишних"); drop it.
export function cleanSeriesName(folderName: string): string {
  return folderName.replace(STRIP_LEADING_ORDINAL, "").trim();
}

// A folder reads as a series when it holds at least two books and the numbered
// ones are the majority — so a numbered set (with the odd companion) counts, but
// an author folder with one loose book, or a bin of unrelated titles, does not.
export function folderLooksLikeSeries(folder: FolderContext): boolean {
  return folder.numberedBookCount >= 2 && folder.numberedBookCount * 2 >= folder.bookCount;
}

export function inferSeries(input: InferSeriesInput): InferredSeries {
  const name = baseName(input.groupKey);

  const fileName = input.fileSeries?.name?.trim();
  if (fileName) {
    return {
      series: fileName,
      position: input.fileSeries?.index ?? leadingPosition(name),
      reason: "file-series"
    };
  }

  const folderName = parentFolder(input.groupKey);
  if (folderName && folderLooksLikeSeries(input.folder)) {
    const series = cleanSeriesName(folderName);
    if (series) {
      return { series, position: leadingPosition(name), reason: "numbered-folder" };
    }
  }

  return { reason: "standalone" };
}
