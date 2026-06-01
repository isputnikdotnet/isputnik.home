import { useCallback, useEffect, useState } from "react";
import { Check, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { CategoryIcon, CATEGORY_ICON_KEYS } from "../../audiobooks/categoryIcons";
import type { TagSummary } from "../../audiobooks/types";

interface ManageCategory {
  id: string;
  key: string;
  name: string;
  sortOrder: number;
  icon: string | null;
  imageUrl: string | null;
  bookCount: number;
}

interface ManageAlias {
  id: string;
  keyword: string;
  priority: number;
  categoryId: string;
  categoryKey: string;
  categoryName: string;
}

type Tab = "categories" | "mappings" | "tags";

export function CategoriesSection() {
  const [tab, setTab] = useState<Tab>("categories");
  const [categories, setCategories] = useState<ManageCategory[]>([]);
  const [aliases, setAliases] = useState<ManageAlias[]>([]);
  const [tags, setTags] = useState<TagSummary[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rematching, setRematching] = useState(false);

  // Category edit drafts
  const [catDraft, setCatDraft] = useState<Record<string, { name: string; sortOrder: string; icon: string }>>({});

  // New mapping draft
  const [newKeyword, setNewKeyword] = useState("");
  const [newCategoryId, setNewCategoryId] = useState("");
  const [newPriority, setNewPriority] = useState("20");

  const load = useCallback(async () => {
    setError("");
    try {
      const [cats, als, tgs] = await Promise.all([
        api<{ categories: ManageCategory[] }>("/api/library/manage/categories"),
        api<{ aliases: ManageAlias[] }>("/api/library/manage/aliases"),
        api<{ tags: TagSummary[] }>("/api/library/tags")
      ]);
      setCategories(cats.categories);
      setAliases(als.aliases);
      setTags(tgs.tags);
      setCatDraft(Object.fromEntries(cats.categories.map((c) => [c.id, { name: c.name, sortOrder: String(c.sortOrder), icon: c.icon ?? "" }])));
      if (!newCategoryId && cats.categories.length > 0) {
        setNewCategoryId(cats.categories.find((c) => c.key !== "general_other")?.id ?? cats.categories[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load categories");
    }
  }, [newCategoryId]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveCategory = async (category: ManageCategory) => {
    const draft = catDraft[category.id];
    if (!draft) return;
    setError("");
    try {
      await api(`/api/library/manage/categories/${category.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: draft.name.trim(), sortOrder: Number(draft.sortOrder) || 0, icon: draft.icon || null })
      });
      await load();
      flash("Category saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save category");
    }
  };

  const uploadImage = async (category: ManageCategory, file: File) => {
    setError("");
    try {
      const res = await api<{ imageUrl: string }>(`/api/library/manage/categories/${category.id}/image`, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file
      });
      setCategories((prev) => prev.map((c) => (c.id === category.id ? { ...c, imageUrl: res.imageUrl } : c)));
      flash("Image updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to upload image");
    }
  };

  const removeImage = async (category: ManageCategory) => {
    setError("");
    try {
      await api(`/api/library/manage/categories/${category.id}/image`, { method: "DELETE" });
      setCategories((prev) => prev.map((c) => (c.id === category.id ? { ...c, imageUrl: null } : c)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove image");
    }
  };

  const addAlias = async (keyword: string, categoryId: string, priority: number) => {
    setError("");
    try {
      await api("/api/library/manage/aliases", {
        method: "POST",
        body: JSON.stringify({ keyword, categoryId, priority })
      });
      await load();
      flash(`Mapped "${keyword.trim().toLowerCase()}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add mapping");
    }
  };

  const updateAlias = async (id: string, patch: { categoryId?: string; priority?: number }) => {
    setError("");
    try {
      await api(`/api/library/manage/aliases/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update mapping");
    }
  };

  const deleteAlias = async (id: string) => {
    setError("");
    try {
      await api(`/api/library/manage/aliases/${id}`, { method: "DELETE" });
      setAliases((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete mapping");
    }
  };

  const rematch = async () => {
    setRematching(true);
    setError("");
    try {
      const { changed } = await api<{ changed: number }>("/api/library/manage/rematch", { method: "POST", body: "{}" });
      await load();
      flash(`Re-matched categories — ${changed} book${changed === 1 ? "" : "s"} updated.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to re-match");
    } finally {
      setRematching(false);
    }
  };

  const flash = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(""), 4000);
  };

  const mappableCategories = categories.filter((c) => c.key !== "general_other");
  const mappedKeywords = new Set(aliases.map((a) => a.keyword));

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Digital Library</p>
          <h1>Categories &amp; Tags</h1>
        </div>
        <button className="secondary-button" onClick={rematch} disabled={rematching} title="Recompute every book's category from its tags using the current mappings">
          <RefreshCw size={15} /> {rematching ? "Re-matching…" : "Re-match all"}
        </button>
      </div>

      <p className="muted" style={{ marginTop: -6, maxWidth: "68ch" }}>
        Categories are the fixed navigation buckets. Mappings teach the scanner which incoming
        genre keywords belong to which category. After changing mappings, use <strong>Re-match all</strong>
        to re-apply them to existing books (no file rescan needed).
      </p>

      {error && <MessageBox tone="error" title="Categories error">{error}</MessageBox>}
      {notice && <MessageBox tone="success" title="Done">{notice}</MessageBox>}

      <div className="modal-tabs" style={{ marginTop: 12 }}>
        <button className={`modal-tab${tab === "categories" ? " active" : ""}`} onClick={() => setTab("categories")}>Categories</button>
        <button className={`modal-tab${tab === "mappings" ? " active" : ""}`} onClick={() => setTab("mappings")}>Mappings ({aliases.length})</button>
        <button className={`modal-tab${tab === "tags" ? " active" : ""}`} onClick={() => setTab("tags")}>Tags ({tags.length})</button>
      </div>

      {tab === "categories" && (
        <div className="datagrid-wrap" style={{ marginTop: 12 }}>
          <table className="datagrid">
            <thead>
              <tr>
                <th></th><th>Name</th><th>Icon</th><th>Image</th>
                <th className="col-num">Order</th><th className="col-num">Books</th><th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => {
                const draft = catDraft[category.id] ?? { name: category.name, sortOrder: String(category.sortOrder), icon: category.icon ?? "" };
                const dirty = draft.name.trim() !== category.name || Number(draft.sortOrder) !== category.sortOrder || (draft.icon || null) !== (category.icon ?? null);
                return (
                  <tr key={category.id}>
                    <td>
                      <div className="category-preview" aria-hidden="true">
                        {category.imageUrl ? <img src={category.imageUrl} alt="" /> : <CategoryIcon icon={draft.icon || category.icon} size={20} />}
                      </div>
                    </td>
                    <td>
                      <input
                        className="library-filter"
                        style={{ minWidth: 180 }}
                        value={draft.name}
                        onChange={(e) => setCatDraft((prev) => ({ ...prev, [category.id]: { ...draft, name: e.target.value } }))}
                      />
                    </td>
                    <td>
                      <select
                        className="library-filter"
                        value={draft.icon}
                        onChange={(e) => setCatDraft((prev) => ({ ...prev, [category.id]: { ...draft, icon: e.target.value } }))}
                      >
                        {CATEGORY_ICON_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}
                      </select>
                    </td>
                    <td>
                      <div className="category-image-actions">
                        <label className="secondary-button compact-button" title="Upload image">
                          <Upload size={14} />
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            style={{ display: "none" }}
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(category, f); e.currentTarget.value = ""; }}
                          />
                        </label>
                        {category.imageUrl && (
                          <button className="icon-button danger" onClick={() => removeImage(category)} aria-label="Remove image"><X size={14} /></button>
                        )}
                      </div>
                    </td>
                    <td className="col-num">
                      <input
                        className="library-filter"
                        style={{ minWidth: 60, width: 60 }}
                        type="number"
                        value={draft.sortOrder}
                        onChange={(e) => setCatDraft((prev) => ({ ...prev, [category.id]: { ...draft, sortOrder: e.target.value } }))}
                      />
                    </td>
                    <td className="col-num datagrid-muted">{category.bookCount}</td>
                    <td className="col-actions">
                      <button className="secondary-button compact-button" disabled={!dirty || !draft.name.trim()} onClick={() => saveCategory(category)}>
                        <Check size={14} /> Save
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === "mappings" && (
        <div className="datagrid-wrap" style={{ marginTop: 12 }}>
          <table className="datagrid">
            <thead>
              <tr><th>Keyword (contains)</th><th>Category</th><th className="col-num">Priority</th><th className="col-actions"></th></tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <input
                    className="library-filter"
                    style={{ minWidth: 200 }}
                    placeholder="e.g. детектив"
                    value={newKeyword}
                    onChange={(e) => setNewKeyword(e.target.value)}
                  />
                </td>
                <td>
                  <select className="library-filter" value={newCategoryId} onChange={(e) => setNewCategoryId(e.target.value)}>
                    {mappableCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </td>
                <td className="col-num">
                  <input className="library-filter" style={{ width: 64 }} type="number" value={newPriority} onChange={(e) => setNewPriority(e.target.value)} />
                </td>
                <td className="col-actions">
                  <button
                    className="primary-button compact-button"
                    disabled={!newKeyword.trim() || !newCategoryId}
                    onClick={() => { addAlias(newKeyword, newCategoryId, Number(newPriority) || 20); setNewKeyword(""); }}
                  >
                    <Plus size={14} /> Add
                  </button>
                </td>
              </tr>
              {aliases.map((alias) => (
                <tr key={alias.id}>
                  <td><strong>{alias.keyword}</strong></td>
                  <td>
                    <select className="library-filter" value={alias.categoryId} onChange={(e) => updateAlias(alias.id, { categoryId: e.target.value })}>
                      {mappableCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td className="col-num">
                    <input
                      className="library-filter"
                      style={{ width: 64 }}
                      type="number"
                      defaultValue={alias.priority}
                      onBlur={(e) => { const p = Number(e.target.value); if (p !== alias.priority) updateAlias(alias.id, { priority: p }); }}
                    />
                  </td>
                  <td className="col-actions">
                    <button className="icon-button danger" onClick={() => deleteAlias(alias.id)} aria-label="Delete mapping"><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "tags" && (
        <div className="datagrid-wrap" style={{ marginTop: 12 }}>
          {tags.length === 0 ? (
            <p className="management-empty">No tags yet. Scan a library and tags appear from book genres.</p>
          ) : (
            <table className="datagrid">
              <thead>
                <tr><th>Tag</th><th className="col-num">Books</th><th>Map to category</th></tr>
              </thead>
              <tbody>
                {tags.map((tag) => {
                  const already = mappedKeywords.has(tag.name.trim().toLowerCase());
                  return (
                    <tr key={tag.name}>
                      <td><strong>{tag.name}</strong></td>
                      <td className="col-num datagrid-muted">{tag.count}</td>
                      <td>
                        {already ? (
                          <span className="datagrid-muted">Already mapped</span>
                        ) : (
                          <select
                            className="library-filter"
                            defaultValue=""
                            onChange={(e) => { if (e.target.value) addAlias(tag.name, e.target.value, 20); }}
                          >
                            <option value="">Map to…</option>
                            {mappableCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
