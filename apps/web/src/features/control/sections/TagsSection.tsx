import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, Trash2, X, Eraser, Search, Plus } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { ControlSectionHead } from "../ControlSectionHead";

interface ManageTag {
  id: string;
  name: string;
  bookCount: number;
}

const TAG_PAGE_SIZE = 60;

export function TagsSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [tags, setTags] = useState<ManageTag[]>([]);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(TAG_PAGE_SIZE);
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
    load().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:tags.loadFailed")));
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
      setNotice(payload.merged ? t("controlAdmin:tags.mergedNotice", { name: next }) : "");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:tags.renameFailed"));
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
      setError(err instanceof Error ? err.message : t("controlAdmin:tags.deleteFailed"));
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
      setNotice(payload.pruned > 0 ? t("controlAdmin:tags.prunedNotice", { count: payload.pruned }) : t("controlAdmin:tags.nonePruned"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:tags.pruneFailed"));
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
      setNotice(t("controlAdmin:tags.createdNotice", { name: displayName }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:tags.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const term = search.trim().toLowerCase();
  const visible = term ? tags.filter((tag) => tag.name.toLowerCase().includes(term)) : tags;
  const paged = visible.slice(0, limit);
  const unusedCount = tags.filter((tag) => tag.bookCount === 0).length;

  return (
    <>
      <ControlSectionHead section="tags" description={t("controlAdmin:tags.headDescription")}>
        <div className="row-actions">
          <button className="primary-button" onClick={() => { setError(""); setNotice(""); setCreateOpen(true); }}>
            <Plus size={18} aria-hidden="true" />
            <span>{t("controlAdmin:tags.newTag")}</span>
          </button>
          <button className="secondary-button compact-button" onClick={pruneUnused} disabled={pruning || unusedCount === 0}>
            <Eraser size={15} aria-hidden="true" />
            {pruning ? t("controlAdmin:tags.removing") : unusedCount > 0 ? t("controlAdmin:tags.removeUnusedCount", { count: unusedCount }) : t("controlAdmin:tags.removeUnused")}
          </button>
        </div>
      </ControlSectionHead>

      <p className="muted" style={{ marginTop: -6, marginBottom: 16, fontSize: "0.88rem", lineHeight: 1.45 }}>
        {t("controlAdmin:tags.intro")}
      </p>

      {error && <MessageBox tone="error" title={t("controlAdmin:tags.errorTitle")}>{error}</MessageBox>}
      {notice && <MessageBox tone="success" title={t("controlAdmin:tags.updatedTitle")}>{notice}</MessageBox>}

      <div className="audiobook-toolbar">
        <label className="search-field">
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setLimit(TAG_PAGE_SIZE); }}
            placeholder={t("controlAdmin:tags.searchPlaceholder")}
            aria-label={t("controlAdmin:tags.searchPlaceholder")}
          />
        </label>
        <span>{t("controlAdmin:tags.tagCount", { count: visible.length })}</span>
      </div>

      {tags.length === 0 ? (
        <p className="management-empty">{t("controlAdmin:tags.emptyList")}</p>
      ) : (
        <>
        <div className="datagrid-wrap">
          <table className="datagrid">
            <thead>
              <tr>
                <th>{t("controlAdmin:tags.thTag")}</th>
                <th className="col-num">{t("controlAdmin:tags.thBooks")}</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {paged.map((tag) => (
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
                          <button className="icon-button" title={t("controlAdmin:tags.saveTitle")} disabled={busyId === tag.id} onClick={() => saveEdit(tag)}>
                            <Check size={15} />
                          </button>
                          <button className="icon-button" title={t("common.cancel")} disabled={busyId === tag.id} onClick={() => setEditingId(null)}>
                            <X size={15} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="icon-button" title={t("controlAdmin:tags.renameTag")} onClick={() => startEdit(tag)}>
                            <Pencil size={15} />
                          </button>
                          <button className="icon-button danger" title={t("controlAdmin:tags.deleteTag")} onClick={() => setPendingDelete(tag)}>
                            <Trash2 size={15} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr><td colSpan={3} className="management-empty">{t("controlAdmin:tags.noMatch")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {visible.length > paged.length && (
          <div className="tag-list-more">
            <button
              className="secondary-button compact-button"
              onClick={() => setLimit((current) => current + TAG_PAGE_SIZE)}
            >
              {t("controlAdmin:tags.showMore", { count: visible.length - paged.length })}
            </button>
          </div>
        )}
        </>
      )}

      {createOpen && (
        <Modal
          title={t("controlAdmin:tags.newTag")}
          className="create-tag-modal"
          busy={creating}
          onClose={() => setCreateOpen(false)}
          onSubmit={(event) => {
            event.preventDefault();
            void createTag();
          }}
        >
            <label className="field">
              <span>{t("controlAdmin:tags.tagName")}</span>
              <input
                autoFocus
                maxLength={120}
                value={newTagName}
                onChange={(event) => setNewTagName(event.target.value)}
              />
            </label>
            <p>{t("controlAdmin:tags.modalNote")}</p>
            {error && <MessageBox tone="error" title={t("controlAdmin:tags.createFailed")}>{error}</MessageBox>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" type="submit" disabled={creating || !newTagName.trim()}>
                <Plus size={15} aria-hidden="true" />
                {creating ? t("controlAdmin:tags.creating") : t("controlAdmin:tags.createTag")}
              </Button>
            </div>
        </Modal>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t("controlAdmin:tags.deleteDialogTitle", { name: pendingDelete.name })}
          confirmLabel={t("controlAdmin:tags.deleteTag")}
          busyLabel={t("controlAdmin:tags.deleting")}
          confirmIcon={<Trash2 size={15} />}
          danger
          busy={busyId !== null}
          onConfirm={deleteTag}
          onCancel={() => setPendingDelete(null)}
        >
          {t("controlAdmin:tags.deleteBody", { count: pendingDelete.bookCount })}
        </ConfirmDialog>
      )}
    </>
  );
}
