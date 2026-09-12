import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, BookOpen, ChevronDown, ChevronUp, ListMusic, Pencil, Play, Trash2, X } from "lucide-react";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { goBack, navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { formatDuration } from "../../shared/utils";
import { UserAreaNav } from "../library/UserAreaNav";
import type { CollectionDetail, CollectionItem } from "./types";
import { Button } from "../../shared/Button";

const PLAYER_FEATURES = "width=500,height=700,resizable=yes,scrollbars=yes";

export function CollectionDetailPage({
  id
}: {
  id: string;
}) {
  const { t } = useTranslation(["common", "user"]);
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
      .catch((err) => setError(err instanceof Error ? err.message : t("user:collections.loadOneFailed")));
  }, [id, t]);

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
      setError(err instanceof Error ? err.message : t("user:collections.reorderFailed"));
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
      setError(err instanceof Error ? err.message : t("user:collections.removeItemFailed"));
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
      setError(err instanceof Error ? err.message : t("user:collections.renameFailed"));
    }
  };

  const deleteCollection = async () => {
    try {
      await api(`/api/collections/${id}`, { method: "DELETE" });
      navigate("/collections");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:collections.deleteFailed"));
    }
  };

  return (
    <DashboardShell active="user" sideNav={<UserAreaNav active="collections" />}>
      <section className="work-area audiobook-area">
        <div className="book-detail-topbar">
          <Button variant="bare" className="audiobook-back-button" onClick={() => goBack("/collections")}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span>{t("user:collections.backTo")}</span>
          </Button>
        </div>

        {error && <MessageBox tone="error" title={t("user:collections.detailErrorTitle")}>{error}</MessageBox>}

        {collection && (
          <>
            <div className="section-head audiobook-head collection-head">
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
                    <Button variant="primary" compact onClick={saveName}>{t("user:actions.save")}</Button>
                    <Button variant="secondary" compact onClick={() => setEditingName(false)}><X size={15} /></Button>
                  </div>
                ) : (
                  <>
                    <p className="eyebrow">{t("user:collections.eyebrow")}</p>
                    <h1>
                      {collection.name}
                      <Button
                        variant="icon"
                        className="collection-rename"
                        onClick={() => { setNameDraft(collection.name); setEditingName(true); }}
                        aria-label={t("user:collections.renameAria")}
                        title={t("user:collections.rename")}
                      >
                        <Pencil size={15} />
                      </Button>
                    </h1>
                    <span className="muted">{t("user:count.items", { count: items.length })}</span>
                  </>
                )}
              </div>
              <div className="collection-head-actions">
                {firstPlayable && (
                  <Button variant="primary" compact onClick={() => playFrom(firstPlayable)}>
                    <Play size={16} />
                    <span>{hasUnplayable ? t("user:collections.playAudio") : t("user:collections.playAll")}</span>
                  </Button>
                )}
                <Button variant="secondary" compact danger onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={15} />
                  <span>{t("user:actions.delete")}</span>
                </Button>
              </div>
            </div>

            {confirmDelete && (
              <ConfirmDialog
                title={t("user:collections.deleteTitle", { name: collection.name })}
                confirmLabel={t("user:collections.deleteConfirm")}
                danger
                busy={busy}
                onConfirm={deleteCollection}
                onCancel={() => setConfirmDelete(false)}
              >
                {t("user:collections.deleteBody")}
              </ConfirmDialog>
            )}

            {items.length === 0 ? (
              <div className="empty-state library-empty">
                <ListMusic size={58} aria-hidden="true" />
                <h2>{t("user:collections.detailEmptyHeading")}</h2>
                <p className="muted">{t("user:collections.detailEmpty")}</p>
              </div>
            ) : (
              <div className="collection-item-list">
                {items.map((item, index) => (
                  <article className={`collection-item-row${item.available ? "" : " unavailable"}`} key={item.id}>
                    <span className="collection-item-pos">{index + 1}</span>
                    <Button
                      variant="bare"
                      className="collection-item-main"
                      disabled={!item.available}
                      onClick={() => item.available && navigate(item.href)}
                    >
                      {item.coverUrl && (
                        <span className="collection-item-cover" aria-hidden="true">
                          <img src={item.coverUrl} alt="" />
                        </span>
                      )}
                      <span className="collection-item-text">
                        <strong>{item.title}</strong>
                        <small>
                          {item.subtitle ?? (item.available ? t("user:feed.unknownAuthor") : t("user:collections.unavailable"))}
                          {item.durationSeconds != null ? ` · ${formatDuration(item.durationSeconds)}` : ""}
                        </small>
                      </span>
                    </Button>
                    <div className="collection-item-actions">
                      {item.available && item.playable && (
                        <Button variant="icon" onClick={() => playFrom(item)} aria-label={t("common:home.playTitle", { title: item.title })} title={t("user:collections.playFromHere")}>
                          <Play size={15} />
                        </Button>
                      )}
                      {item.available && !item.playable && item.entityType === "ebook" && (
                        <Button variant="icon" onClick={() => navigate(`${item.href}?read=1`)} aria-label={t("common:home.readTitle", { title: item.title })} title={t("common:home.read")}>
                          <BookOpen size={15} />
                        </Button>
                      )}
                      <Button variant="icon" onClick={() => moveItem(index, -1)} disabled={index === 0 || busy} aria-label={t("user:collections.moveUp")}>
                        <ChevronUp size={15} />
                      </Button>
                      <Button variant="icon" onClick={() => moveItem(index, 1)} disabled={index === items.length - 1 || busy} aria-label={t("user:collections.moveDown")}>
                        <ChevronDown size={15} />
                      </Button>
                      <Button variant="icon" danger onClick={() => removeItem(item)} aria-label={t("user:collections.removeAria", { title: item.title })} title={t("user:collections.removeFromCollection")}>
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}

        {!collection && !error && <p className="management-empty">{t("user:common.loading")}</p>}
      </section>
    </DashboardShell>
  );
}
