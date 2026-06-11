import { useState } from "react";
import { ListMusic } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import type { CollectionSummary } from "./types";

// Popup form for creating a collection. Returns the created collection so the
// caller can navigate to it (or add an item to it).
export function NewCollectionModal({
  onClose,
  onCreated
}: {
  onClose: () => void;
  onCreated: (collection: CollectionSummary) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError("");
    try {
      const { collection } = await api<{ collection: CollectionSummary }>("/api/collections", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, description: description.trim() || null })
      });
      onCreated(collection);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create collection");
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="panel"
      title="New collection"
      icon={<ListMusic size={20} />}
      className="new-collection-modal"
      busy={saving}
      onClose={onClose}
    >
        <form
          className="modal-tab-content new-collection-form"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
        >
          {error && <MessageBox tone="error" title="Collections error">{error}</MessageBox>}

          <label className="field">
            <span>Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekend listening"
              maxLength={120}
            />
          </label>

          <label className="field">
            <span>Description <small className="muted">(optional)</small></span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this collection for?"
              rows={3}
              maxLength={2000}
            />
          </label>

          <div className="metadata-actions new-collection-actions">
            <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={saving || !name.trim()}>
              {saving ? "Creating…" : "Create collection"}
            </Button>
          </div>
        </form>
    </Modal>
  );
}
