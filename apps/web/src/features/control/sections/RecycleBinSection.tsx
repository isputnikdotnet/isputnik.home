import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  ArrowUpDown, BookOpen, FileQuestion, Folder, Headphones, Hourglass, Image as ImageIcon,
  LibraryBig, RotateCcw, Search, Settings2, SlidersHorizontal, Trash2
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import i18n from "../../../i18n";
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
import { DeletedStoriesPanel } from "./DeletedStoriesPanel";
import { TrashRootEditor, type TrashRootSettings } from "./TrashRootEditor";

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
  if (!iso) return i18n.t("controlAdmin:ui.never");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(i18n.language);
}

// The folder the item came out of, relative to its library. Empty for something
// that sat at the library root, and for a one-segment path (which IS the item).
function folderOf(item: TrashedItem): string {
  const cut = item.path.lastIndexOf("/");
  return cut === -1 ? "" : item.path.slice(0, cut);
}

type TrashSort = "recent" | "oldest" | "largest" | "name" | "soonest";

function sortOptions(t: typeof i18n.t) {
  return [
    { value: "recent", label: t("controlAdmin:recycleBin.sortRecent") },
    { value: "oldest", label: t("controlAdmin:recycleBin.sortOldest") },
    { value: "largest", label: t("controlAdmin:recycleBin.sortLargest") },
    { value: "name", label: t("controlAdmin:recycleBin.sortName") },
    { value: "soonest", label: t("controlAdmin:recycleBin.sortSoonest") }
  ];
}

function perPageOptions(t: typeof i18n.t) {
  return [
    { value: "12", label: t("pageSize.perPage", { count: 12 }) },
    { value: "24", label: t("pageSize.perPage", { count: 24 }) },
    { value: "48", label: t("pageSize.perPage", { count: 48 }) },
    { value: "all", label: t("controlAdmin:recycleBin.showAll") }
  ];
}

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

function sourceLabel(source: string): string {
  if (source === "manual") return i18n.t("controlAdmin:recycleBin.sourceManual");
  if (source === "duplicate_cleanup") return i18n.t("controlAdmin:recycleBin.sourceCleanup");
  return source;
}

export function RecycleBinSection({ currentUser }: { currentUser: PublicUser }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
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
  const [trashRoot, setTrashRoot] = useState<TrashRootSettings | null>(null);
  const [editLocationOpen, setEditLocationOpen] = useState(false);
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
      { value: "", label: t("controlAdmin:recycleBin.allLibraries") },
      ...[...seen].map(([id, name]) => ({ value: id, label: name }))
    ];
  }, [items, t]);

  // Only offered once the bin actually holds more than one kind — the whole point is
  // to dig a hand delete out from under a cleanup's thousands of rows, and with one
  // kind present that menu would filter nothing.
  const sourceOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
    if (counts.size < 2) return [];
    return [
      { value: "", label: t("controlAdmin:recycleBin.howeverRemoved", { count: items.length }) },
      ...[...counts].map(([source, count]) => ({
        value: source,
        label: `${sourceLabel(source)} (${count})`
      }))
    ];
  }, [items, t]);

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
      { value: "", label: t("controlAdmin:recycleBin.howeverLong") },
      ...ordered.map((key) => ({
        value: key,
        label: key === FOREVER ? t("controlAdmin:recycleBin.untilEmptied") : t("dateRange.day", { count: Number(key) })
      }))
    ];
  }, [items, t]);

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

    // The install-wide bin location, for the settings dialog and the empty-bin line.
    // Admin-only on the server, and only admins see the doors into it here — a member
    // getting a 403 on page load would dress the whole page in an error.
    if (currentUser.role === "admin") {
      setTrashRoot(await api<TrashRootSettings>("/api/storage/trash-root"));
    }
  };

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:recycleBin.loadFailed")))
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
      setSettingsError(t("controlAdmin:recycleBin.daysInvalid"));
      return;
    }
    // Blank is a real answer here, not a missing one: it puts cleanup back on the
    // bin's clock rather than giving it a number of its own.
    const cleanupText = cleanupInput.trim();
    const cleanup = cleanupText === "" ? null : Number.parseInt(cleanupText, 10);
    if (cleanup !== null && (!Number.isFinite(cleanup) || cleanup < 0)) {
      setSettingsError(t("controlAdmin:recycleBin.cleanupDaysInvalid"));
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
      setSettingsError(err instanceof Error ? err.message : t("controlAdmin:recycleBin.saveRetentionFailed"));
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
      setActionError(err instanceof Error ? err.message : t("controlAdmin:recycleBin.restoreFailed"));
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
      setActionError(err instanceof Error ? err.message : t("controlAdmin:recycleBin.deleteFailed"));
    } finally {
      setPurging(false);
    }
  };

  // Restores the library scope, which is the only filter the server knows about —
  // the search box and the source/retention filters narrow the tiles, not the action.
  // The dialog counts `inScope` for that reason, so what it promises is what happens.
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
      if (result.failed > 0) held.push(t("controlAdmin:recycleBin.couldntGoBack", { count: result.failed }));
      if (result.forbidden > 0) held.push(t("controlAdmin:recycleBin.noPermission", { count: result.forbidden }));
      if (held.length > 0) {
        const why = result.failures.map((entry) => t("controlAdmin:recycleBin.failureLine", { title: entry.title, error: entry.error })).join(" ");
        setNotice(`${t("controlAdmin:recycleBin.restoredCount", { count: result.restored })}. ${held.join(", ")}${t("controlAdmin:recycleBin.stayedSuffix")} ${why}`.trim());
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("controlAdmin:recycleBin.restoreAllFailed"));
    } finally {
      setRestoringAll(false);
    }
  };

  const confirmEmpty = async () => {
    setEmptying(true);
    setActionError("");
    try {
      // Scoped to the chosen library, exactly like Restore all beside it. Sending {}
      // here emptied the WHOLE bin however the page was filtered — press Empty while
      // looking at one library and every other library's deleted files went too.
      await api("/api/library/trash/empty", {
        method: "POST",
        body: JSON.stringify(scopeId ? { libraryId: scopeId } : {})
      });
      setEmptyOpen(false);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("controlAdmin:recycleBin.emptyFailed"));
    } finally {
      setEmptying(false);
    }
  };

  // Totals for the two questions the bin answers: how much is in it, and how much
  // space getting rid of it would free.
  const visibleBytes = visible.reduce((sum, item) => sum + item.sizeBytes, 0);
  const visibleFiles = visible.reduce((sum, item) => sum + item.fileCount, 0);
  const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);

  // What Empty and Restore all actually reach. NOT `visible`: the server works on the
  // library scope, ignoring the search box and the source/retention filters, so a
  // dialog counting the rows on screen would promise less than it takes. The library
  // picker is the only filter that reaches the server.
  const inScope = useMemo(
    () => (scopeId ? items.filter((item) => item.libraryId === scopeId) : items),
    [items, scopeId]
  );
  const scopeBytes = inScope.reduce((sum, item) => sum + item.sizeBytes, 0);
  const scopeFiles = inScope.reduce((sum, item) => sum + item.fileCount, 0);
  // Items still owed time. These are the ones an accidental Empty really costs you:
  // the rest were going anyway, on a date the tile already shows.
  const scopeUnexpired = inScope.filter(
    (item) => item.purgesAt === null || Date.parse(item.purgesAt) > Date.now()
  ).length;
  // Typing is asked for only when emptying the whole bin — the one action here that
  // reaches past what the page is showing and cannot be undone. A scoped empty is
  // bounded by a library you deliberately picked, and gets the plain confirm.
  const emptyNeedsChallenge = !scopeId && inScope.length > 0;

  // Each item carries the date it was given when it was deleted, so a single sentence
  // for the whole page can only describe what happens from here on — the tiles hold
  // the truth for what is already in the bin.
  const binClause = retentionDays > 0
    ? t("controlAdmin:recycleBin.blurbKeepDays", { count: retentionDays })
    : t("controlAdmin:recycleBin.blurbKeepForever");
  const cleanupClause = cleanupRetentionDays == null || cleanupRetentionDays === retentionDays
    ? ""
    : cleanupRetentionDays > 0
      ? t("controlAdmin:recycleBin.blurbCleanupDays", { count: cleanupRetentionDays })
      : t("controlAdmin:recycleBin.blurbCleanupForever");
  const retentionBlurb = `${binClause}${cleanupClause}. ${t("controlAdmin:recycleBin.blurbSuffix")}`;

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
        <div className="row-actions control-head-actions">
          <label className="search-field trash-search">
            <Search size={17} aria-hidden="true" />
            <span className="sr-only">{t("controlAdmin:recycleBin.searchLabel")}</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("controlAdmin:recycleBin.searchPlaceholder")}
            />
          </label>
          {/* Settings live up here rather than in the toolbar below, which only
              renders when the bin has something in it. The clocks are an install-wide
              setting and the emptiest bin is exactly when you might want to change
              them — an admin who has just tidied up should not have to delete
              something to reach the retention days. */}
          {isAdmin && (
            <Button
              variant="icon"
              aria-label={t("controlAdmin:recycleBin.settingsAria")}
              title={t("controlAdmin:recycleBin.settingsAria")}
              onClick={() => { setSettingsError(""); setSettingsOpen(true); }}
            >
              <Settings2 size={18} aria-hidden="true" />
            </Button>
          )}
        </div>
      </ControlSectionHead>

      {/* What's in the bin and what it's costing — the two numbers you come here for
          when the question is "can I get some space back?". Counts what the library
          picker is showing, so the line and the grid can't disagree; with a library
          chosen it also says what the whole bin holds. */}
      {items.length > 0 && (
        <p className="trash-status datagrid-muted">
          {t("controlAdmin:recycleBin.itemsCount", { count: visible.length })}
          {" · "}{formatBytes(visibleBytes)}
          {" · "}{t("controlAdmin:recycleBin.filesCount", { count: visibleFiles })}
          {scopeId ? ` · ${t("controlAdmin:recycleBin.wholeBin", { count: items.length, size: formatBytes(totalBytes) })}` : ""}
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
          {shownBins.length === 1 ? t("controlAdmin:recycleBin.binsKeptSingle") : t("controlAdmin:recycleBin.binsKeptMulti")}
          {shownBins.map((bin, index) => (
            <span key={bin.libraryId}>
              {index > 0 && ", "}
              <code title={t("controlAdmin:recycleBin.binFolderTitle", { name: bin.libraryName })}>{bin.path}</code>
              {shownBins.length > 1 && <> ({bin.libraryName})</>}
            </span>
          ))}
        </p>
      )}

      {/* The per-library line above only exists while something is IN the bin, which
          left an empty bin saying nothing about where deletions go — and empty is the
          only time the location can be changed. Admins get the answer and the door. */}
      {isAdmin && trashRoot && items.length === 0 && loaded && !error && (
        <p className="trash-bins datagrid-muted">
          {trashRoot.path ? (
            <Trans
              i18nKey="recycleBin.emptyLocationPath"
              ns="controlAdmin"
              values={{ path: trashRoot.path }}
              components={{ cd: <code title={t("controlAdmin:recycleBin.installWideBinTitle")} />, btn: <Button variant="text" onClick={() => { setSettingsError(""); setSettingsOpen(true); }} /> }}
            />
          ) : (
            <Trans
              i18nKey="recycleBin.emptyLocationDefault"
              ns="controlAdmin"
              components={{ cd: <code />, btn: <Button variant="text" onClick={() => { setSettingsError(""); setSettingsOpen(true); }} /> }}
            />
          )}
        </p>
      )}


      {error && <MessageBox tone="error" title={t("controlAdmin:recycleBin.loadFailed")}>{error}</MessageBox>}
      {actionError && <MessageBox tone="error" title={t("errors.actionFailed")}>{actionError}</MessageBox>}
      {notice && <MessageBox tone="warning" title={t("controlAdmin:recycleBin.noticeTitle")}>{notice}</MessageBox>}

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
            label={t("controlAdmin:recycleBin.libraryFilterLabel")}
            onChange={setScopeId}
          />
          {sourceOptions.length > 0 && (
            <SelectMenu
              value={sourceFilter}
              options={sourceOptions}
              label={t("controlAdmin:recycleBin.sourceFilterLabel")}
              onChange={setSourceFilter}
            />
          )}

          <div className="trash-toolbar-controls">
            <Button
              variant="icon"
              aria-label={t("controlAdmin:recycleBin.viewOptionsAria")}
              title={t("controlAdmin:recycleBin.viewOptionsTitle")}
              onClick={() => setViewOpen(true)}
            >
              <SlidersHorizontal size={18} aria-hidden="true" />
            </Button>
            {/* Restore before Empty: one puts things back, the other destroys them,
                and the reversible one should not be the harder to reach. */}
            {visible.length > 0 && (
              <Button
                variant="icon"
                disabled={restoringAll}
                aria-label={t("controlAdmin:recycleBin.restoreAllAria")}
                title={t("controlAdmin:recycleBin.restoreAllTitle")}
                onClick={() => { setActionError(""); setNotice(""); setRestoreAllOpen(true); }}
              >
                <RotateCcw size={18} aria-hidden="true" />
              </Button>
            )}
            {/* Off when the scope holds nothing: a destructive button that does
                nothing is still a destructive button someone learns to press. */}
            <Button
              variant="icon"
              danger
              disabled={inScope.length === 0}
              aria-label={scopeName ? t("controlAdmin:recycleBin.emptyAriaScoped", { name: scopeName }) : t("controlAdmin:recycleBin.emptyAria")}
              title={scopeName
                ? t("controlAdmin:recycleBin.emptyTitleScoped", { name: scopeName })
                : t("controlAdmin:recycleBin.emptyTitleAll")}
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
                  setError(err instanceof Error ? err.message : t("controlAdmin:recycleBin.refreshFailed"));
                  throw err;
                }
              }}
            />
          </div>
        </div>
      )}

      {loaded && items.length === 0 && !error && (
        <p className="management-empty">{t("controlAdmin:recycleBin.emptyBin")}</p>
      )}

      {items.length > 0 && visible.length === 0 && (
        <p className="management-empty">
          {/* Search is named first when it is on: it is the narrowing you just typed,
              so it is the one you would undo first. */}
          {search.trim()
            ? t("controlAdmin:recycleBin.noMatchSearch", { query: search.trim() })
            : retentionFilter
              ? t("controlAdmin:recycleBin.noMatchRetention")
              : sourceFilter && scopeId
                ? t("controlAdmin:recycleBin.noMatchSourceLibrary")
                : sourceFilter
                  ? t("controlAdmin:recycleBin.noMatchSource")
                  : t("controlAdmin:recycleBin.noMatchLibrary")}
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
                    {formatBytes(item.sizeBytes)} · {t("controlAdmin:recycleBin.filesCount", { count: item.fileCount })}
                  </span>
                  <span className="trash-tile-line">
                    {t("controlAdmin:recycleBin.deletedWhen", { date: formatManagedDate(item.trashedAt) })}{item.trashedByName ? ` · ${item.trashedByName}` : ""}
                  </span>
                  <span className="trash-tile-line">
                    <span>{t("controlAdmin:recycleBin.removesWhen", { date: formatDay(item.purgesAt) })}</span>
                    {/* Only the cleanup is worth naming: a hand delete is what the bin
                        is for, and badging every row with "Deleted by hand" would be
                        noise on the common case.

                        Says what the file WAS, not which tool ran — "cleanup" named a
                        page nobody is looking at from here, while "duplicate" answers
                        the question the row actually raises: why is this in the bin?
                        Not "duplicate photo": a gallery cleanup removes videos too, and
                        this same badge sits on them. */}
                    {item.source === "duplicate_cleanup" && (
                      <span className="count-badge" title={t("controlAdmin:recycleBin.duplicateBadgeTitle")}>
                        {t("controlAdmin:recycleBin.duplicateBadge")}
                      </span>
                    )}
                  </span>
                  <div className="trash-tile-actions">
                    <Button
                      variant="icon"
                      disabled={busyItem}
                      onClick={() => restore(item)}
                      aria-label={t("controlAdmin:recycleBin.restoreAria", { title: item.title })}
                      title={restoringId === item.id ? t("controlAdmin:recycleBin.restoring") : t("controlAdmin:recycleBin.restore")}
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
                      aria-label={t("controlAdmin:recycleBin.deleteAria", { title: item.title })}
                      title={t("controlAdmin:recycleBin.deletePermanentlyTitle")}
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
              {t("controlAdmin:recycleBin.showingRange", { from: firstShown, to: Math.min(currentPage * pageSize, visible.length), count: visible.length })}
            </span>
            <Pager page={currentPage} totalPages={totalPages} onChange={setPage} label={t("controlAdmin:recycleBin.pagerLabel")} />
          </div>
        </>
      )}

      {/* Deleted stories share the bin (and its retention clock) but are rows,
          not files, so they sit in their own compact block. Admin-only, like
          the /api/stories/trash routes behind it. */}
      {isAdmin && <DeletedStoriesPanel />}

      {/* How the list is laid out, in one place. These three used to sit in the
          toolbar and, spelled out, took more width than the row had — and they are
          not read-while-you-work controls: you set them once and then get on with
          the bin. Each applies the moment it is chosen, so there is nothing to save
          and Done is only a way out. */}
      {viewOpen && (
        <Modal variant="card" title={t("controlAdmin:recycleBin.viewTitle")} onClose={() => setViewOpen(false)}>
          <div className="trash-view-options">
            <label className="trash-view-row">
              <span>{t("controlAdmin:recycleBin.itemsPerPage")}</span>
              <SelectMenu
                value={perPage}
                options={perPageOptions(t)}
                label={t("controlAdmin:recycleBin.itemsPerPage")}
                onChange={setPerPage}
              />
            </label>
            <label className="trash-view-row">
              <span>{t("controlAdmin:recycleBin.order")}</span>
              <SelectMenu
                value={sort}
                options={sortOptions(t)}
                label={t("controlAdmin:recycleBin.sortLabel")}
                triggerIcon={<ArrowUpDown size={16} aria-hidden="true" />}
                onChange={(next) => setSort(next as TrashSort)}
              />
            </label>
            {retentionOptions.length > 0 && (
              <label className="trash-view-row">
                <span>{t("controlAdmin:recycleBin.keptFor")}</span>
                <SelectMenu
                  value={retentionFilter}
                  options={retentionOptions}
                  label={t("controlAdmin:recycleBin.keptForLabel")}
                  triggerIcon={<Hourglass size={16} aria-hidden="true" />}
                  onChange={setRetentionFilter}
                />
              </label>
            )}
          </div>

          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setViewOpen(false)}>{t("common.done")}</Button>
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
          title={t("controlAdmin:recycleBin.settingsTitle")}
          busy={savingRetention}
          onClose={closeSettings}
          onSubmit={(event) => { event.preventDefault(); void saveRetention(); }}
        >
          <div className="trash-retention">
            <label className="trash-retention-row" htmlFor="trash-retention">
              <span>{t("controlAdmin:recycleBin.keepDeletedFor")}</span>
              <input
                id="trash-retention"
                type="number"
                min={0}
                max={3650}
                value={binInput}
                disabled={savingRetention}
                onChange={(event) => setBinInput(event.target.value)}
              />
              <span className="datagrid-muted">{t("controlAdmin:recycleBin.daysUntilEmpty")}</span>
            </label>
            <label className="trash-retention-row" htmlFor="trash-retention-cleanup">
              <span>{t("controlAdmin:recycleBin.cleanupFor")}</span>
              <input
                id="trash-retention-cleanup"
                type="number"
                min={0}
                max={3650}
                placeholder={t("controlAdmin:recycleBin.samePlaceholder")}
                value={cleanupInput}
                disabled={savingRetention}
                onChange={(event) => setCleanupInput(event.target.value)}
              />
              <span className="datagrid-muted">{t("controlAdmin:recycleBin.daysBlankSame")}</span>
            </label>
          </div>

          {/* Said here as well as in the header: this is the moment somebody is about
              to change a number and might expect it to reach what is already in the bin. */}
          <p className="datagrid-muted trash-retention-note">
            {t("controlAdmin:recycleBin.retentionNote")}
          </p>

          {/* The location was reachable only from Library → Storage, which nobody
              standing in the bin thinks to visit. Shown and changed from here too —
              same editor, same rules — while the Storage page keeps its copy for the
              set-it-up-first flow. */}
          {trashRoot && (
            <div className="trash-location-row">
              <span>{t("controlAdmin:recycleBin.locationGoesTo")}</span>
              <code>{trashRoot.path || t("controlAdmin:recycleBin.defaultTrash")}</code>
              <Button
                variant="secondary"
                compact
                disabled={!trashRoot.editable}
                title={trashRoot.editable
                  ? undefined
                  : t("controlAdmin:recycleBin.locationLockedTitle")}
                onClick={() => { closeSettings(); setEditLocationOpen(true); }}
              >
                {t("controlAdmin:recycleBin.changeLocation")}
              </Button>
            </div>
          )}

          {settingsError && (
            <MessageBox tone="error" title={t("errors.unableToSave")}>{settingsError}</MessageBox>
          )}

          <div className="modal-actions">
            <Button variant="secondary" disabled={savingRetention} onClick={closeSettings}>{t("common.cancel")}</Button>
            <Button variant="primary" type="submit" disabled={savingRetention || !retentionDirty}>
              {savingRetention ? t("controlAdmin:ui.saving") : t("controlAdmin:ui.save")}
            </Button>
          </div>
        </Modal>
      )}

      {editLocationOpen && (
        <TrashRootEditor
          current={trashRoot?.path ?? null}
          onSaved={load}
          onClose={() => setEditLocationOpen(false)}
        />
      )}

      {purgeTarget && (
        <ConfirmDialog
          title={t("controlAdmin:recycleBin.purgeTitle", { title: purgeTarget.title })}
          confirmLabel={t("controlAdmin:recycleBin.deletePermanently")}
          busyLabel={t("controlAdmin:recycleBin.deleting")}
          danger
          busy={purging}
          error={actionError}
          onConfirm={confirmPurge}
          onCancel={() => setPurgeTarget(null)}
        >
          {t("controlAdmin:recycleBin.purgeBody", { count: purgeTarget.fileCount })}
        </ConfirmDialog>
      )}

      {restoreAllOpen && (
        <ConfirmDialog
          title={scopeName
            ? t("controlAdmin:recycleBin.restoreAllTitleScoped", { count: inScope.length, name: scopeName })
            : t("controlAdmin:recycleBin.restoreAllTitleAll", { count: inScope.length })}
          confirmLabel={t("controlAdmin:recycleBin.restoreAllConfirm", { count: inScope.length })}
          busyLabel={t("controlAdmin:recycleBin.restoring")}
          busy={restoringAll}
          error={actionError}
          onConfirm={confirmRestoreAll}
          onCancel={() => setRestoreAllOpen(false)}
          rich
        >
          <p>
            {scopeName
              ? <Trans i18nKey="recycleBin.restoreAllBodyScoped" ns="controlAdmin" values={{ name: scopeName }} components={{ bold: <strong /> }} />
              : t("controlAdmin:recycleBin.restoreAllBodyAll")}
          </p>
          <p>
            {t("controlAdmin:recycleBin.restoreAllBodyShared")}
          </p>
        </ConfirmDialog>
      )}

      {emptyOpen && (
        <ConfirmDialog
          title={scopeName
            ? t("controlAdmin:recycleBin.emptyDialogTitleScoped", { name: scopeName })
            : t("controlAdmin:recycleBin.emptyDialogTitleAll")}
          confirmLabel={scopeName ? t("controlAdmin:recycleBin.emptyConfirmScoped") : t("controlAdmin:recycleBin.emptyConfirmAll")}
          busyLabel={t("controlAdmin:recycleBin.emptying")}
          danger
          rich
          busy={emptying}
          error={actionError}
          // A count you can only supply by having read the line above it. Deliberately
          // absent from the scoped case: friction everywhere is friction nowhere.
          challenge={emptyNeedsChallenge
            ? { value: String(inScope.length), label: <Trans i18nKey="recycleBin.challengeLabel" ns="controlAdmin" values={{ count: inScope.length }} components={{ bold: <strong /> }} /> }
            : undefined}
          onConfirm={confirmEmpty}
          onCancel={() => setEmptyOpen(false)}
        >
          <p>
            <Trans
              i18nKey="recycleBin.emptyDialogStats"
              ns="controlAdmin"
              values={{ items: t("controlAdmin:recycleBin.itemsCount", { count: inScope.length }), size: formatBytes(scopeBytes), files: t("controlAdmin:recycleBin.filesCount", { count: scopeFiles }) }}
              components={{ bold: <strong /> }}
            />
          </p>
          {scopeUnexpired > 0 && (
            <p>
              {scopeUnexpired === inScope.length
                ? t("controlAdmin:recycleBin.unexpiredAll")
                : <Trans i18nKey="recycleBin.unexpiredSome" ns="controlAdmin" count={scopeUnexpired} components={{ bold: <strong /> }} />}
            </p>
          )}
          <p>
            {scopeName
              ? <Trans i18nKey="recycleBin.emptyScopeOnly" ns="controlAdmin" values={{ name: scopeName }} components={{ bold: <strong /> }} />
              : t("controlAdmin:recycleBin.emptyReachesAll")}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
