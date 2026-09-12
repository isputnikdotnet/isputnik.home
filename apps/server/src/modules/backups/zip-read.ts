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

// The manifest every zip written since 4.3.0 carries (modules/backups/run.ts):
// which kind of backup it is and what of the thumbnail store went in. Matched the
// same way as the database, so a zip wrapped in a folder still answers.
export function isBackupManifestEntry(entryName: string): boolean {
  return entryName === "backup.json" || entryName.endsWith("/backup.json");
}

// Read one small entry out of an archive as text, without writing it anywhere.
// For the manifest and nothing bigger: the read stops at maxBytes and returns what
// it had, so an entry that is not what we expect cannot cost memory.
export async function readZipEntryText(
  filePath: string,
  matches: (entryName: string) => boolean,
  maxBytes = 64 * 1024
): Promise<string | null> {
  const zipFile = await openZip(filePath);
  let text: string | null = null;
  try {
    await walk(zipFile, async (entry) => {
      if (!matches(entry.fileName)) return true;
      const source = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
        zipFile.openReadStream(entry, (err, stream) => {
          if (err || !stream) reject(err ?? new Error(`Could not read "${entry.fileName}" from the backup.`));
          else resolve(stream);
        });
      });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of source) {
        const buffer = Buffer.from(chunk as Buffer);
        chunks.push(buffer);
        size += buffer.byteLength;
        if (size >= maxBytes) break;
      }
      text = Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
      return false;
    });
  } finally {
    zipFile.close();
  }
  return text;
}
