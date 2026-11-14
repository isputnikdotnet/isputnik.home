// Verify a backup without restoring it (Diagnostics › iSputnik › Backups): open
// the zip, read every file in it through (so a damaged entry fails now, not on
// the day it's needed), read its manifest, and check the database inside is
// intact. The database is copied to a temporary folder for the check and
// removed after; nothing in the backup or the live data is changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { backupDir, type BackupFile } from "./run.js";
import { isBackupDatabaseEntry, isBackupManifestEntry, readEveryEntry } from "./zip-read.js";

export interface BackupVerification {
  name: string;
  createdAt: string;
  sizeBytes: number;
  /** Every check passed. */
  ok: boolean;
  /** How many files the zip holds, and how many bytes they come to unpacked. */
  files: number;
  bytes: number;
  manifest: { kind: string | null; version: string | null } | null;
  /** The database's integrity check: "ok", or the first problem SQLite names. */
  database: { found: boolean; integrity: string | null; tables: number } | null;
  error: string | null;
  ms: number;
}

/** A stream that counts what passes and keeps nothing. */
function counter(onBytes: (count: number) => void): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      onBytes(chunk.length);
      done();
    }
  });
}

export async function verifyBackup(file: BackupFile, onProgress: (files: number) => void = () => undefined): Promise<BackupVerification> {
  const started = performance.now();
  const result: BackupVerification = {
    name: file.name, createdAt: file.createdAt, sizeBytes: file.sizeBytes,
    ok: false, files: 0, bytes: 0, manifest: null, database: null, error: null, ms: 0
  };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-verify-"));
  const dbCopy = path.join(temp, "database.sqlite");
  let foundDb = false;
  try {
    const source = path.join(backupDir(), file.name);
    // A "database" backup is the database file itself, no zip around it.
    if (file.name.endsWith(".sqlite")) {
      await fs.promises.copyFile(source, dbCopy);
      foundDb = true;
      result.files = 1;
      result.bytes = file.sizeBytes;
    } else await readEveryEntry(source, async (name, source) => {
      result.files += 1;
      if (result.files % 200 === 0) onProgress(result.files);
      if (isBackupDatabaseEntry(name) && !foundDb) {
        foundDb = true;
        const sizer = counter((count) => { result.bytes += count; });
        const out = fs.createWriteStream(dbCopy);
        source.on("data", (chunk: Buffer) => sizer.write(chunk));
        await pipeline(source, out);
        return;
      }
      if (isBackupManifestEntry(name)) {
        const chunks: Buffer[] = [];
        for await (const chunk of source) chunks.push(Buffer.from(chunk as Buffer));
        const text = Buffer.concat(chunks).toString("utf8");
        result.bytes += text.length;
        try {
          const manifest = JSON.parse(text) as { kind?: unknown; version?: unknown; appVersion?: unknown };
          result.manifest = {
            kind: typeof manifest.kind === "string" ? manifest.kind : null,
            version: typeof manifest.version === "string" ? manifest.version : typeof manifest.appVersion === "string" ? manifest.appVersion : null
          };
        } catch {
          result.manifest = { kind: null, version: null };
        }
        return;
      }
      await pipeline(source, counter((count) => { result.bytes += count; }));
    });

    if (foundDb) {
      // Read-only, on the copy: the check never touches the live database.
      const copy = new Database(dbCopy, { readonly: true, fileMustExist: true });
      try {
        const rows = copy.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
        const integrity = rows.map((row) => row.quick_check).join("; ") || "unknown";
        const tables = (copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
        result.database = { found: true, integrity, tables };
      } finally {
        copy.close();
      }
    } else {
      result.database = { found: false, integrity: null, tables: 0 };
    }
    result.ok = Boolean(result.database?.found && result.database.integrity === "ok");
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    result.ms = Math.round(performance.now() - started);
  }
  return result;
}
