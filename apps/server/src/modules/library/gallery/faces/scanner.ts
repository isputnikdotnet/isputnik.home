// Face-detection job: walks a gallery library's photos, runs the in-process detector,
// and writes one gallery_faces row per detected face (box + embedding), then triggers
// clustering. Mirrors the gallery scan queue (jobs table, 2s poller). Resumable: an
// item is skipped once it has a gallery_face_scans row unless `force` is set.
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import { validateLibrarySource, LibrarySourceError } from "../../shared/library-source.js";
import { detectFaces, FACE_EMBEDDING_MODEL } from "./human-session.js";
import { embeddingToBlob } from "./embedding.js";
import { clusterGalleryFaces } from "./cluster.js";
import { faceRecognitionEnabledForLibrary } from "./settings.js";

const faceJobType = "SCAN_GALLERY_FACES";

interface FaceScanPayload {
  libraryId: string;
  force?: boolean;
}

interface PhotoRow {
  id: string;
  relative_path: string;
}

async function scanLibraryFaces(libraryId: string, force: boolean): Promise<{ items: number; faces: number; skipped?: boolean }> {
  if (!faceRecognitionEnabledForLibrary(libraryId)) return { items: 0, faces: 0, skipped: true };

  const library = db.prepare("SELECT id, source_path FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libraryId) as { id: string; source_path: string } | undefined;
  if (!library) throw new Error("Gallery library not found.");
  const root = validateLibrarySource(library.source_path);

  const photos = db.prepare(`
    SELECT li.id AS id, gd.relative_path AS relative_path
    FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    ${force ? "" : "LEFT JOIN gallery_face_scans s ON s.item_id = li.id"}
    WHERE li.library_id = ? AND li.deleted_at IS NULL AND li.status = 'ready' AND gd.kind = 'photo'
    ${force ? "" : "AND s.item_id IS NULL"}
  `).all(libraryId) as PhotoRow[];

  const insertFace = db.prepare(`
    INSERT INTO gallery_faces
      (id, item_id, box_x, box_y, box_w, box_h, det_score, embedding, embedding_model, assignment, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', 'scan')
  `);
  const markScanned = db.prepare(`
    INSERT INTO gallery_face_scans (item_id, scanned_at, model, face_count)
    VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET scanned_at = excluded.scanned_at, model = excluded.model, face_count = excluded.face_count
  `);

  let totalFaces = 0;
  for (const photo of photos) {
    const absolutePath = path.join(root, ...photo.relative_path.split("/"));
    let faces: Awaited<ReturnType<typeof detectFaces>> = [];
    try {
      if (fs.existsSync(absolutePath)) faces = await detectFaces(absolutePath);
    } catch {
      faces = []; // an undecodable image is still marked scanned (0 faces) so we don't retry it forever
    }
    db.transaction(() => {
      // Replace this item's auto-detected faces (idempotent rescan); manual whole-photo
      // tags (source 'manual') are left untouched.
      db.prepare("DELETE FROM gallery_faces WHERE item_id = ? AND source = 'scan'").run(photo.id);
      for (const face of faces) {
        insertFace.run(
          nanoid(16), photo.id, face.box[0], face.box[1], face.box[2], face.box[3],
          face.score, embeddingToBlob(face.embedding), FACE_EMBEDDING_MODEL
        );
      }
      markScanned.run(photo.id, FACE_EMBEDDING_MODEL, faces.length);
    })();
    totalFaces += faces.length;
  }

  clusterGalleryFaces();
  return { items: photos.length, faces: totalFaces };
}

export function enqueueFaceScan(libraryId: string, force = false): string {
  const jobId = nanoid(16);
  db.prepare("INSERT INTO jobs (id, type, payload, status) VALUES (?, ?, ?, 'pending')")
    .run(jobId, faceJobType, JSON.stringify({ libraryId, force } satisfies FaceScanPayload));
  return jobId;
}

let queueRunning = false;

export async function processFaceScanQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    db.prepare("UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL, error = NULL WHERE type = ? AND status = 'running'")
      .run(faceJobType);

    for (;;) {
      const job = db.prepare(`
        SELECT id, payload FROM jobs
        WHERE type = ? AND status = 'pending' AND datetime(run_at) <= datetime('now')
        ORDER BY datetime(run_at) ASC LIMIT 1
      `).get(faceJobType) as { id: string; payload: string } | undefined;
      if (!job) break;

      const claim = db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      const payload = JSON.parse(job.payload) as FaceScanPayload;
      try {
        const result = await scanLibraryFaces(payload.libraryId, payload.force ?? false);
        db.prepare("UPDATE jobs SET status = 'completed', payload = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL WHERE id = ?")
          .run(JSON.stringify({ ...payload, result }), job.id);
      } catch (err) {
        const permanent = err instanceof LibrarySourceError;
        const message = err instanceof Error ? err.message : "Face scan failed";
        const attempts = db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(job.id) as { attempts: number; max_attempts: number };
        if (!permanent && attempts.attempts < attempts.max_attempts) {
          db.prepare("UPDATE jobs SET status = 'pending', run_at = ?, locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(new Date(Date.now() + 5000).toISOString(), message, job.id);
        } else {
          db.prepare("UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(message, job.id);
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

export function startFaceScanWorker(): () => void {
  const timer = setInterval(() => { void processFaceScanQueue(); }, 2000);
  return () => clearInterval(timer);
}
