// For you — docs/for-you-plan.md.
//
// Everything waiting on one person, in one list: something sent to them (a
// recommendation, with or without a question attached), and a delivery into a
// Photo Inbox they look after. News is not here; it stays in the Home feed and
// fades. A row leaves when its action is taken. "Seen" is what the dot counts,
// and opening the page clears it — recommendations already carry `seen_at`;
// deliveries are folders, so they get a per-person stamp of their own
// (`inbox_delivery_seen`).
import { db } from "../../db.js";
import { listPhotoInboxItems, listPhotoInboxes } from "../library/gallery/inbox.js";
import { loadInboxCards, type InboxCardView } from "./routes.js";
import type { InboxDeliverySeenRow, ShareLinkRow } from "../../db/rows.js";

export type SentRow = InboxCardView & { kind: "sent" };

/** One batch that arrived in a Photo Inbox this person may write on. */
export interface DeliveryRow {
  kind: "delivery";
  /** Stable across loads: library + folder. */
  id: string;
  libraryId: string;
  libraryName: string;
  /** "" for files at the Inbox root. */
  folder: string;
  count: number;
  reviewed: number;
  viaLink: boolean;
  /** The drop link's label when the batch came through one ("Cousin Anna"). */
  who: string | null;
  newestAt: string;
  seen: boolean;
  coverUrl: string | null;
  /** May Keep or Discard (the Inbox page), or only write (Review mode). */
  canReview: boolean;
}

export type ForYouRow = SentRow | DeliveryRow;

type DeliverySeenRow = Pick<InboxDeliverySeenRow, "library_id" | "folder" | "seen_at" | "dismissed_at">;

const whoStmt = db.prepare(`
  SELECT share_links.label AS label
  FROM share_link_drops
  JOIN share_links ON share_links.id = share_link_drops.share_link_id
  JOIN library_items ON library_items.id = share_link_drops.item_id
  WHERE library_items.library_id = ? AND library_items.deleted_at IS NULL
    AND (CASE WHEN ? = '' THEN instr(library_items.folder_path, '/') = 0 ELSE library_items.folder_path LIKE ? ESCAPE '\\' END)
  ORDER BY share_link_drops.created_at DESC
  LIMIT 1
`);

function deliveryWho(libraryId: string, folder: string): string | null {
  const row = whoStmt.get(libraryId, folder, `${folder.replace(/[\\%_]/g, "\\$&")}/%`) as Pick<ShareLinkRow, "label"> | undefined;
  return row?.label?.trim() || null;
}

function deliveryRows(user: { id: string; role: string }): DeliveryRow[] {
  const marks = new Map<string, DeliverySeenRow>();
  for (const row of db.prepare("SELECT library_id, folder, seen_at, dismissed_at FROM inbox_delivery_seen WHERE user_id = ?").all(user.id) as DeliverySeenRow[]) {
    marks.set(`${row.library_id}\u0000${row.folder}`, row);
  }
  const rows: DeliveryRow[] = [];
  for (const inbox of listPhotoInboxes(user)) {
    if (!inbox.canEdit) continue;
    for (const delivery of inbox.deliveries) {
      if (delivery.count === 0) continue;
      // For someone who can only write, a fully noted delivery is done. For
      // someone who can Keep, it waits until the Inbox is emptied.
      if (!inbox.canReview && delivery.reviewed >= delivery.count) continue;
      const mark = marks.get(`${inbox.id}\u0000${delivery.folder}`);
      // "Not now" hides it until the delivery grows past the dismissal.
      if (mark?.dismissed_at && mark.dismissed_at >= delivery.newestAt) continue;
      const seenAt = mark?.seen_at;
      const first = listPhotoInboxItems(user, inbox.id, { folder: delivery.folder, limit: 1, offset: 0 })?.items[0];
      rows.push({
        kind: "delivery",
        id: `delivery:${inbox.id}:${delivery.folder}`,
        libraryId: inbox.id,
        libraryName: inbox.name,
        folder: delivery.folder,
        count: delivery.count,
        reviewed: delivery.reviewed,
        viaLink: delivery.viaLink,
        who: delivery.viaLink ? deliveryWho(inbox.id, delivery.folder) : null,
        newestAt: delivery.newestAt,
        seen: seenAt != null && seenAt >= delivery.newestAt,
        coverUrl: first?.coverUrl ?? null,
        canReview: inbox.canReview
      });
    }
  }
  return rows;
}

function rowTime(row: ForYouRow): string {
  return row.kind === "sent" ? row.createdAt : row.newestAt;
}

/** The list, newest first, unseen or not. */
export function loadForYouRows(user: { id: string; role: string }): ForYouRow[] {
  const sent: ForYouRow[] = loadInboxCards(user, { onlyNew: true }).map((card) => ({ kind: "sent" as const, ...card }));
  const rows = [...sent, ...deliveryRows(user)];
  rows.sort((a, b) => rowTime(b).localeCompare(rowTime(a)));
  return rows;
}

/** What the dot counts: rows this person has not looked at yet. */
export function countUnseenForYou(user: { id: string; role: string }): number {
  const recs = (db.prepare(
    "SELECT COUNT(*) AS unseen FROM recommendations WHERE to_user_id = ? AND seen_at IS NULL"
  ).get(user.id) as { unseen: number }).unseen;
  return recs + deliveryRows(user).filter((row) => !row.seen).length;
}

/** "Not now" on a delivery: off the list until more photos arrive in it. The
 *  delivery itself is untouched and still on the Inbox page. Returns false when
 *  there is no such delivery waiting for this person. */
export function dismissDelivery(user: { id: string; role: string }, libraryId: string, folder: string): boolean {
  const row = deliveryRows(user).find((candidate) => candidate.libraryId === libraryId && candidate.folder === folder);
  if (!row) return false;
  db.prepare(`
    INSERT INTO inbox_delivery_seen (user_id, library_id, folder, seen_at, dismissed_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT (user_id, library_id, folder) DO UPDATE SET
      seen_at = excluded.seen_at,
      dismissed_at = excluded.dismissed_at
  `).run(user.id, libraryId, folder);
  return true;
}

/** Opening the page stamps everything on it as seen — not per row: the dot
 *  means "there is something new here", and once you have looked, there isn't. */
export function markForYouSeen(user: { id: string; role: string }): void {
  db.transaction(() => {
    db.prepare(
      "UPDATE recommendations SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE to_user_id = ? AND seen_at IS NULL"
    ).run(user.id);
    const stamp = db.prepare(`
      INSERT INTO inbox_delivery_seen (user_id, library_id, folder, seen_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT (user_id, library_id, folder) DO UPDATE SET seen_at = excluded.seen_at
    `);
    for (const row of deliveryRows(user)) stamp.run(user.id, row.libraryId, row.folder);
  })();
}
