import { useState, useEffect, useCallback, type FormEvent } from "react";
import { Plus, RefreshCw, Pencil, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate } from "../../../shared/utils";
import { CategoryIcon, SECTION_ICON_KEYS } from "../../audiobooks/categoryIcons";
import type { AudiobookLibrary, CategorySummary, LibrarySection } from "../../audiobooks/types";
import type { LibrarySettings, ManagedUser, ManagedGroup, StorageRoot, StorageBrowse } from "../types";

interface OverrideForm {
  author: string;
  narrator: string;
  description: string;
  categoryKey: string;
  tags: string;
}

const EMPTY_OVERRIDE: OverrideForm = { author: "", narrator: "", description: "", categoryKey: "", tags: "" };

function overridesPayload(form: OverrideForm) {
  return {
    author: form.author.trim() || undefined,
    narrator: form.narrator.trim() || undefined,
    description: form.description.trim() || undefined,
    categoryKey: form.categoryKey || undefined,
    tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
  };
}

function overridesToForm(overrides: AudiobookLibrary["overrides"]): OverrideForm {
  return {
    author: overrides?.author ?? "",
    narrator: overrides?.narrator ?? "",
    description: overrides?.description ?? "",
    categoryKey: overrides?.categoryKey ?? "",
    tags: (overrides?.tags ?? []).join(", ")
  };
}

// Per-library metadata overrides for a special-section library. Any field left
// blank falls back to normal scan-derived metadata on add and rescan.
function OverrideFields({
  overrides,
  onChange,
  categories
}: {
  overrides: OverrideForm;
  onChange: (next: OverrideForm) => void;
  categories: CategorySummary[];
}) {
  const set = (patch: Partial<OverrideForm>) => onChange({ ...overrides, ...patch });
  return (
    <fieldset className="override-fields">
      <legend>Overwrite on add &amp; rescan</legend>
      <p className="muted override-hint">
        Overwrites scanned metadata for every book. Leave blank to keep what the scan finds (e.g. blank Author keeps each story's real writer).
      </p>
      <div className="override-grid">
        <Field label="Author" value={overrides.author} onChange={(v) => set({ author: v })} required={false} />
        <Field label="Narrator" value={overrides.narrator} onChange={(v) => set({ narrator: v })} required={false} />
        <label className="field">
          <span>Category</span>
          <select value={overrides.categoryKey} onChange={(event) => set({ categoryKey: event.target.value })}>
            <option value="">Auto (from scan)</option>
            {categories.map((category) => (
              <option key={category.key} value={category.key}>{category.name}</option>
            ))}
          </select>
        </label>
        <Field label="Tags (comma-separated)" value={overrides.tags} onChange={(v) => set({ tags: v })} required={false} />
        <label className="field override-desc">
          <span>Description</span>
          <textarea
            value={overrides.description}
            onChange={(event) => set({ description: event.target.value })}
            rows={2}
          />
        </label>
      </div>
    </fieldset>
  );
}

export function LibrariesSection({ tab }: { tab: "audiobooks" | "special" }) {
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  const [librarySettings, setLibrarySettings] = useState<LibrarySettings | null>(null);
  const [storageRoots, setStorageRoots] = useState<StorageRoot[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [selectedRootId, setSelectedRootId] = useState("");
  const [storageBrowse, setStorageBrowse] = useState<StorageBrowse | null>(null);
  const [libraryName, setLibraryName] = useState("");
  const [libraryVisibility, setLibraryVisibility] = useState<"public" | "private">("public");
  const [libraryIgnoreSidecar, setLibraryIgnoreSidecar] = useState(false);
  const [libraryOwnerId, setLibraryOwnerId] = useState("");
  const [libraryOwnerType, setLibraryOwnerType] = useState<"user" | "group" | "">("");
  const [rescanTarget, setRescanTarget] = useState<AudiobookLibrary | null>(null);
  const [rescanSkipSidecar, setRescanSkipSidecar] = useState(false);
  const [rescanEncoding, setRescanEncoding] = useState("auto");
  const [rescanRunning, setRescanRunning] = useState(false);
  const [deleteConfirmLibrary, setDeleteConfirmLibrary] = useState<AudiobookLibrary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createLibraryOpen, setCreateLibraryOpen] = useState(false);
  const [editingLibrary, setEditingLibrary] = useState<AudiobookLibrary | null>(null);
  const [editName, setEditName] = useState("");
  const [editVisibility, setEditVisibility] = useState<"public" | "private">("public");
  const [editOwnerId, setEditOwnerId] = useState("");
  const [editOwnerType, setEditOwnerType] = useState<"user" | "group" | "">("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [sections, setSections] = useState<LibrarySection[]>([]);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [librarySectionId, setLibrarySectionId] = useState("");
  const [libraryOverrides, setLibraryOverrides] = useState<OverrideForm>(EMPTY_OVERRIDE);
  const [wizardStep, setWizardStep] = useState(0);
  const [editSectionId, setEditSectionId] = useState("");
  const [editOverrides, setEditOverrides] = useState<OverrideForm>(EMPTY_OVERRIDE);
  // Section CRUD (the grouping shell — name + icon only).
  const [sectionModalOpen, setSectionModalOpen] = useState(false);
  const [editingSection, setEditingSection] = useState<LibrarySection | null>(null);
  const [sectionName, setSectionName] = useState("");
  const [sectionIcon, setSectionIcon] = useState("radio");
  const [sectionSaving, setSectionSaving] = useState(false);
  const [deleteConfirmSection, setDeleteConfirmSection] = useState<LibrarySection | null>(null);

  const loadStorage = useCallback(async () => {
    const settingsPayload = await api<{ settings: LibrarySettings }>("/api/library/settings");
    setLibrarySettings(settingsPayload.settings);

    const rootsPayload = await api<{ roots: StorageRoot[] }>("/api/storage/roots");
    setStorageRoots(rootsPayload.roots);
    setSelectedRootId((current) => current || rootsPayload.roots[0]?.id || "");
    return { settings: settingsPayload.settings, roots: rootsPayload.roots };
  }, []);

  const loadLibraries = useCallback(async () => {
    await loadStorage();
    const [librariesPayload, usersPayload, groupsPayload, sectionsPayload, categoriesPayload] = await Promise.all([
      api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries"),
      api<{ users: ManagedUser[] }>("/api/users"),
      api<{ groups: ManagedGroup[] }>("/api/groups"),
      api<{ sections: LibrarySection[] }>("/api/library/sections"),
      api<{ categories: CategorySummary[] }>("/api/library/categories")
    ]);
    setLibraries(librariesPayload.libraries);
    setUsers(usersPayload.users);
    setGroups(groupsPayload.groups);
    setSections(sectionsPayload.sections);
    setCategories(categoriesPayload.categories);
  }, [loadStorage]);

  useEffect(() => {
    loadLibraries().catch((err) => setError(err instanceof Error ? err.message : "Unable to load libraries"));
  }, [loadLibraries]);

  useEffect(() => {
    if (!libraries.some((library) => library.scanStatus === "scanning")) {
      return;
    }

    const timer = window.setInterval(() => {
      loadLibraries().catch((err) => setError(err instanceof Error ? err.message : "Unable to load libraries"));
    }, 2500);

    return () => window.clearInterval(timer);
  }, [libraries, loadLibraries]);

  useEffect(() => {
    if (!createLibraryOpen) {
      return;
    }

    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creating) {
        setCreateLibraryOpen(false);
        setStorageBrowse(null);
      }
    };

    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [createLibraryOpen, creating]);

  const browseStorageRoot = async (rootId: string, relativePath = "") => {
    const query = new URLSearchParams({ path: relativePath });
    const payload = await api<StorageBrowse>(`/api/storage/roots/${rootId}/browse?${query}`);
    setSelectedRootId(rootId);
    setStorageBrowse(payload);
  };

  const createLibrary = async (event: FormEvent) => {
    event.preventDefault();
    if (!storageBrowse?.selectedPath) {
      setError("Choose a storage container folder for this library.");
      return;
    }

    setCreating(true);
    setError("");
    try {
      await api<{ library: { id: string } }>("/api/library/audiobook-libraries", {
        method: "POST",
        body: JSON.stringify({
          name: libraryName,
          sourcePath: storageBrowse.selectedPath,
          defaultLanguage: "en",
          ignoreSidecar: libraryIgnoreSidecar,
          visibility: libraryVisibility,
          ownerId: libraryOwnerId || null,
          ownerType: libraryOwnerType || null,
          sectionId: librarySectionId || null,
          overrides: librarySectionId ? overridesPayload(libraryOverrides) : null
        })
      });
      setCreateLibraryOpen(false);
      setLibraryName("");
      setLibraryVisibility("public");
      setLibraryIgnoreSidecar(false);
      setLibraryOwnerId("");
      setLibraryOwnerType("");
      setLibrarySectionId("");
      setLibraryOverrides(EMPTY_OVERRIDE);
      setStorageBrowse(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create audiobook library");
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (library: AudiobookLibrary) => {
    setEditingLibrary(library);
    setEditName(library.name);
    setEditVisibility(library.visibility);
    setEditOwnerId(library.ownerId ?? "");
    setEditOwnerType(library.ownerType ?? "");
    setEditSectionId(library.sectionId ?? "");
    setEditOverrides(overridesToForm(library.overrides));
    setError("");
  };

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingLibrary) return;
    setSaving(true);
    setError("");
    try {
      await api(`/api/library/audiobook-libraries/${editingLibrary.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName,
          visibility: editVisibility,
          ownerId: editOwnerId || null,
          ownerType: editOwnerType || null,
          sectionId: editSectionId || null,
          overrides: editSectionId ? overridesPayload(editOverrides) : null
        })
      });
      setEditingLibrary(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save changes");
    } finally {
      setSaving(false);
    }
  };

  const openRescan = (library: AudiobookLibrary) => {
    setRescanTarget(library);
    setRescanSkipSidecar(library.ignoreSidecar);
    setRescanEncoding("auto");
    setError("");
  };

  const runRescan = async () => {
    if (!rescanTarget) return;
    setRescanRunning(true);
    setError("");
    try {
      await api(`/api/library/audiobook-libraries/${rescanTarget.id}/rescan`, {
        method: "POST",
        body: JSON.stringify({
          skipSidecar: rescanSkipSidecar,
          tagEncoding: rescanEncoding === "auto" ? undefined : rescanEncoding
        })
      });
      setRescanTarget(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to scan audiobook library");
    } finally {
      setRescanRunning(false);
    }
  };

  const deleteLibrary = async () => {
    if (!deleteConfirmLibrary) return;
    setDeleting(true);
    setError("");
    try {
      await api(`/api/library/audiobook-libraries/${deleteConfirmLibrary.id}`, { method: "DELETE" });
      setDeleteConfirmLibrary(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete library");
    } finally {
      setDeleting(false);
    }
  };

  const openSectionModal = (section: LibrarySection | null) => {
    setEditingSection(section);
    setSectionName(section?.name ?? "");
    setSectionIcon(section?.icon ?? "radio");
    setSectionModalOpen(true);
    setError("");
  };

  const saveSection = async (event: FormEvent) => {
    event.preventDefault();
    setSectionSaving(true);
    setError("");
    try {
      const path = editingSection ? `/api/library/sections/${editingSection.id}` : "/api/library/sections";
      await api(path, {
        method: editingSection ? "PATCH" : "POST",
        body: JSON.stringify({ name: sectionName, icon: sectionIcon })
      });
      setSectionModalOpen(false);
      setEditingSection(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save section");
    } finally {
      setSectionSaving(false);
    }
  };

  const deleteSection = async () => {
    if (!deleteConfirmSection) return;
    setSectionSaving(true);
    setError("");
    try {
      await api(`/api/library/sections/${deleteConfirmSection.id}`, { method: "DELETE" });
      setDeleteConfirmSection(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete section");
    } finally {
      setSectionSaving(false);
    }
  };

  const displayedLibraries = tab === "special"
    ? libraries.filter((library) => library.specialSection)
    : libraries.filter((library) => !library.specialSection);

  const openCreateLibrary = () => {
    setError("");
    setLibrarySectionId(tab === "special" ? (sections[0]?.id ?? "") : "");
    setLibraryOverrides(EMPTY_OVERRIDE);
    setWizardStep(0);
    setCreateLibraryOpen(true);
    const rootId = selectedRootId || storageRoots[0]?.id || "";
    if (rootId) {
      browseStorageRoot(rootId).catch((err) => setError(err instanceof Error ? err.message : "Unable to browse storage container"));
    }
  };

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Digital Library</p>
          <h1>Audiobooks</h1>
        </div>
        <div className="row-actions">
          {tab === "special" && (
            <button
              className="icon-button with-label"
              onClick={() => openSectionModal(null)}
              title="Add special section"
            >
              <Plus size={18} />
              <span>Add section</span>
            </button>
          )}
          <button
            className="icon-button with-label"
            disabled={!librarySettings?.thumbnailPathReady || storageRoots.length === 0}
            onClick={openCreateLibrary}
            title="Add audiobook library"
          >
            <Plus size={18} />
            <span>Add library</span>
          </button>
        </div>
      </div>


      {error && <MessageBox tone="error" title="Audiobook library error">{error}</MessageBox>}
      {(!librarySettings?.thumbnailPathReady || storageRoots.length === 0) && (
        <MessageBox tone="warning" title="Storage setup required">
          Configure thumbnail storage and at least one Digital Library container before adding libraries.
        </MessageBox>
      )}

      {tab === "special" && sections.length === 0 && (
        <MessageBox tone="info" title="No sections yet">
          Create a section first ("Add section"), then add libraries to it. A section is a master icon in the audiobook sidebar that groups its libraries and hides their books from the main grid.
        </MessageBox>
      )}

      {tab === "special" && sections.length > 0 && (
        <div className="section-list" style={{ marginBottom: 18 }}>
          {sections.map((section) => (
            <div className="section-list-row" key={section.id}>
              <span className="audiobook-section-icon" aria-hidden="true">
                <CategoryIcon icon={section.icon} size={20} />
              </span>
              <div className="datagrid-primary">
                <strong>{section.name}</strong>
                <small>{section.libraryCount} {section.libraryCount === 1 ? "library" : "libraries"}</small>
              </div>
              <div className="row-actions">
                <button className="icon-button" title="Edit section" onClick={() => openSectionModal(section)}>
                  <Pencil size={15} />
                </button>
                <button className="icon-button danger" title="Delete section" onClick={() => setDeleteConfirmSection(section)}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {displayedLibraries.length === 0 ? (
        <p className="management-empty">
          {tab === "special" ? "No special-section libraries yet." : "No audiobook libraries configured."}
        </p>
      ) : (
        <div className="datagrid-wrap">
          <table className="datagrid">
            <thead>
              <tr>
                <th>Library</th>
                <th>Visibility</th>
                <th className="col-num">Books</th>
                <th className="col-num">Files</th>
                <th className="col-scan">Last scanned</th>
                <th>Status</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {displayedLibraries.map((library) => {
                const ownerUser = library.ownerType === "user" ? users.find((u) => u.id === library.ownerId) : null;
                const ownerGroup = library.ownerType === "group" ? groups.find((g) => g.id === library.ownerId) : null;
                return (
                  <tr key={library.id}>
                    <td>
                      <div className="datagrid-primary">
                        <strong>{library.name}</strong>
                        <small>{library.sourcePath ?? "Source path hidden"}</small>
                        {ownerUser && <small>Owner: {ownerUser.displayName}</small>}
                        {ownerGroup && <small>Owner: {ownerGroup.name} (group)</small>}
                        {library.sectionId && (
                          <small>Section: {sections.find((s) => s.id === library.sectionId)?.name ?? "—"}</small>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge ${library.visibility}`}>
                        {library.visibility === "public" ? "Public" : "Private"}
                      </span>
                    </td>
                    <td className="col-num datagrid-muted">{library.bookCount}</td>
                    <td className="col-num datagrid-muted">{library.fileCount}</td>
                    <td className="col-scan datagrid-muted">
                      {library.lastScannedAt ? formatManagedDate(library.lastScannedAt) : "Not yet"}
                    </td>
                    <td>
                      <span className={`status-badge ${library.scanStatus}`}>{library.scanStatus}</span>
                    </td>
                    <td className="col-actions">
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          title="Edit library"
                          onClick={() => openEdit(library)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="secondary-button compact-button rescan-library-button"
                          disabled={library.scanStatus === "scanning"}
                          onClick={() => openRescan(library)}
                          title={library.scanStatus === "scanning" ? "Scan already in progress" : "Rescan library"}
                        >
                          <RefreshCw size={14} />
                          {library.scanStatus === "scanning" ? "Scanning..." : "Rescan"}
                        </button>
                        <button
                          className="icon-button danger"
                          title="Delete library"
                          onClick={() => setDeleteConfirmLibrary(library)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {createLibraryOpen && (() => {
        // Build the wizard step sequence: overrides step only appears for a
        // special-section library that has a section selected.
        const steps: ("details" | "overrides" | "source")[] = [
          "details",
          ...(tab === "special" && librarySectionId ? ["overrides" as const] : []),
          "source"
        ];
        const lastStep = steps.length - 1;
        const current = Math.min(wizardStep, lastStep);
        const stepKey = steps[current];
        const stepTitles: Record<typeof steps[number], string> = {
          details: "Details",
          overrides: "Metadata overrides",
          source: "Source folder"
        };
        const canLeaveDetails = libraryName.trim().length >= 2;
        const canSubmit = Boolean(storageBrowse?.selectedPath) && Boolean(librarySettings?.thumbnailPathReady) && storageRoots.length > 0;
        const closeWizard = () => { setCreateLibraryOpen(false); setStorageBrowse(null); };
        const goNext = () => {
          if (stepKey === "details" && !canLeaveDetails) {
            setError("Enter a library name (at least 2 characters) to continue.");
            return;
          }
          setError("");
          setWizardStep(current + 1);
        };
        const onWizardSubmit = (event: FormEvent) => {
          if (current < lastStep) { event.preventDefault(); goNext(); return; }
          createLibrary(event);
        };

        return (
        <div className="modal-backdrop" onMouseDown={() => !creating && closeWizard()}>
          <form
            className="confirm-modal create-library-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-library-title"
            onSubmit={onWizardSubmit}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div>
              <h2 id="create-library-title">Add audiobook library</h2>
              <p className="wizard-step-indicator">Step {current + 1} of {steps.length} — {stepTitles[stepKey]}</p>
            </div>
            {(!librarySettings?.thumbnailPathReady || storageRoots.length === 0) && (
              <MessageBox tone="warning" title="Thumbnail storage required">
                Configure thumbnail storage and at least one Digital Library container first.
              </MessageBox>
            )}

            {stepKey === "details" && (
              <>
                <Field label="Library name" value={libraryName} onChange={setLibraryName} />
                <label className="field">
                  <span>Owner</span>
                  <select
                    value={libraryOwnerId ? `${libraryOwnerType}:${libraryOwnerId}` : ""}
                    onChange={(event) => {
                      const val = event.target.value;
                      if (!val) { setLibraryOwnerId(""); setLibraryOwnerType(""); return; }
                      const [type, id] = val.split(":");
                      setLibraryOwnerType(type as "user" | "group");
                      setLibraryOwnerId(id);
                    }}
                  >
                    <option value="">No owner (system library)</option>
                    {users.length > 0 && (
                      <optgroup label="Users">
                        {users.map((user) => (
                          <option value={`user:${user.id}`} key={user.id}>{user.displayName} ({user.email})</option>
                        ))}
                      </optgroup>
                    )}
                    {groups.length > 0 && (
                      <optgroup label="Groups">
                        {groups.map((group) => (
                          <option value={`group:${group.id}`} key={group.id}>{group.name}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </label>
                <label className="field">
                  <span>Visibility</span>
                  <select value={libraryVisibility} onChange={(event) => setLibraryVisibility(event.target.value as "public" | "private")}>
                    <option value="public">Public — all users can access</option>
                    <option value="private">Private — owner and admins only</option>
                  </select>
                </label>
                {tab === "special" && (
                  <label className="field">
                    <span>Special section</span>
                    <select value={librarySectionId} onChange={(event) => setLibrarySectionId(event.target.value)}>
                      <option value="">None — show in the main grid</option>
                      {sections.map((section) => (
                        <option key={section.id} value={section.id}>{section.name}</option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}

            {stepKey === "overrides" && (
              <OverrideFields overrides={libraryOverrides} onChange={setLibraryOverrides} categories={categories} />
            )}

            {stepKey === "source" && (
              <>
                <label className="field">
                  <span>Container</span>
                  <select
                    value={selectedRootId}
                    onChange={(event) => browseStorageRoot(event.target.value).catch((err) => setError(err instanceof Error ? err.message : "Unable to browse storage container"))}
                    required
                  >
                    {storageRoots.map((root) => (
                      <option value={root.id} key={root.id}>{root.name}</option>
                    ))}
                  </select>
                </label>
                {storageBrowse && (
                  <section className="folder-browser" aria-label="Library folder browser">
                    <div className="folder-browser-head">
                      <div>
                        <strong>{storageBrowse.currentPath || storageBrowse.root.name}</strong>
                        <span>{storageBrowse.selectedPath}</span>
                      </div>
                      {storageBrowse.parentPath !== null && (
                        <button
                          className="secondary-button compact-button"
                          type="button"
                          onClick={() => browseStorageRoot(storageBrowse.root.id, storageBrowse.parentPath ?? "")}
                        >
                          Up
                        </button>
                      )}
                    </div>
                    <div className="folder-list">
                      {storageBrowse.entries.map((entry) => (
                        <button
                          className="folder-row"
                          type="button"
                          key={entry.relativePath}
                          onClick={() => browseStorageRoot(storageBrowse.root.id, entry.relativePath)}
                        >
                          {entry.name}
                        </button>
                      ))}
                      {storageBrowse.entries.length === 0 && <p className="management-empty">No child folders found. The current folder can still be used.</p>}
                    </div>
                  </section>
                )}
                <label className="field-checkbox">
                  <input
                    type="checkbox"
                    checked={libraryIgnoreSidecar}
                    onChange={(event) => setLibraryIgnoreSidecar(event.target.checked)}
                  />
                  <span>Do not read metadata.json files</span>
                </label>
              </>
            )}

            {error && <MessageBox tone="error" title="Unable to add library">{error}</MessageBox>}

            <div className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={current > 0 ? () => setWizardStep(current - 1) : closeWizard}
                disabled={creating}
              >
                {current > 0 ? "Back" : "Cancel"}
              </button>
              {current < lastStep ? (
                <button className="primary-button" type="submit">
                  Next
                </button>
              ) : (
                <button className="primary-button" type="submit" disabled={creating || !canSubmit}>
                  {creating ? "Scanning..." : "Add and scan"}
                </button>
              )}
            </div>
          </form>
        </div>
        );
      })()}

      {rescanTarget && (
        <div className="modal-backdrop" onMouseDown={() => !rescanRunning && setRescanTarget(null)}>
          <div
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rescan-library-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 id="rescan-library-title">Rescan "{rescanTarget.name}"</h2>
            <p>Re-index this library from disk. Your files are never modified, and manually edited metadata is kept.</p>
            <label className="field-checkbox">
              <input
                type="checkbox"
                checked={rescanSkipSidecar}
                onChange={(event) => setRescanSkipSidecar(event.target.checked)}
              />
              <span>Skip metadata.json sidecar files (read tags only)</span>
            </label>
            <label className="field">
              <span>Tag text encoding</span>
              <select value={rescanEncoding} onChange={(event) => setRescanEncoding(event.target.value)}>
                <option value="auto">Auto — leave tags as-is</option>
                <option value="windows-1251">Windows-1251 (Cyrillic)</option>
                <option value="windows-1250">Windows-1250 (Central European)</option>
                <option value="windows-1252">Windows-1252 (Western European)</option>
                <option value="koi8-r">KOI8-R (Cyrillic)</option>
              </select>
            </label>
            {rescanEncoding !== "auto" && (
              <p className="muted" style={{ fontSize: "0.8rem", lineHeight: 1.4 }}>
                Repairs garbled tag text (e.g. "Ðàíåå" → "Ранее") for files whose tags were saved in this legacy encoding. Correctly stored tags are left untouched.
              </p>
            )}
            {error && <MessageBox tone="error" title="Rescan error">{error}</MessageBox>}
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setRescanTarget(null)} disabled={rescanRunning} autoFocus>
                Cancel
              </button>
              <button className="primary-button" onClick={runRescan} disabled={rescanRunning}>
                <RefreshCw size={15} /> {rescanRunning ? "Starting…" : "Start rescan"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmLibrary && (
        <div className="modal-backdrop" onMouseDown={() => !deleting && setDeleteConfirmLibrary(null)}>
          <div
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-library-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 id="delete-library-title">Delete "{deleteConfirmLibrary.name}"?</h2>
            <p>This will remove the library and all its book records, metadata, series, and genres from the database.</p>
            <p><strong>Your files on disk will not be touched.</strong> You can re-add this library at any time and it will be re-scanned from the same folder.</p>
            {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setDeleteConfirmLibrary(null)}
                disabled={deleting}
                autoFocus
              >
                Cancel
              </button>
              <button className="danger-button" onClick={deleteLibrary} disabled={deleting}>
                <Trash2 size={15} /> {deleting ? "Deleting…" : "Yes, delete library"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingLibrary && (
        <div className="modal-backdrop" onMouseDown={() => !saving && setEditingLibrary(null)}>
          <form
            className="confirm-modal edit-library-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-library-title"
            onSubmit={saveEdit}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="edit-library-title">Edit library</h2>
            <Field label="Library name" value={editName} onChange={setEditName} />
            <label className="field">
              <span>Owner</span>
              <select
                value={editOwnerId ? `${editOwnerType}:${editOwnerId}` : ""}
                onChange={(event) => {
                  const val = event.target.value;
                  if (!val) { setEditOwnerId(""); setEditOwnerType(""); return; }
                  const [type, id] = val.split(":");
                  setEditOwnerType(type as "user" | "group");
                  setEditOwnerId(id);
                }}
              >
                <option value="">No owner (system library)</option>
                {users.length > 0 && (
                  <optgroup label="Users">
                    {users.map((user) => (
                      <option value={`user:${user.id}`} key={user.id}>{user.displayName} ({user.email})</option>
                    ))}
                  </optgroup>
                )}
                {groups.length > 0 && (
                  <optgroup label="Groups">
                    {groups.map((group) => (
                      <option value={`group:${group.id}`} key={group.id}>{group.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <label className="field">
              <span>Visibility</span>
              <select value={editVisibility} onChange={(event) => setEditVisibility(event.target.value as "public" | "private")}>
                <option value="public">Public — all users can access</option>
                <option value="private">Private — owner and admins only</option>
              </select>
            </label>
            <label className="field">
              <span>Special section</span>
              <select value={editSectionId} onChange={(event) => setEditSectionId(event.target.value)}>
                <option value="">None — show in the main grid</option>
                {sections.map((section) => (
                  <option key={section.id} value={section.id}>{section.name}</option>
                ))}
              </select>
            </label>
            {editSectionId && (
              <OverrideFields overrides={editOverrides} onChange={setEditOverrides} categories={categories} />
            )}
            {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setEditingLibrary(null)} disabled={saving} autoFocus>
                Cancel
              </button>
              <button className="primary-button" disabled={saving || !editName.trim()}>
                {saving ? "Saving..." : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      )}

      {sectionModalOpen && (
        <div className="modal-backdrop" onMouseDown={() => !sectionSaving && setSectionModalOpen(false)}>
          <form
            className="confirm-modal section-form-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="section-modal-title"
            onSubmit={saveSection}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="section-modal-title">{editingSection ? "Edit section" : "Add special section"}</h2>
            <p>A section is a master icon on the Audiobooks page that groups one or more libraries. Its books are kept out of the main grid.</p>
            <Field label="Section name" value={sectionName} onChange={setSectionName} />
            <label className="field">
              <span>Icon</span>
              <div className="section-icon-picker">
                {SECTION_ICON_KEYS.map((key) => (
                  <button
                    type="button"
                    key={key}
                    className={`section-icon-option${sectionIcon === key ? " active" : ""}`}
                    onClick={() => setSectionIcon(key)}
                    title={key}
                    aria-pressed={sectionIcon === key}
                  >
                    <CategoryIcon icon={key} size={20} />
                  </button>
                ))}
              </div>
            </label>
            {error && <MessageBox tone="error" title="Unable to save section">{error}</MessageBox>}
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setSectionModalOpen(false)} disabled={sectionSaving}>
                Cancel
              </button>
              <button className="primary-button" disabled={sectionSaving || sectionName.trim().length < 2}>
                {sectionSaving ? "Saving..." : editingSection ? "Save section" : "Create section"}
              </button>
            </div>
          </form>
        </div>
      )}

      {deleteConfirmSection && (
        <div className="modal-backdrop" onMouseDown={() => !sectionSaving && setDeleteConfirmSection(null)}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-section-title" onMouseDown={(e) => e.stopPropagation()}>
            <h2 id="delete-section-title">Delete "{deleteConfirmSection.name}"?</h2>
            <p>The section is removed. Its {deleteConfirmSection.libraryCount} {deleteConfirmSection.libraryCount === 1 ? "library" : "libraries"} will be detached and reappear in the main grid — no books or files are deleted.</p>
            {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setDeleteConfirmSection(null)} disabled={sectionSaving} autoFocus>
                Cancel
              </button>
              <button className="danger-button" onClick={deleteSection} disabled={sectionSaving}>
                <Trash2 size={15} /> {sectionSaving ? "Deleting…" : "Yes, delete section"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
