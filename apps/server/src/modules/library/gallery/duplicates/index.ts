// Duplicate detection and cleanup — the front door for the rest of the gallery module.
//
// What lives here, in the order the work happens:
//
//   items.ts       the size gate, the sha256 pass, the exact + near item tiers, keeper
//                  scoring, the folder instructions, and the background scan job
//   folders.ts     folder fingerprints and the three folder-shaped answers —
//                  identical, stored elsewhere, and overlapping
//
//   jobs.ts        a cleanup job: scope, status, ownership, totals
//   job-scan.ts    the job's own SNAPSHOT of what the digests say
//   job-review.ts  mark, dismiss, re-apply the job's folder instructions
//   job-resolve.ts revalidate against the library, then move copies to the Recycle Bin
//   job-routes.ts  the Duplicate cleanup page's API
//
// The split that matters: everything under `items`/`folders` writes a CACHE the older
// pages read, rebuilt whole by every scan; everything under `job-*` writes a SNAPSHOT
// the job owns and can come back to next week. The two share the digests and the
// keeper scoring, and nothing else — a job holds no foreign key into the cache,
// because a rebuild would empty it. See docs for the full picture.
export { galleryDuplicateJobRoutesPlugin } from "./job-routes.js";
export { startDuplicateScanWorker } from "./items.js";
