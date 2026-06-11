import { useEffect, useState } from "react";
import { Check, ListMusic, Plus, X } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { CollectionSummary } from "./types";

// Add or remove a single entity (an audiobook today) from the caller's
// collections. Reuses the generic /api/collections endpoints — nothing here is
// audiobook-specific beyond the entityType prop.
export function AddToCollectionModal({
  entityType = "audiobook",
  entityId,
  title,
  onClose
}: {
  entityType?: string;
  entityId: string;
  title: string;
  onClose: () => void;
}) {
  const [collections, setCollections] = useState<CollectionSummary[] | null>(null);
  const [error, setError] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const load = () => {
    const params = new URLSearchParams({ entityType, entityId });
    api<{ collections: CollectionSummary[] }>(`/api/collections?${params}`)
      .then((payload) => setCollections(payload.collections))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load collections"));
  };

  useEffect(load, [entityId, entityType]);

  const toggle = async (collection: CollectionSummary) => {
    setPendingId(collection.id);
    setError("");
    try {
      if (collection.containsItem && collection.itemId) {
        await api(`/api/collections/${collection.id}/items/${collection.itemId}`, { method: "DELETE" });
      } else {
        await api(`/api/collections/${collection.id}/items`, {
          method: "POST",
          body: JSON.stringify({ entityType, entityId })
        });
      }
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update collection");
    } finally {
      setPendingId(null);
    }
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    setError("");
    try {
      const { collection } = await api<{ collection: CollectionSummary }>("/api/collections", {
        method: "POST",
        body: JSON.stringify({ name })
      });
      await api(`/api/collections/${collection.id}/items`, {
        method: "POST",
        body: JSON.stringify({ entityType, entityId })
      });
      setNewName("");
      setCreating(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create collection");
    }
  };

  return (
    <Modal
      variant="panel"
      title="Add to collection"
      icon={<ListMusic size={20} />}
      className="add-to-collection-modal"
      onClose={onClose}
    >
        <div className="modal-tab-content">
          <p className="muted add-to-collection-subtitle">{title}</p>

          {error && <MessageBox tone="error" title="Collections error">{error}</MessageBox>}

          <div className="collection-pick-list">
            {(collections ?? []).map((collection) => (
              <button
                className={`collection-pick-row${collection.containsItem ? " selected" : ""}`}
                key={collection.id}
                onClick={() => toggle(collection)}
                disabled={pendingId === collection.id}
              >
                <span className="collection-pick-check" aria-hidden="true">
                  {collection.containsItem ? <Check size={16} /> : null}
                </span>
                <span className="collection-pick-text">
                  <strong>{collection.name}</strong>
                  <small>{collection.itemCount} {collection.itemCount === 1 ? "item" : "items"}</small>
                </span>
              </button>
            ))}
            {collections && collections.length === 0 && (
              <p className="management-empty">No collections yet — create one below.</p>
            )}
            {collections === null && <p className="management-empty">Loading…</p>}
          </div>

          {creating ? (
            <div className="collection-create-row">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void createAndAdd(); if (e.key === "Escape") { e.stopPropagation(); setCreating(false); } }}
                placeholder="New collection name…"
                maxLength={120}
              />
              <button className="primary-button compact-button" onClick={createAndAdd} disabled={!newName.trim()}>Create &amp; add</button>
              <button className="secondary-button compact-button" onClick={() => setCreating(false)}><X size={15} /></button>
            </div>
          ) : (
            <button className="secondary-button add-to-collection-new" onClick={() => setCreating(true)}>
              <Plus size={16} />
              <span>New collection</span>
            </button>
          )}
        </div>
    </Modal>
  );
}
