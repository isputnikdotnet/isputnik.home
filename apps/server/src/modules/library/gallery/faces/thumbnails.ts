// Face-crop thumbnails: a small square image of just the detected face, used as the
// person avatar (so an unnamed group shows the face, not the whole photo). Stored in
// the shared thumbnail store and served via /api/library/covers/<key>.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { db } from "../../../../db.js";
import { thumbnailStorageKey, thumbnailAbsolutePath } from "../../shared/thumbnail.js";
import { validateLibrarySource } from "../../shared/library-source.js";

const FACE_THUMB = 160;
const MARGIN = 1.4; // crop a bit wider than the box so the whole face/hair shows

// Crop one face (box = normalised [x,y,w,h] on the EXIF-upright image) and write a
// square webp. Returns the storage key, or null if the image can't be read.
export async function generateFaceThumb(
  libraryId: string,
  faceId: string,
  absolutePath: string,
  box: [number, number, number, number]
): Promise<string | null> {
  try {
    const meta = await sharp(absolutePath).rotate().metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) return null;

    const [bx, by, bw, bh] = box;
    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    const size = Math.max(bw, bh) * MARGIN;
    let left = Math.round((cx - size / 2) * width);
    let top = Math.round((cy - size / 2) * height);
    let w = Math.round(size * width);
    let h = Math.round(size * height);
    left = Math.max(0, Math.min(left, width - 1));
    top = Math.max(0, Math.min(top, height - 1));
    w = Math.max(1, Math.min(w, width - left));
    h = Math.max(1, Math.min(h, height - top));

    const key = thumbnailStorageKey(libraryId, faceId, `${faceId}-face.webp`);
    const out = thumbnailAbsolutePath(key);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await sharp(absolutePath).rotate().extract({ left, top, width: w, height: h })
      .resize(FACE_THUMB, FACE_THUMB, { fit: "cover" }).webp({ quality: 80 }).toFile(out);
    return key;
  } catch {
    return null;
  }
}

interface MissingRow {
  id: string;
  box_x: number; box_y: number; box_w: number; box_h: number;
  library_id: string;
  source_path: string;
  relative_path: string;
}

// Backfill crops for already-detected faces that have no thumbnail yet (reuses the
// stored boxes — no re-detection). Lets existing libraries get face avatars without a
// full rescan. Best-effort and resumable; caches the validated source root per library.
export async function backfillFaceThumbnails(limit = 100000): Promise<number> {
  const rows = db.prepare(`
    SELECT gf.id AS id, gf.box_x AS box_x, gf.box_y AS box_y, gf.box_w AS box_w, gf.box_h AS box_h,
      li.library_id AS library_id, lib.source_path AS source_path, gd.relative_path AS relative_path
    FROM gallery_faces gf
    JOIN library_items li ON li.id = gf.item_id AND li.deleted_at IS NULL
    JOIN libraries lib ON lib.id = li.library_id
    JOIN gallery_details gd ON gd.item_id = li.id
    WHERE gf.source = 'scan' AND gf.thumb_storage_key IS NULL AND gf.box_x IS NOT NULL
    LIMIT ?
  `).all(limit) as MissingRow[];

  const roots = new Map<string, string | null>();
  const setThumb = db.prepare("UPDATE gallery_faces SET thumb_storage_key = ? WHERE id = ?");
  let made = 0;
  for (const row of rows) {
    if (!roots.has(row.library_id)) {
      try { roots.set(row.library_id, validateLibrarySource(row.source_path)); }
      catch { roots.set(row.library_id, null); }
    }
    const root = roots.get(row.library_id);
    if (!root) continue;
    const absolutePath = path.join(root, ...row.relative_path.split("/"));
    if (!fs.existsSync(absolutePath)) continue;
    const key = await generateFaceThumb(row.library_id, row.id, absolutePath, [row.box_x, row.box_y, row.box_w, row.box_h]);
    if (key) { setThumb.run(key, row.id); made += 1; }
  }
  return made;
}
