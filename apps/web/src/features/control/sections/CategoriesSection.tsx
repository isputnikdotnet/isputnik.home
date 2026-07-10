import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, List, Pencil, Plus, RefreshCw, Search, Tags as TagsIcon, Trash2, Upload, X } from "lucide-react";
import { api } from "../../../api";
import { navigate } from "../../../router";
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
  mappingCount: number;
}

interface ManageAlias {
  id: string;
  keyword: string;
  priority: number;
  categoryId: string;
  categoryKey: string;
  categoryName: string;
}

type CategoryEditorTab = "mappings" | "tags";

const TAG_PAGE_SIZE = 60;

function normalizeKeyword(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[/_|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadCategoryAdminData() {
  const [cats, als] = await Promise.all([
    api<{ categories: ManageCategory[] }>("/api/library/manage/categories"),
    api<{ aliases: ManageAlias[] }>("/api/library/manage/aliases")
  ]);
  return { categories: cats.categories, aliases: als.aliases };
}

async function loadCategoryListData() {
  const cats = await api<{ categories: ManageCategory[] }>("/api/library/manage/categories");
  return { categories: cats.categories };
}

export function CategoriesSection() {
  const [categories, setCategories] = useState<ManageCategory[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rematching, setRematching] = useState(false);
  const [orderSavingId, setOrderSavingId] = useState("");
  const [orderDraft, setOrderDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await loadCategoryListData();
      setCategories(data.categories);
      setOrderDraft(Object.fromEntries(data.categories.map((category) => [category.id, String(category.sortOrder)])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load categories");
    }
  }, []);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(""), 4000);
  };

  const saveCategoryOrder = async (category: ManageCategory) => {
    const sortOrder = Number(orderDraft[category.id] ?? category.sortOrder);
    if (!Number.isFinite(sortOrder)) return;
    setOrderSavingId(category.id);
    setError("");
    try {
      await api(`/api/library/manage/categories/${category.id}`, {
        method: "PATCH",
        body: JSON.stringify({ sortOrder })
      });
      await load();
      flash("Category order saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save category order");
    } finally {
      setOrderSavingId("");
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

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Digital Library</p>
          <h1>Categories</h1>
        </div>
        <div className="category-head-actions">
          <button className="primary-button" onClick={() => navigate("/control/categories/new")}>
            <Plus size={16} /> Add category
          </button>
          <button className="secondary-button" onClick={rematch} disabled={rematching} title="Recompute every book's category from its tags using the current mappings">
            <RefreshCw size={15} /> {rematching ? "Re-matching..." : "Re-match all"}
          </button>
        </div>
      </div>

      <details className="category-help-panel category-help-disclosure">
        <summary className="category-help-summary">
          <List size={18} />
          <span>How category mapping works</span>
        </summary>
        <div className="category-help-grid">
          <div className="category-help-item">
            <strong>Tags are the source</strong>
            <span>When books are scanned, their genre values are saved as tags, such as detective, sci-fi, memoir, or history.</span>
          </div>
          <div className="category-help-item">
            <strong>Mappings are keywords</strong>
            <span>Each category has keywords. If a book tag contains one of those keywords, the book can be placed in that category.</span>
          </div>
          <div className="category-help-item">
            <strong>Priority breaks ties</strong>
            <span>If multiple keywords match the same book, the keyword with the higher priority wins.</span>
          </div>
          <div className="category-help-item">
            <strong>No match goes to General / Other</strong>
            <span>Books without a matching keyword stay in General / Other until a better keyword is added.</span>
          </div>
        </div>
        <div className="category-help-example">
          <strong>Example</strong>
          <span>
            A book has the tag <code>historical mystery</code>. If Mystery &amp; Thriller has keyword <code>mystery</code> with priority 20,
            and History has keyword <code>history</code> with priority 10, the book goes to Mystery &amp; Thriller because <code>mystery</code> matches and has the higher priority.
          </span>
        </div>
        <p className="category-help-note">
          Open a category and use <strong>Mappings</strong> to add keywords manually, or <strong>Tags</strong> to turn a scanned tag into a keyword. After changing mappings, run <strong>Re-match all</strong> to update existing books.
        </p>
      </details>

      {error && <MessageBox tone="error" title="Categories error">{error}</MessageBox>}
      {notice && <MessageBox tone="success" title="Done">{notice}</MessageBox>}

      <div className="datagrid-wrap" style={{ marginTop: 12 }}>
        <table className="datagrid">
          <thead>
            <tr>
              <th></th><th>Name</th>
              <th className="col-num">Order</th><th className="col-num">Books</th><th className="col-num">Mappings</th><th className="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            {categories.map((category) => {
              const draftOrder = orderDraft[category.id] ?? String(category.sortOrder);
              const orderDirty = Number(draftOrder) !== category.sortOrder;
              return (
                <tr key={category.id}>
                  <td>
                    <div className="category-preview" aria-hidden="true">
                      {category.imageUrl ? <img src={category.imageUrl} alt="" /> : <CategoryIcon icon={category.icon} size={20} />}
                    </div>
                  </td>
                  <td>
                    <div className="category-name-cell">
                      <strong>{category.name}</strong>
                      <span>{category.key}</span>
                    </div>
                  </td>
                  <td className="col-num">
                    <input
                      className="library-filter"
                      style={{ minWidth: 60, width: 60 }}
                      type="number"
                      value={draftOrder}
                      onChange={(event) => setOrderDraft((current) => ({ ...current, [category.id]: event.target.value }))}
                    />
                  </td>
                  <td className="col-num datagrid-muted">{category.bookCount}</td>
                  <td className="col-num datagrid-muted">{category.mappingCount}</td>
                  <td className="col-actions">
                    <div className="category-actions-cell">
                      <button
                        className="secondary-button compact-button"
                        disabled={!orderDirty || orderSavingId === category.id}
                        onClick={() => saveCategoryOrder(category)}
                      >
                        <Check size={14} /> Save order
                      </button>
                      <button className="secondary-button compact-button" onClick={() => navigate(`/control/categories/${category.id}`)}>
                        <Pencil size={14} /> Edit
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

    </>
  );
}

// One mapped-keyword row: the keyword text is edit-in-place (blur or Enter to save,
// Escape to cancel), the priority saves on blur, and a duplicate-keyword rejection
// reverts the field. Local state keeps the in-progress edit isolated per row.
function KeywordChip({ alias, onSaveKeyword, onSavePriority, onDelete }: {
  alias: ManageAlias;
  onSaveKeyword: (id: string, keyword: string) => Promise<void>;
  onSavePriority: (id: string, priority: number) => void;
  onDelete: (id: string) => void;
}) {
  const [text, setText] = useState(alias.keyword);
  const [busy, setBusy] = useState(false);
  // Re-sync when the list reloads (e.g. after a successful rename).
  useEffect(() => { setText(alias.keyword); }, [alias.keyword]);

  const commit = async () => {
    const next = text.trim();
    if (!next || next === alias.keyword) { setText(alias.keyword); return; }
    setBusy(true);
    try {
      await onSaveKeyword(alias.id, next);
    } catch {
      setText(alias.keyword); // the parent surfaces the reason; just revert the field
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="category-keyword-chip">
      <input
        className="category-keyword-name"
        aria-label={`Keyword "${alias.keyword}"`}
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          else if (event.key === "Escape") { setText(alias.keyword); event.currentTarget.blur(); }
        }}
      />
      <input
        aria-label={`Priority for ${alias.keyword}`}
        type="number"
        defaultValue={alias.priority}
        onBlur={(event) => {
          const nextPriority = Number(event.target.value);
          if (Number.isFinite(nextPriority) && nextPriority !== alias.priority) {
            onSavePriority(alias.id, nextPriority);
          }
        }}
      />
      <button type="button" onClick={() => onDelete(alias.id)} aria-label={`Delete ${alias.keyword}`}>
        <X size={16} />
      </button>
    </div>
  );
}

export function CategoryEditorPage({ categoryId }: { categoryId: string | null }) {
  const isNew = categoryId === null;
  const [aliases, setAliases] = useState<ManageAlias[]>([]);
  const [tags, setTags] = useState<TagSummary[]>([]);
  const [category, setCategory] = useState<ManageCategory | null>(null);
  const [editorTab, setEditorTab] = useState<CategoryEditorTab>("mappings");
  const [name, setName] = useState("");
  const [sortOrder, setSortOrder] = useState("0");
  const [icon, setIcon] = useState("layout-grid");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [priority, setPriority] = useState("20");
  // Tags tab: filter + incremental paging (the scanned-tag list can run to hundreds).
  const [tagSearch, setTagSearch] = useState("");
  const [tagLimit, setTagLimit] = useState(TAG_PAGE_SIZE);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [data, tagData] = await Promise.all([
        loadCategoryAdminData(),
        api<{ tags: TagSummary[] }>("/api/library/tags")
      ]);
      setAliases(data.aliases);
      setTags(tagData.tags);

      if (isNew) {
        const nextSortOrder = Math.min(Math.max(0, ...data.categories.filter((item) => item.key !== "general_other").map((item) => item.sortOrder)) + 1, 999);
        setCategory(null);
        setName("");
        setSortOrder(String(nextSortOrder));
        setIcon("layout-grid");
        setImageUrl(null);
        return;
      }

      const found = data.categories.find((item) => item.id === categoryId) ?? null;
      if (!found) {
        setError("Category not found");
        setCategory(null);
        return;
      }
      setCategory(found);
      setName(found.name);
      setSortOrder(String(found.sortOrder));
      setIcon(found.icon ?? "layout-grid");
      setImageUrl(found.imageUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load category");
    }
  }, [categoryId, isNew]);

  const loadAliases = useCallback(async () => {
    const payload = await api<{ aliases: ManageAlias[] }>("/api/library/manage/aliases");
    setAliases(payload.aliases);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => () => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
  }, [imagePreviewUrl]);

  const flash = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(""), 4000);
  };

  const chooseImage = (file: File) => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(file);
    setImagePreviewUrl(URL.createObjectURL(file));
    setRemoveImage(false);
  };

  const clearImage = () => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(null);
    setImagePreviewUrl(null);
    setRemoveImage(true);
  };

  const saveCategory = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError("");
    try {
      let id = category?.id ?? null;
      if (isNew) {
        const result = await api<{ category: ManageCategory }>("/api/library/manage/categories", {
          method: "POST",
          body: JSON.stringify({ name: name.trim(), sortOrder: Number(sortOrder) || 0, icon: icon || null })
        });
        id = result.category.id;
      } else if (id) {
        await api(`/api/library/manage/categories/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: name.trim(), sortOrder: Number(sortOrder) || 0, icon: icon || null })
        });
      }

      if (id && imageFile) {
        await api<{ imageUrl: string }>(`/api/library/manage/categories/${id}/image`, {
          method: "PUT",
          headers: { "Content-Type": imageFile.type || "application/octet-stream" },
          body: imageFile
        });
      } else if (id && !isNew && removeImage && imageUrl) {
        await api(`/api/library/manage/categories/${id}/image`, { method: "DELETE" });
      }

      if (isNew && id) {
        navigate(`/control/categories/${id}`);
        return;
      }
      setImageFile(null);
      setImagePreviewUrl(null);
      setRemoveImage(false);
      await load();
      flash("Category saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save category");
    } finally {
      setSaving(false);
    }
  };

  const deleteCategory = async () => {
    if (!category || category.key === "general_other") return;
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      return;
    }
    setDeleting(true);
    setError("");
    try {
      await api<{ movedBooks: number }>(`/api/library/manage/categories/${category.id}`, { method: "DELETE" });
      navigate("/control/categories");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete category");
    } finally {
      setDeleting(false);
    }
  };

  const addCategoryAliases = async () => {
    if (!category?.id) return;
    const keywords = keyword
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (keywords.length === 0) return;
    setError("");
    try {
      for (const item of keywords) {
        await api("/api/library/manage/aliases", {
          method: "POST",
          body: JSON.stringify({ keyword: item, categoryId: category.id, priority: Number(priority) || 20 })
        });
      }
      setKeyword("");
      await loadAliases();
      flash(`${keywords.length} mapping${keywords.length === 1 ? "" : "s"} added.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add mapping");
    }
  };

  // Edit an existing mapping in place — its keyword text and/or its priority. Throws on
  // failure (e.g. a 409 when the new keyword collides) so the caller can revert its field.
  const patchAlias = async (id: string, patch: { keyword?: string; priority?: number }) => {
    setError("");
    try {
      await api(`/api/library/manage/aliases/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await loadAliases();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update mapping");
      throw err;
    }
  };

  const deleteAlias = async (id: string) => {
    setError("");
    try {
      await api(`/api/library/manage/aliases/${id}`, { method: "DELETE" });
      await loadAliases();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete mapping");
    }
  };

  const addTagAsKeyword = async (tag: TagSummary) => {
    if (!category?.id) return;
    setError("");
    try {
      await api("/api/library/manage/aliases", {
        method: "POST",
        body: JSON.stringify({ keyword: tag.name, categoryId: category.id, priority: Number(priority) || 20 })
      });
      await loadAliases();
      flash(`Added "${tag.name}" as a keyword.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add tag as keyword");
    }
  };

  const editorAliases = category ? aliases.filter((alias) => alias.categoryId === category.id) : [];
  const aliasByKeyword = new Map(aliases.map((alias) => [normalizeKeyword(alias.keyword), alias]));
  const tagTerm = tagSearch.trim().toLowerCase();
  const filteredTags = tagTerm ? tags.filter((tag) => tag.name.toLowerCase().includes(tagTerm)) : tags;
  const visibleTags = filteredTags.slice(0, tagLimit);
  const currentImageUrl = imagePreviewUrl ?? (!removeImage ? imageUrl : null);
  const canDelete = category && category.key !== "general_other";

  return (
    <div className="category-editor-page">
      <div className="category-editor-page-head">
        <button className="text-button category-editor-back" onClick={() => navigate("/control/categories")}>
          <ArrowLeft size={15} />
          Categories
        </button>
        <div className="category-editor-title-row">
          <h1>{isNew ? "Add category" : "Edit category"}</h1>
          <div className="category-head-actions">
            <button className="secondary-button" type="button" onClick={() => navigate("/control/categories")} disabled={saving || deleting}>
              Cancel
            </button>
            <button className="primary-button" type="button" onClick={saveCategory} disabled={saving || deleting || !name.trim()}>
              <Check size={16} /> {saving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </div>
      </div>

      {error && <MessageBox tone="error" title="Category error">{error}</MessageBox>}
      {notice && <MessageBox tone="success" title="Done">{notice}</MessageBox>}

      <div className="category-editor-page-layout">
        <aside className="category-editor-side">
          <div className="category-large-preview" aria-hidden="true">
            {currentImageUrl ? (
              <img src={currentImageUrl} alt="" />
            ) : (
              <CategoryIcon icon={icon} size={44} />
            )}
          </div>

          <div className="category-image-actions">
            <label className="secondary-button compact-button">
              <Upload size={15} />
              <span>Upload image</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ display: "none" }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) chooseImage(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            {currentImageUrl && (
              <button className="icon-button danger" type="button" onClick={clearImage} aria-label="Remove image">
                <X size={15} />
              </button>
            )}
          </div>

          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
          </label>

          <label className="field">
            <span>Icon</span>
            <select value={icon} onChange={(event) => setIcon(event.target.value)}>
              {CATEGORY_ICON_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}
            </select>
          </label>

          <label className="field">
            <span>Order</span>
            <input type="number" min={0} max={999} value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} />
          </label>

          {canDelete && (
            <div className="category-danger-zone">
              {deleteConfirm && (
                <span>
                  Delete this category and move {category.bookCount} book{category.bookCount === 1 ? "" : "s"} to General / Other?
                </span>
              )}
              <button className="text-button danger" type="button" onClick={deleteCategory} disabled={saving || deleting}>
                <Trash2 size={15} />
                {deleteConfirm ? (deleting ? "Deleting..." : "Confirm delete") : "Delete category"}
              </button>
              {deleteConfirm && (
                <button className="secondary-button compact-button" type="button" onClick={() => setDeleteConfirm(false)} disabled={deleting}>
                  Cancel delete
                </button>
              )}
            </div>
          )}
        </aside>

        <section className="category-editor-main">
          <div className="category-editor-tabs">
            <button
              className={`category-editor-tab${editorTab === "mappings" ? " active" : ""}`}
              type="button"
              onClick={() => setEditorTab("mappings")}
            >
              <List size={18} />
              <span>Mappings</span>
              <strong>{editorAliases.length}</strong>
            </button>
            <button
              className={`category-editor-tab${editorTab === "tags" ? " active" : ""}`}
              type="button"
              onClick={() => setEditorTab("tags")}
            >
              <TagsIcon size={18} />
              <span>Tags</span>
              <strong>{tags.length}</strong>
            </button>
          </div>

          {editorTab === "mappings" && (
            <>
              <div className="category-mapping-panel">
                <div className="category-mapping-head">
                  <div>
                    <h2>Mapped keywords</h2>
                    <span>{editorAliases.length} keyword{editorAliases.length === 1 ? "" : "s"}</span>
                  </div>
                </div>

                <div className="category-keyword-grid">
                  {editorAliases.map((alias) => (
                    <KeywordChip
                      key={alias.id}
                      alias={alias}
                      onSaveKeyword={(id, kw) => patchAlias(id, { keyword: kw })}
                      onSavePriority={(id, p) => { void patchAlias(id, { priority: p }).catch(() => {}); }}
                      onDelete={deleteAlias}
                    />
                  ))}
                </div>
              </div>

              <div className="category-quick-add">
                <label className="field">
                  <span>Add keyword</span>
                  <input
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addCategoryAliases();
                      }
                    }}
                    placeholder="e.g. mystery, detective, crime"
                  />
                </label>
                <label className="field">
                  <span>Default priority</span>
                  <input type="number" min={0} max={999} value={priority} onChange={(event) => setPriority(event.target.value)} />
                </label>
                <button
                  className="primary-button"
                  type="button"
                  onClick={addCategoryAliases}
                  disabled={!category || !keyword.trim()}
                >
                  Add
                </button>
              </div>
            </>
          )}

          {editorTab === "tags" && (
            <div className="category-mapping-panel">
              <div className="category-mapping-head">
                <div>
                  <h2>Scanned tags</h2>
                  <span>{tagTerm ? `${filteredTags.length} of ${tags.length}` : tags.length} tag{tags.length === 1 ? "" : "s"}{tagTerm ? " matching" : " available as keyword candidates"}</span>
                </div>
                <label className="category-tag-priority">
                  <span>Default priority</span>
                  <input type="number" min={0} max={999} value={priority} onChange={(event) => setPriority(event.target.value)} />
                </label>
              </div>

              {tags.length > 0 && (
                <label className="search-field category-tag-search">
                  <Search size={17} aria-hidden="true" />
                  <input
                    type="search"
                    value={tagSearch}
                    onChange={(event) => { setTagSearch(event.target.value); setTagLimit(TAG_PAGE_SIZE); }}
                    placeholder="Search tags"
                    aria-label="Search scanned tags"
                  />
                </label>
              )}

              {tags.length === 0 ? (
                <p className="management-empty">No tags yet. Scan a library and tags appear from book genres.</p>
              ) : filteredTags.length === 0 ? (
                <p className="management-empty">No tags match your search.</p>
              ) : (
                <>
                <div className="category-keyword-grid category-tag-grid">
                  {visibleTags.map((tag) => {
                    const existingAlias = aliasByKeyword.get(normalizeKeyword(tag.name));
                    const addedHere = existingAlias?.categoryId === category?.id;
                    const mappedElsewhere = existingAlias && !addedHere;
                    return (
                      <div className={`category-tag-chip${addedHere ? " added" : ""}`} key={tag.name}>
                        <div className="category-tag-copy">
                          <strong title={tag.name}>{tag.name}</strong>
                          <span>{tag.count} book{tag.count === 1 ? "" : "s"}</span>
                        </div>
                        {addedHere ? (
                          <span className="category-tag-status">
                            <Check size={14} /> Added
                          </span>
                        ) : mappedElsewhere ? (
                          <span className="category-tag-status" title={`Mapped to ${existingAlias.categoryName}`}>
                            {existingAlias.categoryName}
                          </span>
                        ) : (
                          <button
                            className="secondary-button compact-button"
                            type="button"
                            onClick={() => addTagAsKeyword(tag)}
                            disabled={!category}
                          >
                            <Plus size={14} /> Add
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {filteredTags.length > visibleTags.length && (
                  <div className="category-tag-more">
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      onClick={() => setTagLimit((limit) => limit + TAG_PAGE_SIZE)}
                    >
                      Show more ({filteredTags.length - visibleTags.length})
                    </button>
                  </div>
                )}
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
