// Whole-photo tag → the face it must belong to.
//
// A Photo Inbox is never face-scanned (queue.ts), so Review mode's "Who is in it?"
// can only say that a person is SOMEWHERE in the photo: tagAssetPerson writes a
// box-less `manual` row. When the photo is later kept and scanned for real, that
// row and the detected face sit side by side, unconnected — the chip says "Mum"
// while the box over her face is still nobody, and because a manual row carries no
// embedding it can never pull the detection into her cluster.
//
// One case closes itself with no guessing: the photo has exactly ONE detected face
// and exactly ONE whole-photo tag. Then the tag can only be about that face, so
// the detection takes the person (confirmed — a human said it, and clustering pins
// confirmed faces), and the now-redundant manual row goes.
//
// Anything less certain is left alone. Two faces and one name does not say which
// one; two names and one face is a contradiction, not an answer. The one way this
// can be wrong is a photo of two people where the detector found only one of them
// and the reviewer named the other — rare on the single-face photos this touches,
// and undone by renaming the face.
import { db } from "../../../../db.js";
import type { GalleryFaceRow, NonNull } from "../../../../db/rows.js";

type TaggedFace = NonNull<Pick<GalleryFaceRow, "id" | "person_id">, "person_id">;

/** Adopt one photo's whole-photo tag onto its single detected face. Returns the
 *  person adopted, or null when the photo isn't the unambiguous case. Call inside
 *  the transaction that wrote the scan's faces. */
export function adoptWholePhotoTag(itemId: string): string | null {
  const tags = db.prepare(`
    SELECT id, person_id FROM gallery_faces
    WHERE item_id = ? AND source = 'manual' AND box_x IS NULL
      AND person_id IS NOT NULL AND assignment != 'rejected'
  `).all(itemId) as TaggedFace[];
  if (tags.length !== 1) return null;

  const detected = db.prepare(`
    SELECT id, person_id FROM gallery_faces
    WHERE item_id = ? AND source = 'scan' AND assignment != 'rejected'
  `).all(itemId) as Pick<GalleryFaceRow, "id" | "person_id">[];
  if (detected.length !== 1) return null;

  const tag = tags[0];
  const face = detected[0];
  // The face already belongs to someone else (named on an earlier pass and carried
  // through the rescan): that naming is the specific one, so it wins and the
  // whole-photo tag stays as the separate claim it is.
  if (face.person_id && face.person_id !== tag.person_id) return null;

  db.prepare(`
    UPDATE gallery_faces SET person_id = ?, assignment = 'confirmed',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(tag.person_id, face.id);
  db.prepare("DELETE FROM gallery_faces WHERE id = ?").run(tag.id);
  return tag.person_id;
}

/** The same adoption over every photo that already carries a stranded tag — for
 *  photos scanned before this existed. Runs with the Regroup faces job, ahead of
 *  its clustering pass so the adopted faces are pinned in it. */
export function adoptWholePhotoTags(): number {
  const items = db.prepare(`
    SELECT gf.item_id AS id FROM gallery_faces gf
    JOIN library_items li ON li.id = gf.item_id AND li.deleted_at IS NULL
    WHERE gf.source = 'manual' AND gf.box_x IS NULL
      AND gf.person_id IS NOT NULL AND gf.assignment != 'rejected'
    GROUP BY gf.item_id
    HAVING COUNT(*) = 1
  `).all() as { id: string }[];

  let adopted = 0;
  db.transaction(() => {
    for (const item of items) if (adoptWholePhotoTag(item.id)) adopted += 1;
  })();
  return adopted;
}
