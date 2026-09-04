import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

// Reading a backup zip without holding it in memory.
//
// adm-zip (used elsewhere for EPUBs, which are small) loads the whole archive
// through fs.readFileSync, and Node refuses to read more than 2 GiB that way —
// "File size (…) is greater than 2 GiB". A full backup carrying the thumbnail
// cache passes that line easily, and the failure lands on restore: the moment the
// backup matters most. yauzl reads the central directory and then seeks to just
// the entries asked for, so size stops being a factor.

// Whether an entry is a file — zip directories are entries whose name ends in "/".
function isFile(entryName: string): boolean {
  return !entryName.endsWith("/");
}

async function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // lazyEntries: we pull entries one at a time, so an entry can be streamed to
    // disk before the next one arrives instead of racing ahead of the writes.
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zipFile) => {
      if (err || !zipFile) reject(err ?? new Error("Could not open the backup archive."));
      else resolve(zipFile);
    });
  });
}

// Walk every file entry in the archive, handing each name to `visit`. The walk
// stops early when `visit` returns false, which is what makes the "is there a
// database in here" check cost the central directory and nothing more.
async function walk(zipFile: yauzl.ZipFile, visit: (entry: yauzl.Entry) => Promise<boolean>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    zipFile.on("entry", (entry: yauzl.Entry) => {
      if (!isFile(entry.fileName)) {
        zipFile.readEntry();
        return;
      }
      visit(entry).then(
        (keepGoing) => { if (keepGoing) zipFile.readEntry(); else resolve(); },
        reject
      );
    });
    zipFile.on("end", () => resolve());
    zipFile.on("error", reject);
    zipFile.readEntry();
  });
}

// True when the archive holds an entry whose name satisfies `matches`.
export async function zipHasEntry(filePath: string, matches: (entryName: string) => boolean): Promise<boolean> {
  const zipFile = await openZip(filePath);
  let found = false;
  try {
    await walk(zipFile, async (entry) => {
      if (!matches(entry.fileName)) return true;
      found = true;
      return false;
    });
  } finally {
    zipFile.close();
  }
  return found;
}

// Extract the entries `destinationFor` claims, streaming each straight to the path
// it returns (null skips the entry). Returns how many files were written. The
// caller owns the destinations: this writes wherever it is told, so a caller
// deriving paths from entry names must still contain them itself.
export async function extractFromZip(
  filePath: string,
  destinationFor: (entryName: string) => string | null
): Promise<number> {
  const zipFile = await openZip(filePath);
  let written = 0;
  try {
    await walk(zipFile, async (entry) => {
      const dest = destinationFor(entry.fileName);
      if (!dest) return true;

      const source = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
        zipFile.openReadStream(entry, (err, stream) => {
          if (err || !stream) reject(err ?? new Error(`Could not read "${entry.fileName}" from the backup.`));
          else resolve(stream);
        });
      });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await pipeline(source, fs.createWriteStream(dest));
      written += 1;
      return true;
    });
  } finally {
    zipFile.close();
  }
  return written;
}

// The database inside a backup, at the root or under a single wrapping folder.
export function isBackupDatabaseEntry(entryName: string): boolean {
  return entryName === "database.sqlite" || entryName.endsWith("/database.sqlite");
}

// The MFA encryption key inside a backup, matched the same way. Absent from backups
// written before this shipped, and from any install that sets MFA_ENCRYPTION_KEY.
export function isBackupMfaKeyEntry(entryName: string): boolean {
  return entryName === "mfa.key" || entryName.endsWith("/mfa.key");
}
