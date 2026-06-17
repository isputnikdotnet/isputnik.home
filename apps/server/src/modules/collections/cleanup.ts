import { db } from "../../db.js";

// Collection membership is polymorphic (no FK to the resource table), so the
// owning module must remove collection_items when a resource is deleted or
// purged — same contract as deleteSharesForResource/deleteSharesForLibrary.
export function deleteCollectionItemsForResource(entityType: string, entityId: string) {
  db.prepare("DELETE FROM collection_items WHERE entity_type = ? AND entity_id = ?").run(entityType, entityId);
}

// Drop every collection membership for books in a library before the library is
// hard deleted (the books cascade away, but their collection items would orphan).
// entityType identifies the collectable namespace for this library type.
export function deleteCollectionItemsForLibrary(entityType: string, libraryId: string) {
  db.prepare(
    "DELETE FROM collection_items WHERE entity_type = ? AND entity_id IN (SELECT id FROM library_items WHERE library_id = ?)"
  ).run(entityType, libraryId);
}
