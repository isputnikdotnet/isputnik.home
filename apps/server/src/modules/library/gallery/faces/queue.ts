// Face-scan job queue helpers + payload types. Deliberately dependency-light (db + nanoid
// only) and free of any ML imports, so modules that merely ENQUEUE a scan — e.g. the
// maintenance scheduler — don't transitively load arcface.ts / the native onnxruntime
// binding. The actual scan worker lives in scanner.ts.
import { nanoid } from "nanoid";
import { db } from "../../../../db.js";

export const faceJobType = "SCAN_GALLERY_FACES";

export interface ScanProgress {
  processed: number;
  total: number;
  startedAt: string;
}

export interface FaceScanPayload {
  libraryId?: string;
  force?: boolean;
  // A "recompute" job re-clusters existing embeddings without re-detecting anything.
  recompute?: boolean;
  // Live per-run progress, written into the job row so the UI can show a bar + ETA.
  progress?: ScanProgress;
}

export function enqueueFaceScan(libraryId: string, force = false): string {
  const jobId = nanoid(16);
  db.prepare("INSERT INTO jobs (id, type, payload, status) VALUES (?, ?, ?, 'pending')")
    .run(jobId, faceJobType, JSON.stringify({ libraryId, force } satisfies FaceScanPayload));
  return jobId;
}

// Re-cluster existing embeddings with the current settings — no re-detection. Cheap
// relative to a scan, so tuning grouping strength is near-instant.
export function enqueueFaceRecompute(): string {
  const jobId = nanoid(16);
  db.prepare("INSERT INTO jobs (id, type, payload, status) VALUES (?, ?, ?, 'pending')")
    .run(jobId, faceJobType, JSON.stringify({ recompute: true } satisfies FaceScanPayload));
  return jobId;
}
