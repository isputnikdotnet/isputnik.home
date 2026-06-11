import { useState, useEffect, useCallback } from "react";
import { Check, Pencil, Trash2, X, Eraser, Search, Plus } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";

interface ManageTag {
  id: string;
  name: string;
  bookCount: number;
}

export function TagsSection() {
  const [tags, setTags] = useState<ManageTag[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ManageTag | null>(null);
  const [pruning, setPruning] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const payload = await api<{ tags: ManageTag[] }>("/api/library/manage/tags");
    setTags(payload.tags);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Unable to load tags"));
  }, [load]);

  const startEdit = (tag: ManageTag) => {
    setEditingId(tag.id);
    setEditValue(tag.name);
    setError("");
    setNotice("");
  };

  const saveEdit = async (tag: ManageTag) => {
    const next = editValue.trim();
    if (!next || next === tag.name) {
      setEditingId(null);
      return;
    }
    setBusyId(tag.id);
    setError("");
    try {
      const payload = await api<{ tags: ManageTag[]; merged: boolean }>(`/api/library/manage/tags/${tag.id}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: next })
      });
      setTags(payload.tags);
      setEditingId(null);
      setNotice(payload.merged ? `Merged into existing tag "${next}".` : "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to rename tag");
    } finally {
      setBusyId(null);
    }
  };

  const deleteTag = async () => {
    if (!pendingDelete) return;
    setBusyId(pendingDelete.id);
    setError("");
    try {
      await api(`/api/library/manage/tags/${pendingDelete.id}`, { method: "DELETE" });
      setPendingDelete(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete tag");
    } finally {
      setBusyId(null);
    }
  };

  const pruneUnused = async () => {
    setPruning(true);
    setError("");
    setNotice("");
    try {
      const payload = await api<{ pruned: number }>("/api/library/manage/tags/prune", { method: "POST", body: "{}" });
      setNotice(payload.pruned > 0 ? `Removed ${payload.pruned} unused tag${payload.pruned === 1 ? "" : "s"}.` : "No unused tags to remove.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to prune tags");
    } finally {
      setPruning(false);
    }
  };

  const createTag = async () => {
    const displayName = newTagName.trim();
    if (!displayName) return;

    setCreating(true);
    setError("");
    setNotice("");
    try {
      const payload = await api<{ tags: ManageTag[] }>("/api/library/manage/tags", {
        method: "POST",
        body: JSON.stringify({ displayName })
      });
      setTags(payload.tags);
      setNewTagName("");
      setCreateOpen(false);
      setNotice(`Created tag "${displayName}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create tag");
    } finally {
      setCreating(false);
    }
  };

  const term = search.trim().toLowerCase();
  const visible = term ? tags.filter((tag) => tag.name.toLowerCase().includes(term)) : tags;
  const unusedCount = tags.filter((tag) => tag.bookCount === 0).length;

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Digital Library</p>
          <h1>Tags</h1>
        </div>
        <div className="row-actions">
          <button className="primary-button" onClick={() => { setError(""); setNotice(""); setCreateOpen(true); }}>
            <Plus size={18} aria-hidden="true" />
            <span>New tag</span>
          </button>
          <button className="secondary-button compact-button" onClick={pruneUnused} disabled={pruning || unusedCount === 0}>
            <Eraser size={15} aria-hidden="true" />
            {pruning ? "Removing…" : `Remove unused${unusedCount > 0 ? ` (${unusedCount})` : ""}`}
          </button>
        </div>
      </div>

      <p className="muted" style={{ marginTop: -6, marginBottom: 16, fontSize: "0.88rem", lineHeight: 1.45 }}>
        Tags are the descriptive layer for your library and can also be created from scanned genres. Rename to fix typos (renaming onto an existing tag merges them) or delete to remove a tag from all books. Renaming a tag that is also a category keyword won't re-sort books — use "Re-match all books" on the Categories tab afterward if needed.
      </p>

      {error && <MessageBox tone="error" title="Tag error">{error}</MessageBox>}
      {notice && <MessageBox tone="success" title="Tags updated">{notice}</MessageBox>}

      <div className="audiobook-toolbar">
        <label className="search-field">
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tags"
            aria-label="Search tags"
          />
        </label>
        <span>{visible.length} {visible.length === 1 ? "tag" : "tags"}</span>
      </div>

      {tags.length === 0 ? (
        <p className="management-empty">No tags yet. Create one here or scan books to import their genres.</p>
      ) : (
        <div className="datagrid-wrap">
          <table className="datagrid">
            <thead>
              <tr>
                <th>Tag</th>
                <th className="col-num">Books</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((tag) => (
                <tr key={tag.id}>
                  <td>
                    {editingId === tag.id ? (
                      <input
                        className="tag-edit-input"
                        value={editValue}
                        autoFocus
                        onChange={(event) => setEditValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") saveEdit(tag);
                          if (event.key === "Escape") setEditingId(null);
                        }}
                      />
                    ) : (
                      <strong>{tag.name}</strong>
                    )}
                  </td>
                  <td className="col-num datagrid-muted">{tag.bookCount}</td>
                  <td className="col-actions">
                    <div className="row-actions">
                      {editingId === tag.id ? (
                        <>
                          <button className="icon-button" title="Save" disabled={busyId === tag.id} onClick={() => saveEdit(tag)}>
                            <Check size={15} />
                          </button>
                          <button className="icon-button" title="Cancel" disabled={busyId === tag.id} onClick={() => setEditingId(null)}>
                            <X size={15} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="icon-button" title="Rename tag" onClick={() => startEdit(tag)}>
                            <Pencil size={15} />
                          </button>
                          <button className="icon-button danger" title="Delete tag" onClick={() => setPendingDelete(tag)}>
                            <Trash2 size={15} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr><td colSpan={3} className="management-empty">No tags match your search.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <Modal
          title="New tag"
          className="create-tag-modal"
          busy={creating}
          onClose={() => setCreateOpen(false)}
          onSubmit={(event) => {
            event.preventDefault();
            void createTag();
          }}
        >
            <label className="field">
              <span>Tag name</span>
              <input
                autoFocus
                maxLength={120}
                value={newTagName}
                onChange={(event) => setNewTagName(event.target.value)}
              />
            </label>
            <p>New tags start unused and can be assigned from a book's metadata editor.</p>
            {error && <MessageBox tone="error" title="Unable to create tag">{error}</MessageBox>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={creating || !newTagName.trim()}>
                <Plus size={15} aria-hidden="true" />
                {creating ? "Creating…" : "Create tag"}
              </Button>
            </div>
        </Modal>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete "${pendingDelete.name}"?`}
          confirmLabel="Delete tag"
          busyLabel="Deleting…"
          confirmIcon={<Trash2 size={15} />}
          danger
          busy={busyId !== null}
          onConfirm={deleteTag}
          onCancel={() => setPendingDelete(null)}
        >
          This removes the tag from {pendingDelete.bookCount} {pendingDelete.bookCount === 1 ? "book" : "books"}. Books and files are not affected.
        </ConfirmDialog>
      )}
    </>
  );
}
