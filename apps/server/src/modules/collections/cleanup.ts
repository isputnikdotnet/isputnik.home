import { db } from "../../db.js";

// Collection membership is polymorphic (no FK to the resource table), so the
// owning module must remove collection_items when a resource is deleted or
// purged — same contract as deleteSharesForResource/deleteSharesForLibrary.
export function deleteCollectionItemsForResource(entityType: string, entityId: string) {
  db.prepare("DELETE FROM collection_items WHERE entity_type = ? AND entity_id = ?").run(entityType, entityId);
}

// Drop every audiobook membership for books in a library before the library is
// hard deleted (the books cascade away, but their collection items would orphan).
export function deleteCollectionItemsForLibrary(libraryId: string) {
  db.prepare(
    "DELETE FROM collection_items WHERE entity_type = 'audiobook' AND entity_id IN (SELECT id FROM books WHERE library_id = ?)"
  ).run(libraryId);
}
