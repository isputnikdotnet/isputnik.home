// What the shared activity log may say about a personal library
// (docs/photo-sync-plan.md, decision 3: nothing derived from it reaches anyone else —
// "activity details or counts" included). The log is read by admins (Logs, the
// Dashboard's activity and its per-member counts), so an entry about a personal
// library's photos is not written at all: uploads, views, edits, rescans, deletes of
// single photos. What stays is the library's own life — turned on, adopted, orphaned,
// handed over, deleted — which an admin needs and which names no photo.
import { db, registerActivityGate } from "../../../../db.js";
import { isPersonalLibrary } from "./personal-libraries.js";

/** Target types whose id is a library item. */
const ITEM_TARGETS = new Set(["gallery", "library_item", "book"]);

const LIBRARY_EVENTS_KEPT = /^library\.personal\.|^library\.gallery\.deleted$/;

registerActivityGate((input) => {
  if (!input.targetId || !input.targetType) return true;
  if (input.targetType === "library") {
    return !isPersonalLibrary(input.targetId) || LIBRARY_EVENTS_KEPT.test(input.event);
  }
  if (ITEM_TARGETS.has(input.targetType)) {
    const row = db.prepare("SELECT library_id FROM library_items WHERE id = ?").get(input.targetId) as { library_id: string } | undefined;
    return !row || !isPersonalLibrary(row.library_id);
  }
  return true;
});
