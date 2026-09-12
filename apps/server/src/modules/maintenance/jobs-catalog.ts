// Recurring maintenance tasks. The set of jobs is fixed at startup: the system jobs
// are defined here, and each media type brings its own (its library scan, and for
// the gallery its photo/video/face chores) through the media-type registry
// (library/shared/media-types.ts) — so this module imports no media type. The
// scheduled_jobs table only stores per-key state (enabled, schedule, last/next run).
// Each job ships with a built-in default schedule (enabled + frequency + clock time);
// those defaults are seeded into the table on startup for any job the admin hasn't
// configured. Frequency, day, and time all remain editable from the Scheduled jobs tab.
//
// A single lightweight worker ticks periodically and runs any enabled job whose
// next_run_at has passed. Jobs can also be triggered on demand ("Run now").
import { db } from "../../db.js";
import { config } from "../../config.js";
import { purgeExpiredTrash } from "../library/shared/trash-retention.js";
import { purgeExpiredStories } from "../stories/crud.js";
import { listMediaTypes, type MediaJobCategory } from "../library/shared/media-types.js";
import { auditThumbnailStore, removeEmptyThumbnailDirs } from "../library/shared/thumbnail-audit.js";
import { startScheduledBackup } from "../backups/run.js";

const KEEP_JOB_LOGS = 100;

// What the job is about, so the admin page can group and colour-code a long list
// at a glance instead of making you read every label.
export type ScheduledJobCategory = MediaJobCategory | "system";

export interface ScheduledJobDef {
  key: string;
  label: string;
  description: string;
  category: ScheduledJobCategory;
  // Runs the task and returns a human-readable summary. Throws on failure.
  run: () => string;
  // Built-in defaults, applied when the admin hasn't configured this job yet.
  defaultEnabled: boolean;
  defaultFrequency: Frequency;
  defaultTime: string; // local clock time "HH:MM" the job runs at
  // Seed with a random quiet-hours time instead of defaultTime, so same-cadence
  // jobs (nightly library scans) don't all fire at the same moment. defaultTime
  // remains the fallback for rows that somehow predate seeding.
  randomizeDefaultTime?: boolean;
}

const SYSTEM_DEFINITIONS: ScheduledJobDef[] = [
  {
    key: "cleanup_job_logs",
    label: "Clean task history",
    description: `Delete completed and failed tasks beyond the most recent ${KEEP_JOB_LOGS}. Running and queued tasks are never removed.`,
    category: "system",
    defaultEnabled: true,
    defaultFrequency: "weekly",
    defaultTime: "00:30",
    run: () => {
      const result = db.prepare(`
        DELETE FROM jobs
        WHERE status IN ('completed', 'failed')
          AND id NOT IN (
            SELECT id FROM jobs ORDER BY created_at DESC LIMIT ?
          )
      `).run(KEEP_JOB_LOGS);
      return `Removed ${result.changes} old job record${result.changes === 1 ? "" : "s"} (kept the newest ${KEEP_JOB_LOGS}).`;
    }
  },
  {
    // The activity log and the sign-in attempts are the two tables that keep visitor
    // IP addresses — including guests opening a share link — and nothing else ever
    // deletes from them. Off by default: the Dashboard's "All time" figures read the
    // same rows, so trading history for privacy is the admin's call, made here. The
    // window is ACTIVITY_LOG_RETENTION_DAYS (365 unless set).
    key: "prune_activity_log",
    label: "Prune the activity log",
    description: `Delete activity log entries and sign-in attempts older than ${config.activityLogRetentionDays} days. They record the IP address of every visitor, guests on share links included. Older history then no longer counts towards the Dashboard's all-time figures. Set ACTIVITY_LOG_RETENTION_DAYS to change the window.`,
    category: "system",
    defaultEnabled: false,
    defaultFrequency: "monthly",
    defaultTime: "00:15",
    run: () => {
      const cutoff = new Date(Date.now() - config.activityLogRetentionDays * 86_400_000).toISOString();
      const events = db.prepare("DELETE FROM activity_logs WHERE created_at < ?").run(cutoff).changes;
      const attempts = db.prepare("DELETE FROM login_attempts WHERE created_at < ?").run(cutoff).changes;
      return `Removed ${events} activity log entr${events === 1 ? "y" : "ies"} and ${attempts} sign-in attempt${attempts === 1 ? "" : "s"} older than ${config.activityLogRetentionDays} days.`;
    }
  },
  {
    // Removes empty folders and REPORTS unreferenced files rather than deleting them.
    // The asymmetry is the point: an empty folder references nothing, but "no row
    // points at this file" does not mean the file is junk — derived siblings like a
    // book's -cover-large.webp and a video's -web.mp4 are stored in no column by
    // design, and a store audited by hand held 322 of those against 16 real orphans.
    // Deleting on that signal, unattended and weekly, is how live thumbnails go
    // missing. The count is here so the number is visible if it ever climbs.
    key: "tidy_thumbnail_store",
    label: "Tidy the thumbnail store",
    description: "Remove empty folders left behind in the thumbnail store by deletions, and report how many cover files nothing in the catalog points at any more. Only empty folders are removed — unreferenced files are counted, never deleted, because some cover art is generated rather than recorded.",
    category: "system",
    defaultEnabled: true,
    defaultFrequency: "monthly",
    defaultTime: "01:45",
    run: () => {
      const removed = removeEmptyThumbnailDirs();
      const { files, orphans } = auditThumbnailStore();
      const folders = removed === 0
        ? "No empty folders to remove"
        : `Removed ${removed} empty folder${removed === 1 ? "" : "s"}`;
      if (files === 0) return `${folders}. The thumbnail store is empty or not configured.`;
      const unreferenced = orphans === 0
        ? "every file is still pointed at by the catalog"
        : `${orphans} of ${files} file${files === 1 ? "" : "s"} unreferenced (left in place)`;
      return `${folders}; ${unreferenced}.`;
    }
  },
  {
    // Replaced "Empty recycle bin" (3.24.0 and earlier), which emptied the whole bin on a
    // cadence regardless of retention — shipping enabled, that quietly made the 30-day
    // window mean nothing, and installs that never asked for it lost deleted items a week
    // after deleting them. This one only removes what has served its own promised time.
    // Emptying the bin outright is a deliberate act, and stays a button on the bin's page.
    key: "purge_expired_trash",
    label: "Purge expired recycle bin items",
    description: "Permanently delete recycle bin items that have outlived the retention window they were given when they were deleted (30 days by default). Anything still inside its window is left alone. To clear the bin regardless of retention, use Empty bin on the Recycle Bin page.",
    category: "system",
    defaultEnabled: true,
    defaultFrequency: "daily",
    defaultTime: "00:45",
    run: () => {
      // The in-process sweeper (startTrashPurgeWorker) does this every six hours too; this
      // job is the visible face of it — a schedule an admin can see, move, or switch off.
      const { purged, eligible } = purgeExpiredTrash();
      // Deleted STORIES share the bin and its window; they are rows, not
      // files, so this can't fail the way an offline disk can.
      const stories = purgeExpiredStories();
      const storyNote = stories.purged > 0
        ? ` Also purged ${stories.purged} expired stor${stories.purged === 1 ? "y" : "ies"}.`
        : "";
      if (eligible === 0) {
        return stories.purged > 0
          ? `Purged ${stories.purged} expired stor${stories.purged === 1 ? "y" : "ies"}; no library items had outlived their window.`
          : "Nothing in the recycle bin has outlived its retention window — nothing purged.";
      }
      const noun = `item${eligible === 1 ? "" : "s"}`;
      if (purged === eligible) return `Purged ${purged} expired ${noun}.${storyNote}`;
      return `Purged ${purged} of ${eligible} expired ${noun} — the rest sit on storage that is offline right now, and are retried on the next run.${storyNote}`;
    }
  },
  // The two backup jobs. Off until the admin turns one on: a backup folder fills a
  // disk on its own, and the Backup page (which shows these same two rows) is where
  // the install is told how many of each kind to keep. Both start the run and
  // return; the file is written in the background and listed on the Backup page
  // when done.
  {
    key: "backup_full",
    label: "Back up everything (full)",
    description: "Write the database, its two-factor key and the whole thumbnail store into one .zip in the backup folder — everything a restore needs, rendered previews and face crops included, so nothing has to be made again afterwards. The newest N full backups are kept, N being the count for full backups on the Backup page.",
    category: "system",
    defaultEnabled: false,
    defaultFrequency: "weekly",
    defaultTime: "03:30",
    run: () => startScheduledBackup("full")
  },
  {
    key: "backup_minimal",
    label: "Back up the database (minimal)",
    description: "Write the database, its two-factor key and the pictures a rescan could not put back into a small .zip — covers you uploaded or the app fetched, series covers, author portraits, category tiles, family-tree portraits. Previews and face crops are left out; those are made from your own files again. The newest N minimal backups are kept, N being the count for minimal backups on the Backup page.",
    category: "system",
    defaultEnabled: false,
    defaultFrequency: "daily",
    defaultTime: "03:00",
    run: () => startScheduledBackup("minimal")
  }
];

// Every job: the system ones above plus each registered media type's. Read at call
// time, never at import — the media types register from their plugins, which the
// server registers before this one.
export function definitions(): ScheduledJobDef[] {
  return [...SYSTEM_DEFINITIONS, ...listMediaTypes().flatMap((mediaType) => mediaType.scheduledJobs ?? [])];
}

export type Frequency = "daily" | "weekly" | "monthly";
