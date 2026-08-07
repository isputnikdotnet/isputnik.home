import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpDown, BookOpen, FileQuestion, Folder, Headphones, Hourglass, Image as ImageIcon,
  LibraryBig, RotateCcw, Search, Settings2, SlidersHorizontal, Trash2
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, type PublicUser } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { LibraryMenu } from "../../../shared/LibraryMenu";
import { Modal } from "../../../shared/Modal";
import { Pager } from "../../../shared/Pager";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SelectMenu } from "../../../shared/SelectMenu";
import { formatBytes, formatManagedDate } from "../../../shared/utils";
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
  /** What removed it. A cleanup can put thousands of rows in here at once; without
   *  this they are indistinguishable from the handful someone deleted by hand. */
  source: string;
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

/** How long this item was given, in days — the gap between the day it was deleted and
 *  the day it goes. Read back from the item's own two dates, never from the current
 *  setting: the setting says what happens from now on, while every row here was
 *  stamped under whatever it was at the time. Null = kept until the bin is emptied. */
function retentionWindow(item: TrashedItem): number | null {
  if (!item.purgesAt) return null;
  const from = Date.parse(item.trashedAt);
  const to = Date.parse(item.purgesAt);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

const FOREVER = "forever";

const SOURCE_LABEL: Record<string, string> = {
  manual: "Deleted by hand",
  duplicate_cleanup: "Duplicate cleanup"
};

export function RecycleBinSection({ currentUser }: { currentUser: PublicUser }) {
  const [items, setItems] = useState<TrashedItem[]>([]);
  const [bins, setBins] = useState<TrashBin[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);
  // null = duplicate cleanup follows the bin's own setting.
  const [cleanupRetentionDays, setCleanupRetentionDays] = useState<number | null>(null);
  const [binInput, setBinInput] = useState("30");
  const [cleanupInput, setCleanupInput] = useState("");
  const [savingRetention, setSavingRetention] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  // The settings dialog keeps its own error, so a failed save is reported where the
  // fields are rather than behind the dialog on the page underneath.
  const [settingsError, setSettingsError] = useState("");
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
  const [search, setSearch] = useState("");
  const [scopeId, setScopeId] = useState(""); // "" = every library
  const [sourceFilter, setSourceFilter] = useState(""); // "" = however it was removed
  const [retentionFilter, setRetentionFilter] = useState(""); // "" = however long it's kept
  const [perPage, setPerPage] = useState("24");
  const [page, setPage] = useState(1);

  // Only libraries actually represented in the bin — an empty scope would be a
  // dead menu entry.
  const libraryOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of items) if (!seen.has(item.libraryId)) seen.set(item.libraryId, item.libraryName);
    // No counts on the labels. The line above the toolbar already says how many are
    // showing, and the tally was the widest part of every menu — enough to stop the
    // row fitting on one line, which costs more than it told anyone.
    return [
      { value: "", label: "All libraries" },
      ...[...seen].map(([id, name]) => ({ value: id, label: name }))
    ];
  }, [items]);

  // Only offered once the bin actually holds more than one kind — the whole point is
  // to dig a hand delete out from under a cleanup's thousands of rows, and with one
  // kind present that menu would filter nothing.
  const sourceOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
    if (counts.size < 2) return [];
    return [
      { value: "", label: `However removed (${items.length})` },
      ...[...counts].map(([source, count]) => ({
        value: source,
        label: `${SOURCE_LABEL[source] ?? source} (${count})`
      }))
    ];
  }, [items]);

  // The windows actually present, not a fixed 30/90/180: a bin holds whatever the
  // settings were when each row was stamped, so the menu is built from the rows.
  //
  // Shown even when every item shares one window, unlike the source menu above. That
  // menu only narrows, so with one kind it is furniture; this one also ANSWERS —
  // "everything in here is on the 180-day rule" is a thing you come to the bin to find
  // out, and hiding the control hides the answer with it.
  const retentionOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const window = retentionWindow(item);
      const key = window == null ? FOREVER : String(window);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (counts.size === 0) return [];
    // Shortest first, because that is the order they leave in; "until you empty it"
    // is not a length and sits at the end rather than pretending to be the longest.
    const numeric = [...counts.keys()]
      .filter((key) => key !== FOREVER)
      .sort((a, b) => Number(a) - Number(b));
    const ordered = counts.has(FOREVER) ? [...numeric, FOREVER] : numeric;
    return [
      { value: "", label: "However long" },
      ...ordered.map((key) => ({
        value: key,
        label: key === FOREVER ? "Until emptied" : `${key} day${key === "1" ? "" : "s"}`
      }))
    ];
  }, [items]);

  const visible = useMemo(() => {
    let list = items;
    if (scopeId) list = list.filter((item) => item.libraryId === scopeId);
    if (sourceFilter) list = list.filter((item) => item.source === sourceFilter);
    if (retentionFilter) {
      list = list.filter((item) => {
        const window = retentionWindow(item);
        return retentionFilter === FOREVER ? window == null : String(window) === retentionFilter;
      });
    }
    // Name, folder and library, because all three are how someone describes what they
    // are looking for — "that holiday one", "it was in Downloads", "something from
    // Gallery". Client-side: the bin is already loaded whole, so a round trip per
    // keystroke would be slower and no more correct.
    const needle = search.trim().toLowerCase();
    if (needle) {
      list = list.filter((item) =>
        item.title.toLowerCase().includes(needle)
        || item.path.toLowerCase().includes(needle)
        || item.libraryName.toLowerCase().includes(needle));
    }
    return sortItems(list, sort);
  }, [items, scopeId, sourceFilter, retentionFilter, search, sort]);
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
  useEffect(() => { setPage(1); }, [scopeId, sourceFilter, retentionFilter, search, sort, perPage]);

  const load = async () => {
    const payload = await api<{
      items: TrashedItem[];
      retentionDays: number;
      cleanupRetentionDays: number | null;
      bins?: TrashBin[];
    }>("/api/library/trash");
    setItems(payload.items);
    setBins(payload.bins ?? []);
    setRetentionDays(payload.retentionDays);
    setCleanupRetentionDays(payload.cleanupRetentionDays);
    setBinInput(String(payload.retentionDays));
    setCleanupInput(payload.cleanupRetentionDays == null ? "" : String(payload.cleanupRetentionDays));
  };

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load the Recycle Bin"))
      .finally(() => setLoaded(true));
  }, []);

  const isAdmin = currentUser.role === "admin";
  const retentionDirty =
    binInput.trim() !== String(retentionDays)
    || cleanupInput.trim() !== (cleanupRetentionDays == null ? "" : String(cleanupRetentionDays));

  /** Put the fields back to what is actually saved. Closing the dialog is not a way to
   *  half-change a setting, so an abandoned edit leaves nothing behind. */
  const closeSettings = () => {
    setBinInput(String(retentionDays));
    setCleanupInput(cleanupRetentionDays == null ? "" : String(cleanupRetentionDays));
    setSettingsError("");
    setSettingsOpen(false);
  };

  const saveRetention = async () => {
    const bin = Number.parseInt(binInput, 10);
    if (!Number.isFinite(bin) || bin < 0) {
      setSettingsError("Days must be a whole number, 0 or more.");
      return;
    }
    // Blank is a real answer here, not a missing one: it puts cleanup back on the
    // bin's clock rather than giving it a number of its own.
    const cleanupText = cleanupInput.trim();
    const cleanup = cleanupText === "" ? null : Number.parseInt(cleanupText, 10);
    if (cleanup !== null && (!Number.isFinite(cleanup) || cleanup < 0)) {
      setSettingsError("Days must be a whole number, 0 or more — or blank to follow the Recycle Bin.");
      return;
    }

    setSavingRetention(true);
    setSettingsError("");
    try {
      await api("/api/library/trash/retention", {
        method: "PUT",
        body: JSON.stringify({ retentionDays: bin, cleanupRetentionDays: cleanup })
      });
      await load();
      setSettingsOpen(false);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Unable to save the retention settings");
    } finally {
      setSavingRetention(false);
    }
  };

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

  // Each item carries the date it was given when it was deleted, so a single sentence
  // for the whole page can only describe what happens from here on — the tiles hold
  // the truth for what is already in the bin.
  const days = (value: number) => `${value} day${value === 1 ? "" : "s"}`;
  const binClause = retentionDays > 0
    ? `Deleted items keep their files here for ${days(retentionDays)}`
    : "Deleted items keep their files here until you remove them";
  const cleanupClause = cleanupRetentionDays == null || cleanupRetentionDays === retentionDays
    ? ""
    : cleanupRetentionDays > 0
      ? `, duplicate cleanup removals for ${days(cleanupRetentionDays)}`
      : ", and duplicate cleanup removals stay until you remove them";
  const retentionBlurb = `${binClause}${cleanupClause}. Every item shows its own date — changing these settings never moves a date already given.`;

  return (
    <>
      <ControlSectionHead
        section="recycleBin"
        className="control-head-compact"
        icon={<Trash2 size={30} />}
        description={retentionBlurb}
      >
        {/* Search rides in the header beside the title, as on Logs — it is what you
            reach for first, and it leaves the toolbar below to the controls that
            change the whole view. */}
        <label className="search-field trash-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">Search deleted items by name, folder or library</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search the bin..."
          />
        </label>
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
        /* Filter on the left, view controls and the actions on the right — the Logs
           toolbar. What NARROWS the list stays on the page, because you change it
           while reading; how the list is LAID OUT moves into the view dialog, because
           it is set once and then lived with. */
        <div className="trash-toolbar">
          <LibraryMenu
            value={scopeId}
            options={libraryOptions}
            icon={<LibraryBig size={19} aria-hidden="true" />}
            label="Which library's deleted items to show"
            onChange={setScopeId}
          />
          {sourceOptions.length > 0 && (
            <SelectMenu
              value={sourceFilter}
              options={sourceOptions}
              label="How the item was removed"
              onChange={setSourceFilter}
            />
          )}

          <div className="trash-toolbar-controls">
            <Button
              variant="icon"
              aria-label="View options"
              title="View options — per page, order and how long items are kept"
              onClick={() => setViewOpen(true)}
            >
              <SlidersHorizontal size={18} aria-hidden="true" />
            </Button>
            {/* Admin only: the clocks are an install-wide setting, where everything
                else in this row acts on what is in the bin today. */}
            {isAdmin && (
              <Button
                variant="icon"
                aria-label="Recycle Bin settings"
                title="Recycle Bin settings"
                onClick={() => { setSettingsError(""); setSettingsOpen(true); }}
              >
                <Settings2 size={18} aria-hidden="true" />
              </Button>
            )}
            {/* Restore before Empty: one puts things back, the other destroys them,
                and the reversible one should not be the harder to reach. */}
            {visible.length > 0 && (
              <Button
                variant="icon"
                disabled={restoringAll}
                aria-label="Restore all"
                title="Restore everything shown"
                onClick={() => { setActionError(""); setNotice(""); setRestoreAllOpen(true); }}
              >
                <RotateCcw size={18} aria-hidden="true" />
              </Button>
            )}
            <Button
              variant="icon"
              danger
              aria-label="Empty Recycle Bin"
              title="Empty Recycle Bin"
              onClick={() => { setActionError(""); setEmptyOpen(true); }}
            >
              <Trash2 size={18} aria-hidden="true" />
            </Button>
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
        </div>
      )}

      {loaded && items.length === 0 && !error && (
        <p className="management-empty">The Recycle Bin is empty.</p>
      )}

      {items.length > 0 && visible.length === 0 && (
        <p className="management-empty">
          {/* Search is named first when it is on: it is the narrowing you just typed,
              so it is the one you would undo first. */}
          {search.trim()
            ? `Nothing in the bin matches “${search.trim()}”.`
            : retentionFilter
              ? "Nothing in the bin is kept for that long."
              : sourceFilter && scopeId
                ? "Nothing removed that way from that library."
                : sourceFilter
                  ? "Nothing removed that way."
                  : "Nothing deleted from that library."}
        </p>
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
                  <span className="trash-tile-line">
                    <span>Removes {formatDay(item.purgesAt)}</span>
                    {/* Only the cleanup is worth naming: a hand delete is what the bin
                        is for, and badging every row with "Deleted by hand" would be
                        noise on the common case.

                        Says what the file WAS, not which tool ran — "cleanup" named a
                        page nobody is looking at from here, while "duplicate" answers
                        the question the row actually raises: why is this in the bin?
                        Not "duplicate photo": a gallery cleanup removes videos too, and
                        this same badge sits on them. */}
                    {item.source === "duplicate_cleanup" && (
                      <span className="count-badge" title="A duplicate copy, removed by a duplicate cleanup">
                        duplicate
                      </span>
                    )}
                  </span>
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

      {/* How the list is laid out, in one place. These three used to sit in the
          toolbar and, spelled out, took more width than the row had — and they are
          not read-while-you-work controls: you set them once and then get on with
          the bin. Each applies the moment it is chosen, so there is nothing to save
          and Done is only a way out. */}
      {viewOpen && (
        <Modal variant="card" title="View options" onClose={() => setViewOpen(false)}>
          <div className="trash-view-options">
            <label className="trash-view-row">
              <span>Items per page</span>
              <SelectMenu
                value={perPage}
                options={PER_PAGE_OPTIONS}
                label="Items per page"
                onChange={setPerPage}
              />
            </label>
            <label className="trash-view-row">
              <span>Order</span>
              <SelectMenu
                value={sort}
                options={SORT_OPTIONS}
                label="Sort deleted items"
                triggerIcon={<ArrowUpDown size={16} aria-hidden="true" />}
                onChange={(next) => setSort(next as TrashSort)}
              />
            </label>
            {retentionOptions.length > 0 && (
              <label className="trash-view-row">
                <span>Kept for</span>
                <SelectMenu
                  value={retentionFilter}
                  options={retentionOptions}
                  label="How long the item is kept for"
                  triggerIcon={<Hourglass size={16} aria-hidden="true" />}
                  onChange={setRetentionFilter}
                />
              </label>
            )}
          </div>

          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setViewOpen(false)}>Done</Button>
          </div>
        </Modal>
      )}

      {/* Two clocks, because one number can't serve both cases: a hand delete is a
          mistake you might notice a month later, while a cleanup puts thousands of
          files here at once and holding all of them for a month is a lot of disk.
          In a dialog rather than on the page — it is set once and then read off the
          header's sentence, so it does not need to occupy the view every visit. */}
      {settingsOpen && (
        <Modal
          variant="card"
          title="Recycle Bin settings"
          busy={savingRetention}
          onClose={closeSettings}
          onSubmit={(event) => { event.preventDefault(); void saveRetention(); }}
        >
          <div className="trash-retention">
            <label className="trash-retention-row" htmlFor="trash-retention">
              <span>Keep deleted items for</span>
              <input
                id="trash-retention"
                type="number"
                min={0}
                max={3650}
                value={binInput}
                disabled={savingRetention}
                onChange={(event) => setBinInput(event.target.value)}
              />
              <span className="datagrid-muted">days (0 = until you empty the bin)</span>
            </label>
            <label className="trash-retention-row" htmlFor="trash-retention-cleanup">
              <span>Duplicate cleanup removals for</span>
              <input
                id="trash-retention-cleanup"
                type="number"
                min={0}
                max={3650}
                placeholder="same"
                value={cleanupInput}
                disabled={savingRetention}
                onChange={(event) => setCleanupInput(event.target.value)}
              />
              <span className="datagrid-muted">days (blank = same as above)</span>
            </label>
          </div>

          {/* Said here as well as in the header: this is the moment somebody is about
              to change a number and might expect it to reach what is already in the bin. */}
          <p className="datagrid-muted trash-retention-note">
            Every item keeps the date it was given when it was deleted, so changing these
            never moves a date already set. They decide what happens from now on.
          </p>

          {settingsError && (
            <MessageBox tone="error" title="Unable to save">{settingsError}</MessageBox>
          )}

          <div className="modal-actions">
            <Button variant="secondary" disabled={savingRetention} onClick={closeSettings}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={savingRetention || !retentionDirty}>
              {savingRetention ? "Saving…" : "Save"}
            </Button>
          </div>
        </Modal>
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
