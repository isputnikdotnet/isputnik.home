import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { deleteSharesForResource } from "../shared/share-access.js";
import { deleteCollectionItemsForResource } from "../../collections/cleanup.js";
import { validateLibrarySource, LibrarySourceError } from "../shared/library-source.js";
import { libraryJobRunning } from "../shared/scan-lock.js";
import { requeueInterruptedJobs, releaseAbandonedScanLibraries } from "../shared/job-recovery.js";
import {
  normalizeLibrarySettings,
  normalizeScanSources,
  sourceEnabled,
  type ScanSourceConfig,
  type TagEncoding
} from "../shared/library-settings.js";
import { enrichLibraryAuthors } from "./enrich.js";
import { matchLayouts } from "../shared/scan-rule-pattern.js";
import {
  loadOwnerIndex, resolveOwner, getScanRule, keyRelativeToAnchor, markScanRulesScanned, normalizeRulePath,
  classifyPreviewChange, annotatePreviewRows, type OwnerIndex, type ScanRule, type RulePreviewRow
} from "../shared/scan-rules.js";
import { prepareBookScan } from "./scan/prepare.js";
import { writeBookScan } from "./scan/write.js";
import { readBookFolderFiles, walkAudiobookFiles, type BookOwner, type WalkOwnership } from "./scan/walk.js";
import type { AudiobookSettings, EffectiveScanConfig } from "./scan/types.js";

// The audiobook scan job: the queue, the worker, and the three ways in (a whole
// library, one book, a scan-rule preview). The steps of scanning a book live in
// scan/ — walk.ts finds the books on disk, prepare.ts reads each one (tags via
// tag-read.ts, metadata.json via sidecar.ts, names via folder-parse.ts, art via
// covers.ts), and write.ts stores it.

export { validateLibrarySource };

const scanJobType = "SCAN_AUDIOBOOK_LIBRARY";

export type { TagEncoding };

export interface ScanOptions {
  // One-shot override of the library's persisted scan_sources (rescan dialog).
  sources?: ScanSourceConfig[];
  tagEncoding?: TagEncoding;
  // Confine the scan to one scan rule's folders; only that rule's items are reconciled.
  ruleId?: string;
}

function resolveScanConfig(settingsJson: string, options: ScanOptions): EffectiveScanConfig {
  const settings = normalizeLibrarySettings("audiobook", settingsJson) as unknown as AudiobookSettings;
  const sources = options.sources ? normalizeScanSources("audiobook", options.sources) : settings.scan_sources;
  return {
    settings,
    sources,
    // single_file wins over folder_structure when both are (mistakenly) enabled.
    groupingMode: sourceEnabled(sources, "single_file")
      ? "file_per_book"
      : sourceEnabled(sources, "folder_structure") ? "top_level_folder" : "folder_hierarchy",
    forceReread: options.sources != null || options.tagEncoding != null,
    // Rescan override wins; otherwise the library's persisted default encoding.
    tagEncoding: options.tagEncoding ?? settings.tag_encoding
  };
}

async function scanAudiobookLibrary(libraryId: string, jobId: string | null = null, options: ScanOptions = {}) {
  const library = db.prepare("SELECT id, source_path, settings_json FROM libraries WHERE id = ? AND type = 'audiobook'")
    .get(libraryId) as { id: string; source_path: string; settings_json: string } | undefined;
  if (!library) {
    throw new Error("Audiobook library not found.");
  }

  const rootPath = validateLibrarySource(library.source_path);
  const config = resolveScanConfig(library.settings_json, options);
  db.prepare("UPDATE libraries SET scan_status = 'scanning', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(libraryId);

  // Scan rules partition the library: each enabled rule owns its folders (most
  // specific wins), the default scanner the rest. A rule-scoped run walks only that
  // rule's folders and later reconciles only its items.
  const scopeRule = options.ruleId ? getScanRule(options.ruleId) : null;
  if (options.ruleId && (!scopeRule || scopeRule.libraryId !== libraryId)) {
    db.prepare("UPDATE libraries SET scan_status = 'idle', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(libraryId);
    throw new Error("Scan rule not found.");
  }
  const ownership: WalkOwnership = { index: loadOwnerIndex(libraryId), owners: new Map(), onlyRuleId: scopeRule?.id ?? null };
  const filesByFolder = await walkAudiobookFiles(rootPath, config.settings, config.groupingMode, ownership);
  const entries = [...filesByFolder.entries()];
  const booksTotal = entries.length;
  const foundFolders = new Set<string>();
  let discoveredBooks = 0;
  let discoveredFiles = 0;
  let booksProcessed = 0;
  const bookErrors: string[] = [];
  let cancelled = false;
  let lastProgressUpdate = 0;

  const updateProgress = () => {
    if (!jobId) return;
    const now = Date.now();
    if (now - lastProgressUpdate < 3000 && booksProcessed % 5 !== 0) return;
    lastProgressUpdate = now;
    db.prepare("UPDATE jobs SET payload = ? WHERE id = ?").run(
      JSON.stringify({ libraryId, progress: { booksProcessed, booksTotal, updatedAt: new Date(now).toISOString() } }),
      jobId
    );
  };

  const CONCURRENCY = 4;
  let index = 0;

  const worker = async () => {
    while (!cancelled) {
      const i = index++;
      if (i >= entries.length) break;

      if (jobId) {
        const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string } | undefined;
        if (job?.status === "failed") {
          cancelled = true;
          break;
        }
      }

      const [folderAbsolutePath, files] = entries[i];
      try {
        const book = await prepareBookScan(libraryId, rootPath, config, folderAbsolutePath, files, ownership.owners.get(folderAbsolutePath) ?? null);
        db.transaction(() => writeBookScan(libraryId, book))();
        foundFolders.add(book.folderPath);
        discoveredBooks += 1;
        discoveredFiles += book.files.length;
      } catch (err) {
        const folder = folderAbsolutePath.replace(rootPath, "").replace(/^[\\/]/, "") || folderAbsolutePath;
        const msg = err instanceof Error ? err.message : String(err);
        bookErrors.push(`${folder}: ${msg}`);
      }

      booksProcessed++;
      updateProgress();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };

  if (entries.length > 0) {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  }

  if (cancelled) {
    db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(libraryId);
    throw new Error("Job cancelled");
  }

  if (bookErrors.length > 0 && discoveredBooks === 0) {
    db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(libraryId);
    throw new Error(`All books failed to scan:\n${bookErrors.join("\n")}`);
  }

  db.transaction(() => {
    // Reconcile only what this run could see: everything for a full scan, one
    // rule's items for a rule-scoped scan. A rule-scoped scan must never soft-delete
    // the rest of the library it did not walk.
    const knownBooks = (scopeRule
      ? db.prepare("SELECT id, folder_path FROM library_items WHERE library_id = ? AND deleted_at IS NULL AND scan_rule_id = ?").all(libraryId, scopeRule.id)
      : db.prepare("SELECT id, folder_path FROM library_items WHERE library_id = ? AND deleted_at IS NULL").all(libraryId)
    ) as { id: string; folder_path: string }[];
    for (const book of knownBooks) {
      if (!foundFolders.has(book.folder_path)) {
        db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(book.id);
        db.prepare("UPDATE audio_files SET status = 'missing', deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?").run(book.id);
        // The book is gone for users — drop its shares so links stop working and
        // owners' share lists stay accurate.
        deleteSharesForResource("audiobook", book.id);
        deleteCollectionItemsForResource("audiobook", book.id);
      }
    }
    db.prepare(`
      UPDATE libraries
      SET scan_status = 'idle', last_scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(libraryId);
    markScanRulesScanned(libraryId, scopeRule
      ? [scopeRule.id]
      : [...ownership.index.rules.values()].filter((rule) => rule.enabled).map((rule) => rule.id));
  })();

  // Author photos & bios, after books are committed and visible. Best-effort —
  // a network failure here never fails the scan.
  let authorsEnriched = 0;
  if (sourceEnabled(config.sources, "online_metadata")) {
    try {
      const result = await enrichLibraryAuthors(libraryId, {
        shouldCancel: jobId
          ? () => (db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string } | undefined)?.status === "failed"
          : undefined,
        onProgress: jobId
          ? (processed, total) => {
            db.prepare("UPDATE jobs SET payload = ? WHERE id = ?").run(
              JSON.stringify({ libraryId, progress: { booksProcessed, booksTotal, authorsProcessed: processed, authorsTotal: total, updatedAt: new Date().toISOString() } }),
              jobId
            );
          }
          : undefined
      });
      authorsEnriched = result.updated;
    } catch {
      // ignore — enrichment retries on the next scan
    }
  }

  return { discoveredBooks, discoveredFiles, bookErrors, authorsEnriched };
}

export async function rescanSingleBook(bookId: string, options: ScanOptions = {}) {
  const row = db.prepare(`
    SELECT library_items.id, library_items.folder_path, libraries.id AS library_id, libraries.source_path, libraries.settings_json
    FROM library_items
    JOIN libraries ON libraries.id = library_items.library_id
    WHERE library_items.id = ? AND library_items.deleted_at IS NULL
  `).get(bookId) as { id: string; folder_path: string; library_id: string; source_path: string; settings_json: string } | undefined;

  if (!row) {
    return null;
  }

  const rootPath = validateLibrarySource(row.source_path);
  const config = resolveScanConfig(row.settings_json, options);
  const folderAbsolutePath = path.join(rootPath, row.folder_path);

  if (!fs.existsSync(folderAbsolutePath)) {
    return null;
  }

  // A book inside a scan rule keeps that rule's boundary and layouts on a rescan
  // (restore from the bin, metadata reset), so it never slides back to the default
  // scanner's guesses.
  const resolved = resolveOwner(row.library_id, row.folder_path);
  const owner: BookOwner | null = resolved
    ? { ruleId: resolved.rule.id, anchor: resolved.anchor, fields: matchLayouts(resolved.rule.layouts, keyRelativeToAnchor(row.folder_path, resolved.anchor)) }
    : null;
  const files = readBookFolderFiles(rootPath, folderAbsolutePath, config.settings, config.groupingMode, owner !== null);
  if (files.length === 0) {
    return null;
  }

  const book = await prepareBookScan(row.library_id, rootPath, config, folderAbsolutePath, files, owner);
  db.transaction(() => writeBookScan(row.library_id, book))();

  if (sourceEnabled(config.sources, "online_metadata")) {
    try {
      await enrichLibraryAuthors(row.library_id, { bookId: book.bookId });
    } catch {
      // best-effort, like the full-library pass
    }
  }

  return book.bookId;
}

// Dry-run a scan rule's layouts over its selected folders for an audiobook library,
// writing nothing. Reuses the real walk (with a throwaway rule standing in for the
// one being edited) so the book boundaries the preview shows are the ones a scan
// would draw. `change` compares against today's catalog: a boundary that swallows
// several books today is reported as a merge, which is the case that loses progress.
export async function previewAudiobookRulePattern(
  libraryId: string,
  folders: string[],
  layouts: string[],
  ruleId: string | null = null,
  limit = 200
): Promise<RulePreviewRow[]> {
  const library = db.prepare("SELECT source_path, settings_json FROM libraries WHERE id = ? AND type = 'audiobook'")
    .get(libraryId) as { source_path: string; settings_json: string } | undefined;
  if (!library) return [];
  const rootPath = validateLibrarySource(library.source_path);
  const config = resolveScanConfig(library.settings_json, {});
  const now = new Date().toISOString();
  const previewRule: ScanRule = {
    id: "__preview__", libraryId, name: "Preview", enabled: true, preset: null, layouts,
    paths: folders.map((f) => normalizeRulePath(f)), isDefault: false, lastScannedAt: null, createdAt: now, updatedAt: now
  };
  const index: OwnerIndex = {
    rows: previewRule.paths.map((p) => ({ path: p, ruleId: previewRule.id, enabled: 1 })),
    rules: new Map([[previewRule.id, previewRule]])
  };
  const ownership: WalkOwnership = { index, owners: new Map(), onlyRuleId: previewRule.id };
  const filesByFolder = await walkAudiobookFiles(rootPath, config.settings, config.groupingMode, ownership);

  const rows: RulePreviewRow[] = [];
  const existingUnder = db.prepare(
    "SELECT folder_path FROM library_items WHERE library_id = ? AND deleted_at IS NULL AND (folder_path = ? OR folder_path LIKE ? ESCAPE '!')"
  );
  // '!' escapes LIKE's own wildcards; paths never contain it as a wildcard.
  const escapeLike = (v: string) => v.replace(/[!%_]/g, (c) => `!${c}`);
  for (const [folderAbsolutePath, files] of [...filesByFolder.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
    const owner = ownership.owners.get(folderAbsolutePath);
    if (!owner) continue;
    const folderPath = normaliseRelativePath(path.relative(rootPath, folderAbsolutePath)) || ".";
    const f = owner.fields;
    // Books catalogued today at or beneath this boundary: more than one, or one
    // that is not this exact folder, means the boundary is being redrawn.
    const today = existingUnder.all(libraryId, folderPath, `${escapeLike(folderPath)}/%`) as { folder_path: string }[];
    const change = today.length === 0 || (today.length === 1 && today[0].folder_path === folderPath)
      ? classifyPreviewChange(libraryId, folderPath, ruleId, f.matched)
      : `merges:${today.length}` as const;
    rows.push({
      path: folderPath, matched: f.matched, layoutIndex: f.layoutIndex,
      author: f.author, series: f.series, position: f.position, title: f.title, narrator: f.narrator, year: f.year, publisher: f.publisher,
      tracks: files.length, warnings: f.warnings ? [...f.warnings] : [], change
    });
    if (rows.length >= limit) break;
  }
  return annotatePreviewRows(rows);
}

export function enqueueAudiobookScan(libraryId: string, options: ScanOptions = {}) {
  const jobId = nanoid(16);
  db.prepare("UPDATE libraries SET scan_status = 'scanning', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(libraryId);
  db.prepare(`
    INSERT INTO jobs (id, type, payload, status)
    VALUES (?, ?, ?, 'pending')
  `).run(jobId, scanJobType, JSON.stringify({ libraryId, options }));
  return jobId;
}

let queueRunning = false;

export async function processAudiobookScanQueue() {
  if (queueRunning) {
    return;
  }

  queueRunning = true;
  try {
    // The same restart recovery the other scan workers run, and for the same reason:
    // a job left 'running' by a process that died goes back in the queue, and one
    // that has used every attempt is failed — and its library released — rather than
    // resurrected. Only reachable when no scan is in flight here (queueRunning guards
    // re-entry), so it can never take a job away from the pass that is running it.
    //
    // This was a 30-minute stale-lock sweep that requeued only jobs with attempts
    // left. Two problems it had: an interrupted scan sat 'running' for half an hour
    // before resuming, and one that had exhausted its attempts sat there forever —
    // which is worse than it sounds, because libraryJobRunning() then reports a scan
    // in progress for good and blocks every library and face job of every type, while
    // the library itself stays stuck on "Scanning…".
    releaseAbandonedScanLibraries(requeueInterruptedJobs(scanJobType).abandoned);

    while (true) {
      // One library job at a time server-wide: while another scan or face job is
      // running (whatever its type), leave the queue alone until the next poll.
      if (libraryJobRunning()) {
        break;
      }

      const job = db.prepare(`
        SELECT id, payload, attempts, max_attempts
        FROM jobs
        WHERE type = ?
          AND status = 'pending'
          AND run_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ORDER BY run_at, created_at
        LIMIT 1
      `).get(scanJobType) as { id: string; payload: string; attempts: number; max_attempts: number } | undefined;
      if (!job) {
        break;
      }

      const claimed = db.prepare(`
        UPDATE jobs
        SET status = 'running', attempts = attempts + 1, locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claimed.changes === 0) {
        continue;
      }

      const payload = JSON.parse(job.payload) as { libraryId: string; options?: ScanOptions };
      try {
        const result = await scanAudiobookLibrary(payload.libraryId, job.id, payload.options ?? {});
        db.prepare(`
          UPDATE jobs
          SET status = 'completed', payload = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL
          WHERE id = ?
        `).run(JSON.stringify({ ...payload, result }), job.id);
      } catch (err) {
        const currentStatus = (db.prepare("SELECT status FROM jobs WHERE id = ?").get(job.id) as { status: string } | undefined)?.status;
        if (currentStatus === "failed") {
          db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND scan_status = 'scanning'")
            .run(payload.libraryId);
          continue;
        }
        // A bad/missing source folder is a permanent configuration error: fail the
        // job at once instead of retrying for minutes while the library is stuck on
        // "scanning". The stack is noise for these, so keep just the message.
        const permanent = err instanceof LibrarySourceError;
        const message = err instanceof Error
          ? (permanent ? err.message : `${err.message}${err.stack ? `\n\nStack:\n${err.stack}` : ""}`)
          : "Audiobook scan failed";
        if (!permanent && job.attempts + 1 < job.max_attempts) {
          const runAt = new Date(Date.now() + Math.min(job.attempts + 1, 5) * 60_000).toISOString();
          db.prepare(`
            UPDATE jobs
            SET status = 'pending', run_at = ?, locked_at = NULL, locked_by = NULL, error = ?
            WHERE id = ?
          `).run(runAt, message, job.id);
        } else {
          db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(payload.libraryId);
          db.prepare(`
            UPDATE jobs
            SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ?
            WHERE id = ?
          `).run(message, job.id);
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

export function startAudiobookScanWorker() {
  const timer = setInterval(() => {
    void processAudiobookScanQueue();
  }, 2000);
  void processAudiobookScanQueue();
  return () => clearInterval(timer);
}
