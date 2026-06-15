import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, ChevronDown, ChevronUp, ListMusic, Pencil, Play, Trash2, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { formatDuration } from "../../shared/utils";
import type { CollectionDetail, CollectionItem } from "./types";

const PLAYER_FEATURES = "width=500,height=700,resizable=yes,scrollbars=yes";

export function CollectionDetailPage({
  id,
  user,
  logout
}: {
  id: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [collection, setCollection] = useState<CollectionDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setCollection(null);
    setError("");
    api<{ collection: CollectionDetail }>(`/api/collections/${id}`)
      .then((payload) => { setCollection(payload.collection); document.title = `${payload.collection.name} — isputnik.home`; })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load collection"));
  }, [id]);

  const items = collection?.items ?? [];
  const firstPlayable = items.find((item) => item.available && item.playable);
  // A mixed collection (e.g. audiobooks + ebooks) only chains the playable items
  // in the player, so be honest about the action: "Play audio" rather than
  // "Play all" when some available items can't play.
  const hasUnplayable = items.some((item) => item.available && !item.playable);

  const playFrom = (item: CollectionItem) => {
    window.open(`/player/${item.entityId}?collection=${id}`, "isputnik-player", PLAYER_FEATURES);
  };

  const reorder = async (orderedItemIds: string[]) => {
    setBusy(true);
    try {
      await api(`/api/collections/${id}/items/reorder`, {
        method: "PATCH",
        body: JSON.stringify({ orderedItemIds })
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reorder");
    } finally {
      setBusy(false);
    }
  };

  const moveItem = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    setCollection((c) => (c ? { ...c, items: next } : c));
    void reorder(next.map((item) => item.id));
  };

  const removeItem = async (item: CollectionItem) => {
    setCollection((c) => (c ? { ...c, items: c.items.filter((i) => i.id !== item.id) } : c));
    try {
      await api(`/api/collections/${id}/items/${item.id}`, { method: "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove item");
    }
  };

  const saveName = async () => {
    const name = nameDraft.trim();
    if (!name) return;
    try {
      await api(`/api/collections/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      setCollection((c) => (c ? { ...c, name } : c));
      setEditingName(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to rename");
    }
  };

  const deleteCollection = async () => {
    try {
      await api(`/api/collections/${id}`, { method: "DELETE" });
      navigate("/collections");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete collection");
    }
  };

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="work-area audiobook-area">
        <div className="book-detail-topbar">
          <button className="audiobook-back-button" type="button" onClick={() => navigate("/collections")}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span>Back to collections</span>
          </button>
        </div>

        {error && <MessageBox tone="error" title="Collection error">{error}</MessageBox>}

        {collection && (
          <>
            <div className="section-head audiobook-head">
              <div className="collection-title-row">
                {editingName ? (
                  <div className="collection-create-row">
                    <input
                      autoFocus
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void saveName(); if (e.key === "Escape") setEditingName(false); }}
                      maxLength={120}
                    />
                    <button className="primary-button compact-button" onClick={saveName}>Save</button>
                    <button className="secondary-button compact-button" onClick={() => setEditingName(false)}><X size={15} /></button>
                  </div>
                ) : (
                  <>
                    <p className="eyebrow">Collection</p>
                    <h1>
                      {collection.name}
                      <button
                        className="icon-button collection-rename"
                        onClick={() => { setNameDraft(collection.name); setEditingName(true); }}
                        aria-label="Rename collection"
                        title="Rename"
                      >
                        <Pencil size={15} />
                      </button>
                    </h1>
                    <span className="muted">{items.length} {items.length === 1 ? "item" : "items"}</span>
                  </>
                )}
              </div>
              <div className="collection-head-actions">
                {firstPlayable && (
                  <button className="primary-button compact-button" onClick={() => playFrom(firstPlayable)}>
                    <Play size={16} />
                    <span>{hasUnplayable ? "Play audio" : "Play all"}</span>
                  </button>
                )}
                <button className="secondary-button compact-button danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={15} />
                  <span>Delete</span>
                </button>
              </div>
            </div>

            {confirmDelete && (
              <ConfirmDialog
                title={`Delete “${collection.name}”?`}
                confirmLabel="Delete collection"
                danger
                busy={busy}
                onConfirm={deleteCollection}
                onCancel={() => setConfirmDelete(false)}
              >
                The books themselves are not affected.
              </ConfirmDialog>
            )}

            {items.length === 0 ? (
              <div className="empty-state library-empty">
                <ListMusic size={58} aria-hidden="true" />
                <h2>This collection is empty</h2>
                <p className="muted">Open a book and use “Add to collection” to put it here.</p>
              </div>
            ) : (
              <div className="collection-item-list">
                {items.map((item, index) => (
                  <article className={`collection-item-row${item.available ? "" : " unavailable"}`} key={item.id}>
                    <span className="collection-item-pos">{index + 1}</span>
                    <button
                      className="collection-item-main"
                      disabled={!item.available}
                      onClick={() => item.available && navigate(item.href)}
                    >
                      <span className="collection-item-cover" aria-hidden="true">
                        {item.coverUrl ? <img src={item.coverUrl} alt="" /> : <BookOpen size={16} />}
                      </span>
                      <span className="collection-item-text">
                        <strong>{item.title}</strong>
                        <small>
                          {item.subtitle ?? (item.available ? "Unknown author" : "Unavailable")}
                          {item.durationSeconds != null ? ` · ${formatDuration(item.durationSeconds)}` : ""}
                        </small>
                      </span>
                    </button>
                    <div className="collection-item-actions">
                      {item.available && item.playable && (
                        <button className="icon-button" onClick={() => playFrom(item)} aria-label={`Play ${item.title}`} title="Play from here">
                          <Play size={15} />
                        </button>
                      )}
                      <button className="icon-button" onClick={() => moveItem(index, -1)} disabled={index === 0 || busy} aria-label="Move up">
                        <ChevronUp size={15} />
                      </button>
                      <button className="icon-button" onClick={() => moveItem(index, 1)} disabled={index === items.length - 1 || busy} aria-label="Move down">
                        <ChevronDown size={15} />
                      </button>
                      <button className="icon-button danger" onClick={() => removeItem(item)} aria-label={`Remove ${item.title}`} title="Remove from collection">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}

        {!collection && !error && <p className="management-empty">Loading…</p>}
      </section>
    </DashboardShell>
  );
}
