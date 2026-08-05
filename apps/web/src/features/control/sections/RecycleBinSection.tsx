import { useEffect, useMemo, useState } from "react";
import { BookOpen, FileQuestion, Folder, Headphones, Image as ImageIcon, LibraryBig, RotateCcw, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { LibraryMenu } from "../../../shared/LibraryMenu";
import { Pager } from "../../../shared/Pager";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SelectMenu } from "../../../shared/SelectMenu";
import { formatBytes, formatManagedDate } from "../../../shared/utils";
import { AudiobookHeaderSort } from "../../audiobooks/AudiobooksPage";
import type { SortKey } from "../../audiobooks/BookFilter";
import { ControlSectionHead } from "../ControlSectionHead";

interface TrashedItem {
  id: string;
  libraryId: string;
  libraryType: string;
  libraryName: string;
  title: string;
  path: string;
  fileCount: number;
  sizeBytes: number;
  coverUrl: string | null;
  trashedAt: string;
  trashedByName: string | null;
  purgesAt: string | null;
}

/** One library's Recycle Bin folder on disk. The server sends one per library that
 *  currently has something in the bin. */
interface TrashBin {
  libraryId: string;
  libraryName: string;
  path: string;
}

const TYPE_ICON: Record<string, LucideIcon> = {
  audiobook: Headphones,
  ebook: BookOpen,
  gallery: ImageIcon
};

// The cover the bin kept when the item was deleted, in the same 4:3 frame the
// duplicate-photos tiles use. Items binned before covers were preserved — and
// anything that never had one — fall back to the icon for their media type, which
// still says at a glance what the row is.
function TrashThumb({ item }: { item: TrashedItem }) {
  const Icon = TYPE_ICON[item.libraryType] ?? FileQuestion;
  return (
    <span className="trash-thumb" aria-hidden="true">
      {item.coverUrl
        ? <img src={item.coverUrl} alt="" loading="lazy" />
        : <Icon size={18} />}
    </span>
  );
}

function formatDay(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

// The folder the item came out of, relative to its library. Empty for something
// that sat at the library root, and for a one-segment path (which IS the item).
function folderOf(item: TrashedItem): string {
  const cut = item.path.lastIndexOf("/");
  return cut === -1 ? "" : item.path.slice(0, cut);
}

type TrashSort = "recent" | "oldest" | "largest" | "name" | "soonest";

const SORT_OPTIONS = [
  { value: "recent", label: "Recently deleted" },
  { value: "oldest", label: "Deleted longest ago" },
  { value: "largest", label: "Largest first" },
  { value: "name", label: "Name A–Z" },
  { value: "soonest", label: "Removed soonest" }
];

const PER_PAGE_OPTIONS = [
  { value: "12", label: "12 per page" },
  { value: "24", label: "24 per page" },
  { value: "48", label: "48 per page" },
  { value: "all", label: "Show all" }
];

function sortItems(items: TrashedItem[], sort: TrashSort): TrashedItem[] {
  const list = [...items];
  // The server already hands them back newest-first, so "recent" is as given.
  if (sort === "recent") return list;
  if (sort === "oldest") return list.reverse();
  if (sort === "largest") return list.sort((a, b) => b.sizeBytes - a.sizeBytes);
  if (sort === "name") return list.sort((a, b) => a.title.localeCompare(b.title));
  // Items with no purge date (auto-removal off) never come up, so they sort last.
  return list.sort((a, b) =>
    (a.purgesAt ? Date.parse(a.purgesAt) : Number.POSITIVE_INFINITY)
    - (b.purgesAt ? Date.parse(b.purgesAt) : Number.POSITIVE_INFINITY));
}

export function RecycleBinSection() {
  const [items, setItems] = useState<TrashedItem[]>([]);
  const [bins, setBins] = useState<TrashBin[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [restoringId, setRestoringId] = useState("");
  const [purgeTarget, setPurgeTarget] = useState<TrashedItem | null>(null);
  const [purging, setPurging] = useState(false);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [emptying, setEmptying] = useState(false);
  const [restoreAllOpen, setRestoreAllOpen] = useState(false);
  const [restoringAll, setRestoringAll] = useState(false);
  const [actionError, setActionError] = useState("");
  // A bulk restore can half-work — one item's library is gone, another's old place is
  // taken. That is not a failed action and must not be dressed as one, so the outcome
  // gets its own line rather than the error box.
  const [notice, setNotice] = useState("");
  // Newest deletion first — the order the server hands them back, and the one you
  // want when you've just deleted something by mistake.
  const [sort, setSort] = useState<TrashSort>("recent");
  const [scopeId, setScopeId] = useState(""); // "" = every library
  const [perPage, setPerPage] = useState("24");
  const [page, setPage] = useState(1);

  // Only libraries actually represented in the bin — an empty scope would be a
  // dead menu entry.
  const libraryOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of items) if (!seen.has(item.libraryId)) seen.set(item.libraryId, item.libraryName);
    return [
      { value: "", label: `All libraries (${items.length})` },
      ...[...seen].map(([id, name]) => ({
        value: id,
        label: `${name} (${items.filter((item) => item.libraryId === id).length})`
      }))
    ];
  }, [items]);

  const visible = useMemo(
    () => sortItems(scopeId ? items.filter((item) => item.libraryId === scopeId) : items, sort),
    [items, scopeId, sort]
  );
  const scopeName = scopeId ? items.find((item) => item.libraryId === scopeId)?.libraryName ?? "" : "";
  const shownBins = scopeId ? bins.filter((bin) => bin.libraryId === scopeId) : bins;

  const pageSize = perPage === "all" ? Math.max(visible.length, 1) : Number(perPage);
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  // Clamped rather than corrected in state, so a shrinking list (a restore, a
  // purge) can't strand the view on a page that no longer exists.
  const currentPage = Math.min(page, totalPages);
  const pageItems = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const firstShown = visible.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;

  // Any change to what's listed or how it's ordered goes back to the top.
  useEffect(() => { setPage(1); }, [scopeId, sort, perPage]);

  const load = async () => {
    const payload = await api<{ items: TrashedItem[]; retentionDays: number; bins?: TrashBin[] }>("/api/library/trash");
    setItems(payload.items);
    setBins(payload.bins ?? []);
    setRetentionDays(payload.retentionDays);
  };

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load the Recycle Bin"))
      .finally(() => setLoaded(true));
  }, []);

  const restore = async (item: TrashedItem) => {
    setRestoringId(item.id);
    setActionError("");
    try {
      await api(`/api/library/trash/${item.id}/restore`, { method: "POST" });
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to restore the item");
    } finally {
      setRestoringId("");
    }
  };

  const confirmPurge = async () => {
    if (!purgeTarget) return;
    setPurging(true);
    setActionError("");
    try {
      await api(`/api/library/trash/${purgeTarget.id}`, { method: "DELETE" });
      setPurgeTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to delete the item");
    } finally {
      setPurging(false);
    }
  };

  // Restores exactly what the page is showing — the library filter counts here, so
  // "restore all" can never mean more than what is in front of you.
  const confirmRestoreAll = async () => {
    setRestoringAll(true);
    setActionError("");
    setNotice("");
    try {
      const result = await api<{
        restored: number; forbidden: number; failed: number;
        failures: { title: string; error: string }[];
      }>("/api/library/trash/restore-all", {
        method: "POST",
        body: JSON.stringify(scopeId ? { libraryId: scopeId } : {})
      });
      setRestoreAllOpen(false);
      await load();

      const held: string[] = [];
      if (result.failed > 0) held.push(`${result.failed} couldn't go back`);
      if (result.forbidden > 0) held.push(`${result.forbidden} you don't have permission to restore`);
      if (held.length > 0) {
        const why = result.failures.map((entry) => `“${entry.title}” — ${entry.error}`).join(" ");
        setNotice(`Restored ${result.restored} item${result.restored === 1 ? "" : "s"}. ${held.join(", ")}, and stayed in the bin. ${why}`.trim());
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to restore the items");
    } finally {
      setRestoringAll(false);
    }
  };

  const confirmEmpty = async () => {
    setEmptying(true);
    setActionError("");
    try {
      await api("/api/library/trash/empty", { method: "POST", body: "{}" });
      setEmptyOpen(false);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to empty the Recycle Bin");
    } finally {
      setEmptying(false);
    }
  };

  // Totals for the two questions the bin answers: how much is in it, and how much
  // space getting rid of it would free.
  const visibleBytes = visible.reduce((sum, item) => sum + item.sizeBytes, 0);
  const visibleFiles = visible.reduce((sum, item) => sum + item.fileCount, 0);
  const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);

  const retentionBlurb = retentionDays > 0
    ? `Deleted items keep their files here for ${retentionDays} day${retentionDays === 1 ? "" : "s"}, then they're permanently removed. Restore anything before then.`
    : "Deleted items keep their files here until you remove them. Restore anything you need.";

  return (
    <>
      <ControlSectionHead
        section="recycleBin"
        className="control-head-compact"
        icon={<Trash2 size={30} />}
        description={retentionBlurb}
      >
        {/* Refresh sits last, at the right edge of the header — the same spot it
            holds on Scheduled jobs, so it's in one place across the panel. */}
        <div className="row-actions control-head-actions">
          {/* Restore before Empty, and secondary against its danger: one puts things
              back, the other destroys them, and the reversible one should not be the
              harder to reach of the two. */}
          {visible.length > 0 && (
            <Button
              variant="secondary"
              compact
              disabled={restoringAll}
              onClick={() => { setActionError(""); setNotice(""); setRestoreAllOpen(true); }}
            >
              <RotateCcw size={16} />
              <span>Restore all</span>
            </Button>
          )}
          {items.length > 0 && (
            <Button variant="danger" compact onClick={() => { setActionError(""); setEmptyOpen(true); }}>
              <Trash2 size={16} />
              <span>Empty Recycle Bin</span>
            </Button>
          )}
          <RefreshButton
            onRefresh={async () => {
              setError("");
              try {
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Unable to refresh the Recycle Bin");
                throw err;
              }
            }}
          />
        </div>
      </ControlSectionHead>

      {/* What's in the bin and what it's costing — the two numbers you come here for
          when the question is "can I get some space back?". Counts what the library
          picker is showing, so the line and the grid can't disagree; with a library
          chosen it also says what the whole bin holds. */}
      {items.length > 0 && (
        <p className="trash-status datagrid-muted">
          {visible.length} item{visible.length === 1 ? "" : "s"}
          {" · "}{formatBytes(visibleBytes)}
          {" · "}{visibleFiles} file{visibleFiles === 1 ? "" : "s"}
          {scopeId ? ` · ${items.length} in the whole bin, ${formatBytes(totalBytes)}` : ""}
        </p>
      )}

      {/* Where the files physically are. One folder per library rather than one for
          the install, because deleting moves a file inside its own library — a
          rename within a filesystem, never a copy across shares. Worth stating: the
          app is not always the thing you have to hand when the question is which
          disk is still holding the space. Follows the library picker, like the
          counts above it. */}
      {shownBins.length > 0 && (
        <p className="trash-bins datagrid-muted">
          {shownBins.length === 1 ? "Deleted files are kept in " : "Deleted files are kept in each library's own folder: "}
          {shownBins.map((bin, index) => (
            <span key={bin.libraryId}>
              {index > 0 && ", "}
              <code title={`The Recycle Bin folder for ${bin.libraryName}`}>{bin.path}</code>
              {shownBins.length > 1 && <> ({bin.libraryName})</>}
            </span>
          ))}
        </p>
      )}

      {error && <MessageBox tone="error" title="Unable to load the Recycle Bin">{error}</MessageBox>}
      {actionError && <MessageBox tone="error" title="Action failed">{actionError}</MessageBox>}
      {notice && <MessageBox tone="warning" title="Some items stayed in the bin">{notice}</MessageBox>}

      {items.length > 0 && (
        /* Scope on the left, view controls on the right — the Duplicate photos
           toolbar, which sits over a grid of the same kind of tiles. */
        <div className="trash-toolbar">
          <LibraryMenu
            value={scopeId}
            options={libraryOptions}
            icon={<LibraryBig size={19} aria-hidden="true" />}
            label="Which library's deleted items to show"
            onChange={setScopeId}
          />
          <div className="trash-toolbar-controls">
            <SelectMenu
              value={perPage}
              options={PER_PAGE_OPTIONS}
              label="Items per page"
              className="trash-per-page"
              onChange={setPerPage}
            />
            <AudiobookHeaderSort
              value={sort as unknown as SortKey}
              onChange={(next) => setSort(next as unknown as TrashSort)}
              options={SORT_OPTIONS as unknown as { value: SortKey; label: string }[]}
              ariaLabel="Sort deleted items"
              compact
            />
          </div>
        </div>
      )}

      {loaded && items.length === 0 && !error && (
        <p className="management-empty">The Recycle Bin is empty.</p>
      )}

      {items.length > 0 && visible.length === 0 && (
        <p className="management-empty">Nothing deleted from that library.</p>
      )}

      {pageItems.length > 0 && (
        <>
          <div className="trash-grid">
            {pageItems.map((item) => {
              const folder = folderOf(item);
              const busyItem = restoringId === item.id || purging || emptying;
              return (
                <article className="trash-tile" key={item.id}>
                  <TrashThumb item={item} />
                  <strong className="trash-tile-name" title={item.title}>{item.title}</strong>
                  {folder && (
                    <span className="trash-tile-line" title={item.path}>
                      <Folder size={12} aria-hidden="true" />
                      <span>{folder}</span>
                    </span>
                  )}
                  <span className="trash-tile-line">
                    <span>{item.libraryName}</span>
                    <span className="count-badge">{item.libraryType}</span>
                  </span>
                  <span className="trash-tile-line">
                    {formatBytes(item.sizeBytes)} · {item.fileCount} file{item.fileCount === 1 ? "" : "s"}
                  </span>
                  <span className="trash-tile-line">
                    Deleted {formatManagedDate(item.trashedAt)}{item.trashedByName ? ` · ${item.trashedByName}` : ""}
                  </span>
                  <span className="trash-tile-line">Removes {formatDay(item.purgesAt)}</span>
                  <div className="trash-tile-actions">
                    <Button
                      variant="icon"
                      disabled={busyItem}
                      onClick={() => restore(item)}
                      aria-label={`Restore ${item.title}`}
                      title={restoringId === item.id ? "Restoring…" : "Restore"}
                    >
                      {restoringId === item.id
                        ? <span className="icon-spin" aria-hidden="true"><RotateCcw size={16} /></span>
                        : <RotateCcw size={16} aria-hidden="true" />}
                    </Button>
                    <Button
                      variant="icon"
                      danger
                      disabled={busyItem}
                      onClick={() => { setActionError(""); setPurgeTarget(item); }}
                      aria-label={`Delete ${item.title} permanently`}
                      title="Delete permanently"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="trash-pager-row">
            <span className="datagrid-muted">
              Showing {firstShown}–{Math.min(currentPage * pageSize, visible.length)} of {visible.length} item{visible.length === 1 ? "" : "s"}
            </span>
            <Pager page={currentPage} totalPages={totalPages} onChange={setPage} label="Recycle Bin pages" />
          </div>
        </>
      )}

      {purgeTarget && (
        <ConfirmDialog
          title={`Permanently delete "${purgeTarget.title}"?`}
          confirmLabel="Delete permanently"
          busyLabel="Deleting…"
          danger
          busy={purging}
          error={actionError}
          onConfirm={confirmPurge}
          onCancel={() => setPurgeTarget(null)}
        >
          Its {purgeTarget.fileCount} file{purgeTarget.fileCount === 1 ? "" : "s"} will be erased from disk. This cannot be undone — restore it instead if you might want it back.
        </ConfirmDialog>
      )}

      {restoreAllOpen && (
        <ConfirmDialog
          title={scopeName
            ? `Restore all ${visible.length} item${visible.length === 1 ? "" : "s"} in “${scopeName}”?`
            : `Restore all ${visible.length} item${visible.length === 1 ? "" : "s"}?`}
          confirmLabel={`Restore ${visible.length} item${visible.length === 1 ? "" : "s"}`}
          busyLabel="Restoring…"
          busy={restoringAll}
          error={actionError}
          onConfirm={confirmRestoreAll}
          onCancel={() => setRestoreAllOpen(false)}
          rich
        >
          <p>
            {scopeName
              ? <>Everything the bin holds for <strong>{scopeName}</strong> goes back where it came from — its files return
                to their library folder and it appears in the library again. Deleted items in other libraries are left
                alone.</>
              : <>Everything in the bin goes back where it came from — files return to their library folders and the
                items appear in their libraries again.</>}
          </p>
          <p>
            Each is put back on its own, so one that can't be — its library has been removed, or something else now
            occupies the place it came from — doesn't stop the rest. Anything that can't go back stays in the bin and
            is named here afterwards. Nothing is deleted either way.
          </p>
        </ConfirmDialog>
      )}

      {emptyOpen && (
        <ConfirmDialog
          title="Empty the Recycle Bin?"
          confirmLabel="Empty Recycle Bin"
          busyLabel="Emptying…"
          danger
          busy={emptying}
          error={actionError}
          onConfirm={confirmEmpty}
          onCancel={() => setEmptyOpen(false)}
        >
          Every item in the bin will be permanently deleted, including all their files on disk. This cannot be undone.
        </ConfirmDialog>
      )}
    </>
  );
}
