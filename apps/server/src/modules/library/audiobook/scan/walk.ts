// Finding the books on disk: which files form which book (grouping mode or a
// scan rule's layouts), and the companion documents beside them.
import fs from "node:fs";
import path from "node:path";
import { normaliseRelativePath } from "../../shared/storage-roots.js";
import { matchPattern, expandOptionalSections, type LayoutMatch } from "../../shared/scan-rule-pattern.js";
import { resolveOwnerIndexed, type OwnerIndex, type ScanRule } from "../../shared/scan-rules.js";
import { discNumberFromFolderName } from "./folder-parse.js";
import type { AudioFileEntry, AudiobookSettings, DocumentEntry, GroupingMode } from "./types.js";

// Companion documents bundled with an audiobook (e.g. a PDF supplement or the
// ebook edition). Collected during scan but never treated as audio tracks.
const documentMimeTypes: Record<string, string> = {
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
  ".mobi": "application/x-mobipocket-ebook",
  ".azw3": "application/vnd.amazon.ebook"
};
const documentExtensions = new Set(Object.keys(documentMimeTypes));

// Dotted extension set for path.extname comparisons, from the dotless settings list.
function scanExtensionSet(settings: AudiobookSettings) {
  return new Set(settings.scan_extensions.map((extension) => `.${extension}`));
}

// Who a scan-rule-owned book belongs to and what its layouts read from the path.
export interface BookOwner {
  ruleId: string;
  anchor: string;
  fields: LayoutMatch;
}

// Scan-rule ownership for the walk: the preloaded index, an output map (book folder
// → owner) the walk fills in, and optionally ONE rule to confine the walk to (a
// rule-scoped scan starts at that rule's folders and ignores everything else).
export interface WalkOwnership {
  index: OwnerIndex;
  owners: Map<string, BookOwner>;
  onlyRuleId?: string | null;
}

// Distinct segment depths a layout can match (optional sections make these vary),
// deepest first.
function layoutDepths(layout: string): number[] {
  const variants = expandOptionalSections(layout);
  const list = Array.isArray(variants) ? variants : [];
  const depths = new Set(list.map((v) => v.split("/").map((s) => s.trim()).filter(Boolean).length));
  return [...depths].sort((a, b) => b - a);
}

// Inside a rule, the book is the directory at the depth of the first layout that
// fits (tried in order, each at its own depth). A path no layout fits still forms a
// book — at the deepest layout depth it can reach — so it is catalogued without
// path-derived fields rather than dropped. A loose file directly in the anchor has
// no directory to be a book, so the file itself is the book (as file_per_book does).
export function ruleBookFolder(rule: ScanRule, anchor: string, relativeDirs: string[]): { key: string | null; fields: LayoutMatch } {
  for (let i = 0; i < rule.layouts.length; i++) {
    for (const depth of layoutDepths(rule.layouts[i])) {
      if (depth === 0 || relativeDirs.length < depth) continue;
      const key = relativeDirs.slice(0, depth).join("/");
      const m = matchPattern(rule.layouts[i], key);
      if (m.matched) return { key: anchor ? `${anchor}/${key}` : key, fields: { ...m, layoutIndex: i } };
    }
  }
  const maxDepth = Math.min(Math.max(0, ...rule.layouts.map((l) => layoutDepths(l)[0] ?? 0)), relativeDirs.length);
  if (maxDepth === 0) return { key: null, fields: { matched: false, layoutIndex: null } };
  const key = relativeDirs.slice(0, maxDepth).join("/");
  return { key: anchor ? `${anchor}/${key}` : key, fields: { matched: false, layoutIndex: null } };
}

export async function walkAudiobookFiles(
  rootPath: string,
  settings: AudiobookSettings,
  groupingMode: GroupingMode = "folder_hierarchy",
  ownership: WalkOwnership | null = null
) {
  const extensions = scanExtensionSet(settings);
  const filesByBookFolder = new Map<string, AudioFileEntry[]>();
  const onlyRule = ownership?.onlyRuleId ? ownership.index.rules.get(ownership.onlyRuleId) ?? null : null;

  const walk = async (currentPath: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      // Hidden entries are never books or tracks: upload staging folders
      // (.upload-*), macOS ._ resource forks, NAS metadata dirs, etc.
      if (entry.name.startsWith(".")) return;
      const absolutePath = path.join(currentPath, entry.name);

      if (entry.isSymbolicLink()) {
        try {
          const real = await fs.promises.realpath(absolutePath);
          if (!real.startsWith(`${rootPath}${path.sep}`)) return;
        } catch {
          return;
        }
      }

      if (entry.isDirectory()) {
        await walk(absolutePath);
        return;
      }

      if (!entry.isFile()) return;

      const extension = path.extname(entry.name).toLowerCase();
      if (!extensions.has(extension)) return;

      const folderPath = path.dirname(absolutePath);
      const discHint = discNumberFromFolderName(path.basename(folderPath));
      const relativePath = normaliseRelativePath(path.relative(rootPath, absolutePath));
      let bookFolderPath: string;
      let owner: BookOwner | null = null;
      const dirs = relativePath.split("/").slice(0, -1);
      const resolved = ownership ? resolveOwnerIndexed(ownership.index, dirs.join("/")) : null;
      if (ownership && ownership.onlyRuleId && resolved?.rule.id !== ownership.onlyRuleId) {
        // A rule-scoped walk: files another owner (or the default scanner) holds
        // are somebody else's business.
        return;
      }
      if (resolved) {
        // Inside a scan rule the layouts draw the book boundary, and every file
        // beneath it — disc folders, "Part 2", anything — is a track of that book.
        const anchorDepth = resolved.anchor ? resolved.anchor.split("/").length : 0;
        const { key, fields } = ruleBookFolder(resolved.rule, resolved.anchor, dirs.slice(anchorDepth));
        bookFolderPath = key === null ? absolutePath : path.join(rootPath, ...key.split("/"));
        owner = { ruleId: resolved.rule.id, anchor: resolved.anchor, fields };
      } else if (groupingMode === "file_per_book" && !relativePath.includes("/")) {
        // A loose file at the library root is its own book; the "book folder" IS the
        // file (folder_path becomes the file's relative name — unique per book).
        bookFolderPath = absolutePath;
      } else if (groupingMode === "top_level_folder") {
        // The first path segment under the root is the book; files directly in the
        // root group under the root itself.
        const topSegment = relativePath.split("/")[0];
        bookFolderPath = relativePath.includes("/") ? path.join(rootPath, topSegment) : rootPath;
      } else {
        // folder_hierarchy (and file_per_book's subfolder files): the containing
        // folder — or its parent when this is a part/disc folder of a book. A part
        // folder directly under the library root stays a book of its own: a flat
        // library of "Author - Title Part 1", "… Part 2" folders must not collapse
        // into one phantom root book.
        const parent = path.dirname(folderPath);
        bookFolderPath = discHint !== null && parent !== rootPath ? parent : folderPath;
      }

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(absolutePath);
      } catch {
        return;
      }

      const existing = filesByBookFolder.get(bookFolderPath) ?? [];
      existing.push({ absolutePath, fileName: entry.name, relativePath, stat, discHint });
      filesByBookFolder.set(bookFolderPath, existing);
      if (owner && ownership) ownership.owners.set(bookFolderPath, owner);
    }));
  };

  if (onlyRule) {
    // Confined to one rule: start at its folders instead of the whole library.
    for (const rulePath of onlyRule.paths) {
      await walk(rulePath ? path.join(rootPath, ...rulePath.split("/")) : rootPath);
    }
  } else {
    await walk(rootPath);
  }
  return filesByBookFolder;
}

// `gatherAll`: every audio file beneath the folder is a track, whatever its subfolder
// is called — the rule-owned book boundary (and top_level_folder grouping).
export function readBookFolderFiles(rootPath: string, folderAbsolutePath: string, settings: AudiobookSettings, groupingMode: GroupingMode = "folder_hierarchy", gatherAll = false): AudioFileEntry[] {
  const extensions = scanExtensionSet(settings);

  // Single-file book (file_per_book): the "folder" is actually the audio file itself,
  // so a rescan re-reads just that one file rather than trying to list a directory.
  let rootStat: fs.Stats | null = null;
  try { rootStat = fs.statSync(folderAbsolutePath); } catch { return []; }
  if (rootStat.isFile()) {
    const extension = path.extname(folderAbsolutePath).toLowerCase();
    if (!extensions.has(extension)) return [];
    const relativePath = normaliseRelativePath(path.relative(rootPath, folderAbsolutePath));
    return [{ absolutePath: folderAbsolutePath, fileName: path.basename(folderAbsolutePath), relativePath, stat: rootStat, discHint: null }];
  }

  const files: AudioFileEntry[] = [];

  const scanDir = (dir: string, discHint: number | null) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue; // hidden entries (staging, ._junk)
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hint = discNumberFromFolderName(entry.name);
        // top_level_folder: every nested folder belongs to this book, not just
        // disc-named ones (disc names still provide track-ordering hints).
        if (hint !== null || gatherAll || groupingMode === "top_level_folder") {
          scanDir(absolutePath, hint);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!extensions.has(extension)) continue;
      const relativePath = normaliseRelativePath(path.relative(rootPath, absolutePath));
      files.push({ absolutePath, fileName: entry.name, relativePath, stat: fs.statSync(absolutePath), discHint });
    }
  };

  scanDir(folderAbsolutePath, null);
  return files;
}

// Collect companion documents (PDF/EPUB/…) anywhere inside a book's folder.
export function readBookFolderDocuments(rootPath: string, folderAbsolutePath: string): DocumentEntry[] {
  const documents: DocumentEntry[] = [];

  const scanDir = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // hidden entries (staging, ._junk)
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!documentExtensions.has(extension)) continue;
      let size = 0;
      try {
        size = fs.statSync(absolutePath).size;
      } catch {
        continue;
      }
      documents.push({
        relativePath: normaliseRelativePath(path.relative(rootPath, absolutePath)),
        format: extension.slice(1),
        mimeType: documentMimeTypes[extension],
        size
      });
    }
  };

  scanDir(folderAbsolutePath);
  return documents;
}
