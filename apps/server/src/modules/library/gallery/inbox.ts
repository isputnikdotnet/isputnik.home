// Photo Inbox — a gallery library flagged `policy_json.inbox`, holding photos nobody
// has kept yet: a box of re-scanned prints, a relative's phone dump. Nothing in it
// is in the house until someone says so, and the review is the act of emptying it:
// every photo ends as Keep (moved into a real library), Replace (phase 2) or
// Discard (binned on the cleanup clock). Design: docs/photo-inbox-proposal.md.
//
// Two things live here — what an Inbox IS (the flag lookups every surface that
// must skip one consults) and what the review DOES (list, keep, discard). Moving a
// file is a general primitive in move.ts; this module only decides who may.
import { db } from "../../../db.js";
import { can, parsePolicy, type AuthUser } from "../../../core/permissions.js";
import { canUserAccessLibrary } from "../shared/library-access.js";
import { trashBook } from "../shared/trash.js";
import { TrashError } from "../shared/trash-settings.js";
import { ASSET_COLUMNS, ASSET_JOINS, mapAsset, type GalleryAssetRow } from "./catalog-asset.js";
import { moveGalleryAsset } from "./move.js";
import { dateFolderForCapture } from "./date-folder.js";
import type { GalleryDetailRow, LibraryItemRow, LibraryRow, Nullable } from "../../../db/rows.js";

export { photoInboxLibraryIds, isPhotoInboxLibrary } from "./inbox-flag.js";

/** One delivery: the top-level folder a batch arrived in ("" for files at the
 *  root), so a reviewer can tell Grandma's box from this morning's scanner run. */
export interface PhotoInboxDelivery {
  folder: string;
  count: number;
  /** How many of them someone has gone through in Review mode
   *  (docs/photo-review-plan.md) — "12 of 38 noted" on the chip. */
  reviewed: number;
  newestAt: string;
  /** Some of it arrived through a drop link (phase 3) rather than a scan or an
   *  upload by a member — the review can say whose box this is. */
  viaLink: boolean;
}

export interface PhotoInboxSummary {
  id: string;
  name: string;
  count: number;
  /** Photos in it that have been gone through in Review mode. */
  reviewed: number;
  /** Whether this user may keep or discard here: reviewing removes photos from
   *  the Inbox, so it takes the delete right on it. */
  canReview: boolean;
  /** Whether this user may write on the photos (dates, places, notes, people):
   *  the edit right. A contributor has this and not canReview — the relative who
   *  is asked what she remembers, and must not be able to Keep or Discard. */
  canEdit: boolean;
  deliveries: PhotoInboxDelivery[];
}

type InboxLibraryRow = Pick<LibraryRow, "id" | "name" | "policy_json">;

function inboxLibrary(libraryId: string): InboxLibraryRow | null {
  const row = db.prepare("SELECT id, name, policy_json FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libraryId) as InboxLibraryRow | undefined;
  return row && parsePolicy(row.policy_json).inbox === true ? row : null;
}

function canReview(user: AuthUser, library: InboxLibraryRow): boolean {
  return can(user, { objectType: "library", objectId: library.id, policy: parsePolicy(library.policy_json) }, "delete");
}

function canEdit(user: AuthUser, library: InboxLibraryRow): boolean {
  return can(user, { objectType: "library", objectId: library.id, policy: parsePolicy(library.policy_json) }, "edit");
}

const DELIVERY_SQL = `
  SELECT
    CASE WHEN instr(folder_path, '/') > 0 THEN substr(folder_path, 1, instr(folder_path, '/') - 1) ELSE '' END AS folder,
    COUNT(*) AS count,
    SUM(CASE WHEN gd.reviewed_at IS NOT NULL THEN 1 ELSE 0 END) AS reviewed,
    MAX(discovered_at) AS newest_at,
    MAX(EXISTS (SELECT 1 FROM share_link_drops d WHERE d.item_id = library_items.id)) AS via_link
  FROM library_items
  LEFT JOIN gallery_details gd ON gd.item_id = library_items.id
  WHERE library_id = ? AND deleted_at IS NULL
  GROUP BY folder
  ORDER BY newest_at DESC, folder`;

/** The Inboxes this user can open, with what is waiting in each. */
export function listPhotoInboxes(user: AuthUser): PhotoInboxSummary[] {
  const rows = db.prepare("SELECT id, name, policy_json FROM libraries WHERE type = 'gallery' ORDER BY name COLLATE NOCASE")
    .all() as InboxLibraryRow[];
  return rows
    .filter((row) => parsePolicy(row.policy_json).inbox === true && canUserAccessLibrary(row, user.id, user.role))
    .map((row) => {
      const deliveries = (db.prepare(DELIVERY_SQL).all(row.id) as { folder: string; count: number; reviewed: number | null; newest_at: string; via_link: number }[])
        .map((delivery) => ({
          folder: delivery.folder, count: delivery.count, reviewed: delivery.reviewed ?? 0,
          newestAt: delivery.newest_at, viaLink: delivery.via_link === 1
        }));
      return {
        id: row.id,
        name: row.name,
        count: deliveries.reduce((sum, delivery) => sum + delivery.count, 0),
        reviewed: deliveries.reduce((sum, delivery) => sum + delivery.reviewed, 0),
        canReview: canReview(user, row),
        canEdit: canEdit(user, row),
        deliveries
      };
    });
}

export interface PhotoInboxItemsQuery {
  /** null = every delivery; "" = files at the root; otherwise one top-level folder. */
  folder: string | null;
  limit: number;
  offset: number;
  /** "arrival" (default): newest arrival first, the review page's grid. "review":
   *  the order Review mode walks — file order, the way the prints went through
   *  the scanner (usually the order they were in the box), with the ones nobody
   *  has gone through yet first, so reopening continues where she stopped. */
  order?: "arrival" | "review";
}

/** The photos waiting in one Inbox, newest arrival first. Null when the library is
 *  not an Inbox this user can open. */
export function listPhotoInboxItems(
  user: AuthUser,
  libraryId: string,
  query: PhotoInboxItemsQuery
): { items: ReturnType<typeof mapAsset>[]; total: number } | null {
  const library = inboxLibrary(libraryId);
  if (!library || !canUserAccessLibrary(library, user.id, user.role)) return null;

  const where: string[] = ["library_items.library_id = ?", "library_items.deleted_at IS NULL"];
  const args: unknown[] = [libraryId];
  if (query.folder === "") {
    where.push("instr(library_items.folder_path, '/') = 0");
  } else if (query.folder != null) {
    where.push("library_items.folder_path LIKE ? ESCAPE '\\'");
    args.push(`${query.folder.replace(/[\\%_]/g, "\\$&")}/%`);
  }
  const whereSql = where.join(" AND ");

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM library_items WHERE ${whereSql}`).get(...args) as { n: number }).n;
  const orderSql = query.order === "review"
    ? "(gallery_details.reviewed_at IS NOT NULL), library_items.folder_path COLLATE NOCASE, library_items.id"
    : "library_items.discovered_at DESC, library_items.id";
  const rows = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    WHERE ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?
  `).all(user.id, ...args, query.limit, query.offset) as GalleryAssetRow[];
  return { items: rows.map(mapAsset), total };
}

/** What happened to each photo of a review action. Refusals are counted, not
 *  fatal — a selection of two hundred should not stop at the first locked one. */
export interface ReviewCounts {
  done: number;
  forbidden: number;
  missing: number;
  locked: number;
  failed: number;
  error?: string;
}

export interface KeepDestination {
  libraryId: string;
  /** Folder under the destination root, or null for the root. Ignored when `dated`. */
  folder: string | null;
  /** File each photo under YYYY/YYYY-MM-DD by its capture date, the upload rule.
   *  Off by default on purpose: a scan's EXIF date is the scan date, which is why
   *  Keep asks where rather than guessing (proposal, decision 5). */
  dated: boolean;
}

type ReviewItemRow = Pick<LibraryItemRow, "id" | "library_id">
  & Pick<LibraryRow, "policy_json">
  & Nullable<Pick<GalleryDetailRow, "taken_at" | "taken_precision">>;

function reviewItem(itemId: string): ReviewItemRow | undefined {
  return db.prepare(`
    SELECT li.id, li.library_id, lib.policy_json, gd.taken_at, gd.taken_precision
    FROM library_items li
    JOIN libraries lib ON lib.id = li.library_id
    LEFT JOIN gallery_details gd ON gd.item_id = li.id
    WHERE li.id = ? AND li.type = 'gallery' AND li.deleted_at IS NULL
  `).get(itemId) as ReviewItemRow | undefined;
}

// Whether this user may take a photo OUT of its Inbox. Only Inbox photos go through
// a review at all — a kept or discarded photo elsewhere is a plain move or delete,
// with its own routes and rules.
function reviewable(user: AuthUser, row: ReviewItemRow): "ok" | "forbidden" {
  const policy = parsePolicy(row.policy_json);
  if (policy.inbox !== true) return "forbidden";
  return can(user, { objectType: "library", objectId: row.library_id, policy }, "delete") ? "ok" : "forbidden";
}

export type KeepOutcome =
  | { ok: true; counts: ReviewCounts; destinationName: string }
  | { ok: false; status: 403 | 404; error: string };

/** Keep: move the photos into a real library. The destination is checked once
 *  (it is one library); each photo is then checked and moved on its own. */
export function keepPhotoInboxItems(user: AuthUser, itemIds: string[], dest: KeepDestination): KeepOutcome {
  const target = db.prepare("SELECT id, name, policy_json FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(dest.libraryId) as InboxLibraryRow | undefined;
  if (!target || !canUserAccessLibrary(target, user.id, user.role)) {
    return { ok: false, status: 404, error: "Destination library not found." };
  }
  const targetPolicy = parsePolicy(target.policy_json);
  if (targetPolicy.inbox === true) {
    return { ok: false, status: 403, error: `"${target.name}" is a Photo Inbox; keep photos into a regular library.` };
  }
  if (!can(user, { objectType: "library", objectId: target.id, policy: targetPolicy }, "upload")) {
    return { ok: false, status: 403, error: `You can't add photos to "${target.name}".` };
  }

  const counts: ReviewCounts = { done: 0, forbidden: 0, missing: 0, locked: 0, failed: 0 };
  const now = new Date();
  for (const itemId of itemIds) {
    const row = reviewItem(itemId);
    if (!row) { counts.missing += 1; continue; }
    if (reviewable(user, row) !== "ok") { counts.forbidden += 1; continue; }
    // A date known only to the year files under the year alone (date-folder.ts).
    const folder = dest.dated ? dateFolderForCapture(row.taken_at, now, row.taken_precision ?? "time") : (dest.folder ?? "");
    const result = moveGalleryAsset(itemId, { libraryId: target.id, folder });
    if (result.ok) { counts.done += 1; continue; }
    if (result.status === 423) { counts.locked += 1; continue; }
    if (result.status === 404) { counts.missing += 1; continue; }
    counts.failed += 1;
    if (!counts.error) counts.error = result.error;
  }
  return { ok: true, counts, destinationName: target.name };
}

/** Discard: to the Recycle Bin on the cleanup clock — a rejected duplicate or a
 *  blurry scan is the same kind of removal a cleanup makes, not a hand delete. */
export function discardPhotoInboxItems(user: AuthUser, itemIds: string[]): ReviewCounts {
  const counts: ReviewCounts = { done: 0, forbidden: 0, missing: 0, locked: 0, failed: 0 };
  for (const itemId of itemIds) {
    const row = reviewItem(itemId);
    if (!row) { counts.missing += 1; continue; }
    if (reviewable(user, row) !== "ok") { counts.forbidden += 1; continue; }
    try {
      trashBook(itemId, user.id, { source: "photo_inbox" });
      counts.done += 1;
    } catch (err) {
      if (err instanceof TrashError && err.statusCode === 404) { counts.missing += 1; continue; }
      if (err instanceof TrashError && err.statusCode === 423) { counts.locked += 1; continue; }
      counts.failed += 1;
      if (!counts.error) counts.error = err instanceof Error ? err.message : "Could not move the photo to the Recycle Bin.";
    }
  }
  return counts;
}
