// Family-tree portraits: always an image of the tree's own, in the thumbnail
// store's 'familytree' bucket (docs/people-sharing-plan.md, phases 3 and 4).
//
// A portrait chosen from the gallery used to be that photo's cover, served from
// the photo LIBRARY's thumbnails — which the covers route refuses to anyone who
// cannot open that library, so a relative without it saw blank faces all over the
// tree. Choosing a portrait is an editor publishing it, so it is rendered into the
// tree's own bucket instead, which everyone who can read the tree can see.
//
// A portrait can be cut from a group photo: `crop` is a frame in fractions of the
// photo AS SHOWN (EXIF orientation and the user's rotation applied — the same
// frame face boxes use, catalog-asset.ts). An explicit crop is also kept as a
// file in App files → Family tree → Portraits, marked derived so the face scan
// skips it.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { db } from "../../db.js";
import { renderInTurn, thumbnailAbsolutePath, thumbnailStorageKey } from "../library/shared/thumbnail.js";
import { validateLibrarySource } from "../library/shared/library-source.js";
import { normaliseRelativePath } from "../library/shared/storage-roots.js";
import { canUserAccessBook } from "../library/shared/library-access.js";
import { trashBook } from "../library/shared/trash.js";
import { TrashError } from "../library/shared/trash-settings.js";
import { decodePhotoToJpeg } from "../library/gallery/media.js";
import { scanSingleGalleryFile } from "../library/gallery/scanner.js";
import { uniqueGalleryFileName } from "../library/gallery/files.js";
import { getHouseLibrary, HOUSE_FOLDERS } from "../library/gallery/house-library.js";
import type { FamilyTreePersonRow, GalleryDetailRow, LibraryRow } from "../../db/rows.js";

/** Longest side of a rendered portrait, in pixels. */
const PORTRAIT_SIZE = 1024;
/** The folder under App files → Family tree that keeps cropped portraits. */
const PORTRAITS_FOLDER = "Portraits";

export interface PortraitCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

const fraction = z.number().min(0).max(1);
export const portraitCropSchema = z.object({ x: fraction, y: fraction, w: fraction, h: fraction })
  // A hair of slack for rounding on the client; the render clamps anyway.
  .refine((c) => c.w > 0.005 && c.h > 0.005 && c.x + c.w <= 1.001 && c.y + c.h <= 1.001, "The frame must lie on the photo.");

export class PortraitError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

type SourceRow = Pick<LibraryRow, "source_path"> & Pick<GalleryDetailRow, "relative_path" | "rotation" | "kind"> & {
  library_id: string;
};

function photoSource(itemId: string): { absolutePath: string; rotation: number; libraryId: string } | null {
  const row = db.prepare(`
    SELECT libraries.source_path, gd.relative_path, gd.rotation, gd.kind, li.library_id
    FROM library_items li
    JOIN libraries ON libraries.id = li.library_id
    JOIN gallery_details gd ON gd.item_id = li.id
    WHERE li.id = ? AND li.deleted_at IS NULL
  `).get(itemId) as SourceRow | undefined;
  if (!row || row.kind !== "photo") return null;
  let root: string;
  try { root = validateLibrarySource(row.source_path); } catch { return null; }
  return { absolutePath: path.join(root, ...row.relative_path.split("/")), rotation: row.rotation, libraryId: row.library_id };
}

/** Whether `user` may use this photo for a portrait: they must be able to see it. */
export function canUsePortraitPhoto(user: { id: string; role: string }, itemId: string): boolean {
  const row = db.prepare("SELECT library_id FROM library_items WHERE id = ? AND deleted_at IS NULL").get(itemId) as { library_id: string } | undefined;
  return row != null && canUserAccessBook(itemId, { id: row.library_id }, user.id, user.role, "gallery");
}

/** A square frame around one face box: the face about 45% of the frame's height,
 *  sitting a little above the middle so hair and shoulders fit, clamped to the
 *  photo. Box and result are fractions of the photo as shown; `width`/`height` are
 *  its pixel size, since "square" is square in pixels. Mirrored by the web cropper. */
export function frameAroundFace(box: PortraitCrop, width: number, height: number): PortraitCrop {
  const faceW = box.w * width;
  const faceH = box.h * height;
  const side = Math.min(Math.max(faceH, faceW) / 0.45, width, height);
  const cx = (box.x + box.w / 2) * width;
  const cy = (box.y + box.h / 2) * height;
  const left = Math.min(Math.max(cx - side / 2, 0), width - side);
  const top = Math.min(Math.max(cy - side * 0.42, 0), height - side);
  return { x: left / width, y: top / height, w: side / width, h: side / height };
}

/** The linked face-cluster's box on this photo, if the tree member is linked and
 *  appears on it — the frame a plain pick is cut to. Fractions of the photo as shown. */
function linkedFaceBox(personId: string, itemId: string, rotation: number): PortraitCrop | null {
  const row = db.prepare(`
    SELECT f.box_x, f.box_y, f.box_w, f.box_h
    FROM family_tree_persons p
    JOIN gallery_faces f ON f.person_id = p.gallery_person_id AND f.item_id = ?
    WHERE p.id = ? AND f.assignment != 'rejected'
      AND f.box_x IS NOT NULL AND f.box_y IS NOT NULL AND f.box_w IS NOT NULL AND f.box_h IS NOT NULL
    ORDER BY f.box_w * f.box_h DESC
    LIMIT 1
  `).get(itemId, personId) as { box_x: number; box_y: number; box_w: number; box_h: number } | undefined;
  if (!row) return null;
  return turnBox({ x: row.box_x, y: row.box_y, w: row.box_w, h: row.box_h }, rotation);
}

// Stored boxes are on the EXIF-oriented photo; the user's rotation turns them
// (sharp rotates clockwise). Same arithmetic as catalog-asset.ts.
function turnBox(box: PortraitCrop, rotation: number): PortraitCrop {
  const turn = ((rotation % 360) + 360) % 360;
  const point = (x: number, y: number) =>
    turn === 90 ? { x: 1 - y, y: x } : turn === 180 ? { x: 1 - x, y: 1 - y } : turn === 270 ? { x: y, y: 1 - x } : { x, y };
  const a = point(box.x, box.y);
  const b = point(box.x + box.w, box.y + box.h);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** The photo upright (EXIF orientation, then the user's rotation) as a JPEG, read
 *  from a Buffer — never by path, so libvips holds no handle on a file the library
 *  may rewrite (CLAUDE.md). Falls back to an ffmpeg decode for what sharp can't read. */
async function uprightPhoto(absolutePath: string, rotation: number): Promise<Buffer> {
  const upright = async (input: Buffer) => {
    const image = sharp(input, { failOn: "none" }).rotate();
    return (rotation ? image.rotate(rotation) : image).jpeg({ quality: 95 }).toBuffer();
  };
  try {
    return await upright(await fs.promises.readFile(absolutePath));
  } catch {
    const converted = await decodePhotoToJpeg(absolutePath);
    if (!converted) throw new PortraitError("That photo could not be read.", 422);
    return upright(converted);
  }
}

/** Cut `crop` (or the linked face, or nothing) out of the photo. One queued render —
 *  see renderInTurn; its steps run one after another, never side by side. */
async function renderFromPhoto(personId: string, itemId: string, crop: PortraitCrop | null): Promise<{ image: Buffer; frame: PortraitCrop | null }> {
  const source = photoSource(itemId);
  if (!source) throw new PortraitError("That photo is not in the gallery any more.", 404);
  let result: { image: Buffer; frame: PortraitCrop | null } | null = null;
  await renderInTurn([async () => {
    const upright = await uprightPhoto(source.absolutePath, source.rotation);
    const { width = 0, height = 0 } = await sharp(upright).metadata();
    if (width === 0 || height === 0) throw new PortraitError("That photo could not be read.", 422);
    const face = crop ? null : linkedFaceBox(personId, itemId, source.rotation);
    const frame = crop ?? (face ? frameAroundFace(face, width, height) : null);
    let image = sharp(upright);
    if (frame) {
      const left = Math.min(Math.max(Math.round(frame.x * width), 0), width - 1);
      const top = Math.min(Math.max(Math.round(frame.y * height), 0), height - 1);
      image = image.extract({
        left,
        top,
        width: Math.max(1, Math.min(Math.round(frame.w * width), width - left)),
        height: Math.max(1, Math.min(Math.round(frame.h * height), height - top))
      });
    }
    const out = await image
      .resize(PORTRAIT_SIZE, PORTRAIT_SIZE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    result = { image: out, frame };
  }]);
  return result!;
}

/** Keep a cropped portrait in App files → Family tree → Portraits, catalogued and
 *  marked derived. Null when App storage is off — the portrait is set regardless. */
async function keepInAppFiles(personName: string, sourceItemId: string, image: Buffer): Promise<string | null> {
  const library = getHouseLibrary();
  if (!library) return null;
  let root: string;
  try { root = validateLibrarySource(library.source_path); } catch { return null; }
  const dir = path.join(root, HOUSE_FOLDERS.familyTree, PORTRAITS_FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  const stem = personName.replace(/[<>:"/\\|?*]/g, "").trim() || "Portrait";
  const fileName = uniqueGalleryFileName(dir, `${stem}.jpg`) ?? `${stem} ${Date.now()}.jpg`;
  const finalPath = path.join(dir, fileName);
  fs.writeFileSync(finalPath, image);
  const itemId = await scanSingleGalleryFile(library.id, normaliseRelativePath(path.relative(root, finalPath)));
  if (!itemId) {
    fs.rmSync(finalPath, { force: true });
    return null;
  }
  db.transaction(() => {
    db.prepare("UPDATE gallery_details SET derived_from_item_id = ? WHERE item_id = ?").run(sourceItemId, itemId);
    // Should a face scan have reached it first, take back what it found.
    db.prepare("DELETE FROM gallery_faces WHERE item_id = ?").run(itemId);
    db.prepare("DELETE FROM gallery_face_scans WHERE item_id = ?").run(itemId);
  })();
  return itemId;
}

type PortraitState = Pick<FamilyTreePersonRow, "name" | "portrait_storage_key" | "portrait_file_item_id">;

function portraitState(personId: string): PortraitState | null {
  return (db.prepare("SELECT name, portrait_storage_key, portrait_file_item_id FROM family_tree_persons WHERE id = ?")
    .get(personId) as PortraitState | undefined) ?? null;
}

/** What a replaced or removed portrait leaves behind: its rendered image goes, and
 *  its App files copy goes to the Recycle Bin — unless the tree still uses it as
 *  a photo somewhere. */
async function discardPortrait(previous: PortraitState, keep: { storageKey?: string | null; fileItemId?: string | null }, userId: string): Promise<void> {
  if (previous.portrait_storage_key && previous.portrait_storage_key !== keep.storageKey) {
    await fs.promises.rm(thumbnailAbsolutePath(previous.portrait_storage_key), { force: true }).catch(() => {});
  }
  const fileItemId = previous.portrait_file_item_id;
  if (fileItemId && fileItemId !== keep.fileItemId) {
    const inUse = db.prepare(`
      SELECT 1 FROM family_tree_photos WHERE item_id = ?
      UNION SELECT 1 FROM family_tree_event_photos WHERE item_id = ?
      UNION SELECT 1 FROM family_tree_persons WHERE portrait_file_item_id = ? OR portrait_item_id = ?
    `).get(fileItemId, fileItemId, fileItemId, fileItemId);
    if (!inUse) {
      try { trashBook(fileItemId, userId); } catch (err) { if (!(err instanceof TrashError)) throw err; }
    }
  }
}

/** Set a person's portrait from a gallery photo: cut to `crop`, or — for a plain
 *  pick — to the linked face when the photo shows it, else the whole photo. An
 *  explicit crop is also kept in App files. The caller has checked edit rights on
 *  the person and that the user can see the photo. */
export async function setPortraitFromPhoto(
  personId: string,
  itemId: string,
  crop: PortraitCrop | null,
  userId: string
): Promise<{ keptInAppFiles: boolean }> {
  const previous = portraitState(personId);
  if (!previous) throw new PortraitError("Person not found", 404);
  const { image, frame } = await renderFromPhoto(personId, itemId, crop);
  const storageKey = thumbnailStorageKey("familytree", personId, `${personId}-portrait-${Date.now()}.jpg`);
  const absolutePath = thumbnailAbsolutePath(storageKey);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, image);
  const fileItemId = crop ? await keepInAppFiles(previous.name, itemId, image) : null;
  db.prepare(`
    UPDATE family_tree_persons
    SET portrait_storage_key = ?, portrait_item_id = ?, portrait_crop_json = ?, portrait_file_item_id = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(storageKey, itemId, frame ? JSON.stringify(frame) : null, fileItemId, personId);
  await discardPortrait(previous, { storageKey, fileItemId }, userId);
  return { keptInAppFiles: fileItemId != null };
}

/** Set an uploaded image as the portrait (the raw PUT route), or clear the
 *  portrait with `storageKey = null`. Either way the gallery source goes. */
export async function setUploadedPortraitFile(personId: string, storageKey: string | null, userId: string): Promise<void> {
  const previous = portraitState(personId);
  if (!previous) return;
  db.prepare(`
    UPDATE family_tree_persons
    SET portrait_storage_key = ?, portrait_item_id = NULL, portrait_crop_json = NULL, portrait_file_item_id = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(storageKey, personId);
  await discardPortrait(previous, { storageKey }, userId);
}

/** The folder under App files → Family tree an uploaded portrait's image moves to
 *  when someone first adjusts it. Not under Portraits: it is the family's photo,
 *  so it shows in the Gallery like the other family uploads. */
const UPLOADED_PORTRAITS_FOLDER = "Uploaded portraits";

/** The gallery photo a portrait can be re-cut from. A portrait uploaded straight
 *  to the tree (before every portrait came from a photo) has none: its image is
 *  copied into App files → Family tree → Uploaded portraits, catalogued, and
 *  becomes the portrait's source. The portrait itself is left as it is until the
 *  new frame is saved. */
export async function portraitSourcePhoto(personId: string): Promise<string> {
  const row = db.prepare("SELECT name, portrait_storage_key, portrait_item_id FROM family_tree_persons WHERE id = ?")
    .get(personId) as Pick<FamilyTreePersonRow, "name" | "portrait_storage_key" | "portrait_item_id"> | undefined;
  if (!row) throw new PortraitError("Person not found", 404);
  if (row.portrait_item_id && photoSource(row.portrait_item_id)) return row.portrait_item_id;
  if (!row.portrait_storage_key) throw new PortraitError("This person has no portrait to adjust.", 404);
  const library = getHouseLibrary();
  if (!library) {
    throw new PortraitError("App storage is off on this server. An admin can switch it on in Control panel → Library → Storage.", 409);
  }
  let image: Buffer;
  try {
    image = await fs.promises.readFile(thumbnailAbsolutePath(row.portrait_storage_key));
  } catch {
    throw new PortraitError("The portrait's image is missing.", 404);
  }
  const root = validateLibrarySource(library.source_path);
  const dir = path.join(root, HOUSE_FOLDERS.familyTree, UPLOADED_PORTRAITS_FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(row.portrait_storage_key).toLowerCase() || ".jpg";
  const stem = row.name.replace(/[<>:"/\\|?*]/g, "").trim() || "Portrait";
  const fileName = uniqueGalleryFileName(dir, `${stem}${ext}`) ?? `${stem} ${Date.now()}${ext}`;
  const finalPath = path.join(dir, fileName);
  fs.writeFileSync(finalPath, image);
  const itemId = await scanSingleGalleryFile(library.id, normaliseRelativePath(path.relative(root, finalPath)));
  if (!itemId) {
    fs.rmSync(finalPath, { force: true });
    throw new PortraitError("The portrait's image could not be read.", 422);
  }
  db.prepare("UPDATE family_tree_persons SET portrait_item_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(itemId, personId);
  return itemId;
}

/** The App files copy a person's portrait keeps, for the route to bin after the
 *  person is deleted. */
export function portraitFileItemId(personId: string): string | null {
  return portraitState(personId)?.portrait_file_item_id ?? null;
}

/** Bin a deleted person's App files portrait (the person row, and so its FK, are gone). */
export function discardPortraitFile(fileItemId: string, userId: string): void {
  const inUse = db.prepare(`
    SELECT 1 FROM family_tree_photos WHERE item_id = ?
    UNION SELECT 1 FROM family_tree_event_photos WHERE item_id = ?
    UNION SELECT 1 FROM family_tree_persons WHERE portrait_file_item_id = ? OR portrait_item_id = ?
  `).get(fileItemId, fileItemId, fileItemId, fileItemId);
  if (inUse) return;
  try { trashBook(fileItemId, userId); } catch (err) { if (!(err instanceof TrashError)) throw err; }
}

/** Portraits chosen from the gallery before 4.21 point at the photo's cover and
 *  have no image of their own; render one for each, one at a time. Run once at
 *  startup, in the background. A photo that can't be read keeps its old portrait
 *  (the cover), which still shows for anyone who can open its library. */
export async function renderPendingPortraits(): Promise<number> {
  const rows = db.prepare(`
    SELECT p.id, p.portrait_item_id FROM family_tree_persons p
    JOIN library_items li ON li.id = p.portrait_item_id AND li.deleted_at IS NULL
    WHERE p.portrait_storage_key IS NULL
  `).all() as Pick<FamilyTreePersonRow, "id" | "portrait_item_id">[];
  let done = 0;
  for (const row of rows) {
    try {
      const { image, frame } = await renderFromPhoto(row.id, row.portrait_item_id!, null);
      const storageKey = thumbnailStorageKey("familytree", row.id, `${row.id}-portrait-${Date.now()}.jpg`);
      const absolutePath = thumbnailAbsolutePath(storageKey);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, image);
      // Only if nobody changed the portrait while this one rendered.
      const changed = db.prepare(`
        UPDATE family_tree_persons SET portrait_storage_key = ?, portrait_crop_json = ?
        WHERE id = ? AND portrait_item_id = ? AND portrait_storage_key IS NULL
      `).run(storageKey, frame ? JSON.stringify(frame) : null, row.id, row.portrait_item_id).changes;
      if (changed === 0) fs.rmSync(absolutePath, { force: true });
      else done += 1;
    } catch {
      // Left as it was; the next start tries again.
    }
  }
  return done;
}
