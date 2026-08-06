// Duplicate cleanup — the same detection as the two older pages, held as a JOB you
// own rather than a list you happen to be looking at.
//
// The older pages are a live view of the last scan: open them, act, leave. That
// suits a quick pass and not an afternoon's work across thousands of photos, because
// nothing remembers where you got to and every rebuild renumbers everything.
//
// So this page is built around one saved job at a time:
//
//   * A wizard settles what to compare — which libraries, folders or files, photos
//     or videos — and then locks it, because everything below was worked out under
//     those answers.
//   * The scan writes a snapshot the job owns. You can close the browser and come
//     back next week to the same list, in the same order, with the same decisions
//     already made.
//   * Anything acted on is re-checked against the library first. A photo deleted
//     elsewhere, a file re-saved, a library turned read-only — each stops the offer
//     rather than being deleted around.
//
// The card for a folder already stored elsewhere names EVERY folder its copies sit
// in. The older page could not: its row held one covering folder, so scattered
// copies came out as the library root and the card read "everything in this
// library". That is a data shape, not a wording, and it is fixed in the snapshot.
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft, ArrowRight, Briefcase, Check, CircleCheck, Cloud, File, FolderOpen, HardDrive,
  Image as ImageIcon, Images, Lock, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Smartphone,
  Trash2, TriangleAlert, UserRound, Video
} from "lucide-react";
import { api, type PublicUser } from "../../../api";
import { formatBytes } from "../../../shared/utils";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ChoiceGroup, type Choice } from "../../../shared/ChoiceGroup";
import { Modal } from "../../../shared/Modal";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Pager } from "../../../shared/Pager";
import { SelectMenu } from "../../../shared/SelectMenu";
import { ToggleSwitch } from "../../../shared/ToggleSwitch";
import { ControlSectionHead } from "../ControlSectionHead";
import { controlHref } from "../../../router";
import { ExperimentalNotice, FolderStrip, formatWhen } from "./duplicate-shared";

// ── What the server says ────────────────────────────────────────────────────

type JobStatus =
  | "draft" | "scanning" | "review" | "processing" | "paused"
  | "completed" | "failed" | "cancelled";

type ResultType = "photo_set" | "folder_set" | "contained" | "overlap";
type MemberRole = "keep" | "delete" | "protected";

interface JobLibrary {
  libraryId: string;
  name: string;
  included: boolean;
  mode: "managed" | "external";
  isProtected: boolean;
  currentMode: "managed" | "external";
  currentlyProtected: boolean;
  missing: boolean;
}

interface JobTotals {
  results: number;
  reviewed: number;
  skipped: number;
  deleted: number;
  remaining: number;
  errors: number;
  reclaimableBytes: number;
  reclaimedBytes: number;
}

interface DuplicateJob {
  id: string;
  ownerUserId: string;
  ownerName: string;
  status: JobStatus;
  /** Folders OR files — a cleanup is one kind of work or the other, never both. */
  duplicateType: "folders" | "files";
  mediaType: "photo" | "video" | "both";
  currentStep: number;
  statusDetail: string | null;
  createdAt: string;
  lastActivityAt: string;
  scanCompletedAt: string | null;
  libraries: JobLibrary[];
  folderPreferences: { libraryId: string; folderPath: string; mode: "keep" | "clear" }[];
  totals: JobTotals;
}

interface LibraryOption {
  id: string;
  name: string;
  sourcePath: string;
  mode: "managed" | "external";
  isProtected: boolean;
}

interface JobsPayload {
  activeJob: DuplicateJob | null;
  isOwner: boolean;
  libraries: LibraryOption[];
  history: DuplicateJob[];
}

interface SnapshotFolder {
  libraryId: string;
  libraryName: string;
  folderPath: string;
  role: MemberRole;
  itemCount: number;
  bytes: number;
  addedAt?: string | null;
}

interface SnapshotMember {
  id: string;
  itemId: string | null;
  libraryId: string;
  libraryName: string;
  path: string;
  size: number | null;
  role: MemberRole;
  status: string;
  keeperPath: string | null;
}

interface SnapshotResult {
  id: string;
  type: ResultType;
  status: string;
  reviewStatus: "unreviewed" | "reviewed" | "skipped";
  reclaimableBytes: number;
  keeperReason: string | null;
  coverUrls?: string[];
  folders: SnapshotFolder[];
  members: SnapshotMember[];
}

interface ResultsPage {
  results: SnapshotResult[];
  total: number;
  allResults: number;
  page: number;
  perPage: number;
  isOwner: boolean;
}

const EMPTY_PAYLOAD: JobsPayload = { activeJob: null, isOwner: false, libraries: [], history: [] };
const EMPTY_RESULTS: ResultsPage = { results: [], total: 0, allResults: 0, page: 1, perPage: 25, isOwner: false };

// ── Words for states ────────────────────────────────────────────────────────

const STATUS_WORDS: Record<JobStatus, string> = {
  draft: "Not started",
  scanning: "Scanning",
  review: "Ready to review",
  processing: "Deleting",
  paused: "Paused",
  completed: "Finished",
  failed: "Stopped by an error",
  cancelled: "Cancelled"
};

const TYPE_HEADINGS: Record<ResultType, { title: string; note: string }> = {
  folder_set: {
    title: "Identical folders",
    note: "The same pictures, file for file, whatever the folders are called. One is kept; the others can go whole."
  },
  contained: {
    title: "Folders already stored elsewhere",
    note: "Every photo in these folders also sits somewhere else, so the folder itself can go and nothing is lost."
  },
  overlap: {
    title: "Folders sharing some photos",
    note: "Two folders holding SOME identical photos. Only the shared copies on one side are offered."
  },
  photo_set: {
    title: "Duplicate photos",
    note: "Byte-identical copies of one picture. One is kept and the rest can go."
  }
};

// What a cleanup of this kind can actually contain. A folder cleanup never holds a
// single-photo set and vice versa, so offering the other kind is a filter that can
// only ever empty the page.
const typeFilters = (kind: "folders" | "files"): { value: string; label: string }[] =>
  kind === "folders"
    ? [
      { value: "", label: "Everything" },
      { value: "folder_set", label: "Identical folders" },
      { value: "contained", label: "Stored elsewhere" }
    ]
    : [
      { value: "", label: "Everything" },
      { value: "photo_set", label: "Single files" }
    ];

const REVIEW_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "Any state" },
  { value: "unreviewed", label: "Not looked at" },
  { value: "reviewed", label: "Looked at" },
  { value: "skipped", label: "Skipped" }
];

/** The folders a result's copies survive in — the union the snapshot records, which
 *  is the sentence the older card could not say. */
const keeperFolders = (result: SnapshotResult): SnapshotFolder[] =>
  result.folders.filter((folder) => folder.role !== "delete");

const doomedFolder = (result: SnapshotResult): SnapshotFolder | undefined =>
  result.folders.find((folder) => folder.role === "delete");

/** A folder as a person reads it. An empty path means the file sits directly in the
 *  library's own folder, in no subfolder at all, and "." is what that place is
 *  called — the same label the older duplicate pages use (ROOT_LABEL in
 *  duplicate-shared), so one place has one name across the whole app.
 *
 *  Tried and rejected: "Everything in this library" (reads as a claim about the
 *  library, not a location), "the top level" (reads as a folder somebody named),
 *  and the source directory's real name (accurate, but a third word for a place
 *  the card already identifies by library). */
const folderLabel = (folder: Pick<SnapshotFolder, "folderPath">): string =>
  folder.folderPath || ".";

// The folder's path inside its library, written the way a shell writes a path: a
// leading slash meaning "the top of this library", not of the filesystem. The tile
// names the library on its own line, so repeating it here was both redundant and
// untrue — "/Test/FolderTwo" reads as a path, but "Test" is the library's NAME and
// the directory on disk is whatever its source is set to, so that path points at
// nothing.
const folderLocation = (folder: SnapshotFolder): string =>
  folder.folderPath ? `/${folder.folderPath}` : "/root";

const photoCountLabel = (count: number): string =>
  `${count} photo${count === 1 ? "" : "s"}`;

function CleanupFolderTile({
  folder, keep, position, badge, note, action
}: {
  folder: SnapshotFolder;
  keep: boolean;
  position: number;
  badge: string;
  note?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="dup-set-folder-wrap">
      {position > 0 && <ArrowRight className="dup-set-arrow" size={18} aria-hidden="true" />}
      <div className={`dup-set-folder${keep ? " is-keep" : " is-trash"}`}>
        <div className="dup-set-folder-top">
          <span className="dup-copy-badge dup-set-badge" aria-hidden="true">{badge}</span>
        </div>
        <span className="dup-set-name-row">
          <FolderOpen size={17} aria-hidden="true" />
          <strong className="dup-set-folder-name">{folderLabel(folder)}</strong>
        </span>
        <span className="dup-set-path" title={folderLocation(folder)}>
          <span>{folderLocation(folder)}</span>
        </span>
        {folder.addedAt && <span className="dup-set-line">{formatWhen(folder.addedAt)}</span>}
        <span className="dup-set-line">{formatBytes(folder.bytes)}</span>
        {note && <span className="dup-set-line dup-set-note">{note}</span>}
        {action && <>{action}</>}
      </div>
    </div>
  );
}

function KeepTileAction({ protectedFolder = false }: { protectedFolder?: boolean }) {
  return (
    <Button
      variant="secondary"
      compact
      className="dup-set-action dup-set-keep-action"
      disabled
    >
      {protectedFolder ? "Protected" : "Keep this"}
    </Button>
  );
}

// ── The page ────────────────────────────────────────────────────────────────

export function DuplicateCleanupSection({ currentUser }: { currentUser: PublicUser }) {
  const [payload, setPayload] = useState<JobsPayload>(EMPTY_PAYLOAD);
  const [results, setResults] = useState<ResultsPage>(EMPTY_RESULTS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [confirm, setConfirm] = useState<SnapshotResult | null>(null);
  const [dismissing, setDismissing] = useState<SnapshotResult | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [reviewFilter, setReviewFilter] = useState("");
  const [page, setPage] = useState(1);

  const job = payload.activeJob;
  const canWork = payload.isOwner && job !== null
    && ["draft", "review", "paused", "processing"].includes(job.status);
  const busy = busyId !== "";

  const load = async () => {
    setPayload(await api<JobsPayload>("/api/library/gallery/duplicate-jobs"));
  };

  const loadResults = async (jobId: string) => {
    const params = new URLSearchParams({ page: String(page), perPage: "25" });
    if (search.trim()) params.set("q", search.trim());
    if (typeFilter) params.set("type", typeFilter);
    if (reviewFilter) params.set("review", reviewFilter);
    setResults(await api<ResultsPage>(`/api/library/gallery/duplicate-jobs/${jobId}/results?${params}`));
  };

  // One round trip for the job, one for its page of results — never two of either,
  // which is what a naive load()-then-read-it-again would cost on every action.
  const reload = async () => {
    const current = await api<JobsPayload>("/api/library/gallery/duplicate-jobs");
    setPayload(current);
    if (current.activeJob && current.activeJob.status !== "draft") await loadResults(current.activeJob.id);
    else setResults(EMPTY_RESULTS);
  };

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load duplicate cleanup"))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!job || job.status === "draft") { setResults(EMPTY_RESULTS); return; }
    const handle = window.setTimeout(() => {
      loadResults(job.id).catch((err) =>
        setError(err instanceof Error ? err.message : "Unable to load the results"));
    }, search ? 250 : 0);
    return () => window.clearTimeout(handle);
  }, [job?.id, job?.status, job?.scanCompletedAt, search, typeFilter, reviewFilter, page]);

  useEffect(() => { setPage(1); }, [search, typeFilter, reviewFilter]);

  const post = async (path: string, id: string, whenFailed: string, body: unknown = {}) => {
    setBusyId(id);
    setActionError("");
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      await reload();
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : whenFailed);
      return false;
    } finally {
      setBusyId("");
    }
  };

  // ── Cards ─────────────────────────────────────────────────────────────────

  // One card, one destination. A folder whose photos survive in three different
  // places produces three of these rather than one card listing three folders —
  // "this folder against that folder" is how a person reads a card, and a list of
  // destinations gets read as "these folders duplicate each other", which is a
  // different and wrong statement.
  const renderContained = (result: SnapshotResult) => {
    const going = doomedFolder(result);
    const keeper = keeperFolders(result)[0];
    const doomedCount = result.members.filter((member) => member.role === "delete").length;
    const totalPhotos = going?.itemCount ?? doomedCount;
    const otherLibrary = keeper && going && keeper.libraryName !== going.libraryName
      ? ` in ${keeper.libraryName}`
      : "";

    return (
      <div className="dup-set dup-folder-card dup-cleanup-folder-card" key={result.id}>
        <div className="dup-folder-card-main">
          <div className="dup-set-head">
            <div className="dup-set-summary">
              <h3 className="dup-set-title">“{going ? folderLabel(going) : ""}”</h3>
              <p className="dup-set-meta datagrid-muted">
                <span><Images size={14} aria-hidden="true" /> {photoCountLabel(totalPhotos)}</span>
                <span><HardDrive size={14} aria-hidden="true" /> {formatBytes(result.reclaimableBytes)}</span>
                {result.reviewStatus !== "unreviewed" && (
                  <span><CircleCheck size={14} aria-hidden="true" /> {result.reviewStatus === "skipped" ? "Skipped" : "Looked at"}</span>
                )}
              </p>
              {/* One plain sentence, because the card is one plain comparison. */}
              <p className="dup-set-explain datagrid-muted">
                {totalPhotos === 1 ? "This photo" : `These ${totalPhotos} photos`} also
                {totalPhotos === 1 ? " sits" : " sit"} in “{keeper ? folderLabel(keeper) : ""}”{otherLibrary}.
              </p>
            </div>
          </div>
          <FolderStrip urls={result.coverUrls ?? []} total={totalPhotos} />
          {canWork && <ReviewActions result={result} />}
        </div>

        <div className="dup-set-folders">
          {keeper && (
            <CleanupFolderTile
              key={`${keeper.libraryId}:${keeper.folderPath}`}
              folder={keeper}
              keep
              position={0}
              badge={keeper.role === "protected" ? "Protected" : "Keep"}
              action={<KeepTileAction protectedFolder={keeper.role === "protected"} />}
            />
          )}
          {going && (
            <CleanupFolderTile
              folder={going}
              keep={false}
              position={1}
              badge="Delete"
              action={<DeleteResultAction result={result} label="Delete these" />}
            />
          )}
        </div>
      </div>
    );
  };

  const renderFolderSet = (result: SnapshotResult) => {
    const kept = result.folders.find((folder) => folder.role === "keep");
    const going = result.folders.filter((folder) => folder.role !== "keep");
    const deleteFolders = going.filter((folder) => folder.role === "delete");
    const totalPhotos = kept?.itemCount ?? going[0]?.itemCount ?? result.members.length;
    const titleFolder = kept ?? going[0];
    const deleteLabel = deleteFolders.length === 1 ? "Delete this" : "Delete copies";

    return (
      <div className="dup-set dup-folder-card dup-cleanup-folder-card" key={result.id}>
        <div className="dup-folder-card-main">
          <div className="dup-set-head">
            <div className="dup-set-summary">
              <h3 className="dup-set-title">“{titleFolder ? folderLabel(titleFolder) : ""}”</h3>
              <p className="dup-set-meta datagrid-muted">
                <span><Images size={14} aria-hidden="true" /> {photoCountLabel(totalPhotos)}</span>
                <span><HardDrive size={14} aria-hidden="true" /> {formatBytes(result.reclaimableBytes)}</span>
                {result.reviewStatus !== "unreviewed" && (
                  <span><CircleCheck size={14} aria-hidden="true" /> {result.reviewStatus === "skipped" ? "Skipped" : "Looked at"}</span>
                )}
              </p>
              {result.keeperReason && (
                <p className="dup-set-explain datagrid-muted">Kept because: {result.keeperReason}</p>
              )}
            </div>
          </div>
          <FolderStrip urls={result.coverUrls ?? []} total={totalPhotos} />
          {canWork && <ReviewActions result={result} />}
        </div>

        <div className="dup-set-folders">
          {kept && (
            <CleanupFolderTile
              folder={kept}
              keep
              position={0}
              badge="Keep"
              action={<KeepTileAction />}
            />
          )}
          {going.map((folder, index) => (
            <CleanupFolderTile
              key={`${folder.libraryId}:${folder.folderPath}`}
              folder={folder}
              keep={folder.role === "protected"}
              position={(kept ? 1 : 0) + index}
              badge={folder.role === "protected" ? "Protected" : "Delete"}
              action={folder.role === "protected"
                ? <KeepTileAction protectedFolder />
                : <DeleteResultAction result={result} label={deleteLabel} />}
            />
          ))}
        </div>
      </div>
    );
  };

  const renderPhotoSet = (result: SnapshotResult) => {
    const keep = result.members.find((member) => member.role === "keep");
    const going = result.members.filter((member) => member.role !== "keep");

    return (
      <div className="dup-set" key={result.id}>
        <div className="dup-set-head">
          <div className="dup-set-summary">
            <h3 className="dup-set-title">{keep?.path.split("/").pop()}</h3>
            <p className="dup-set-meta datagrid-muted">
              <span><Images size={14} aria-hidden="true" /> {result.members.length} copies</span>
              <span><HardDrive size={14} aria-hidden="true" /> {formatBytes(result.reclaimableBytes)}</span>
            </p>
            {result.keeperReason && (
              <p className="dup-set-explain datagrid-muted">Kept because: {result.keeperReason}</p>
            )}
          </div>
          {canWork && <CardActions result={result} />}
        </div>
        <div className="dup-set-body">
          <ul className="dup-member-list">
            {keep && (
              <li className="dup-member-row is-keep">
                <span className="dup-copy-badge" aria-hidden="true">Keep</span>
                <span className="dup-member-path">{keep.path}</span>
                <span className="datagrid-muted">{keep.libraryName}</span>
              </li>
            )}
            {going.map((member) => (
              <li className={`dup-member-row ${member.role === "protected" ? "is-keep" : "is-trash"}`} key={member.id}>
                <span className="dup-copy-badge" aria-hidden="true">
                  {member.role === "protected" ? "Protected" : "Delete"}
                </span>
                <span className="dup-member-path">{member.path}</span>
                <span className="datagrid-muted">{member.libraryName}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  };

  function DeleteResultAction({ result, label }: { result: SnapshotResult; label: string }) {
    const running = busyId === result.id;
    const deletable = result.members.some((member) => member.role === "delete" && member.status !== "deleted");
    return (
      <Button
        variant="secondary"
        danger
        compact
        className="dup-set-action dup-set-delete-action"
        disabled={busy || !deletable}
        onClick={() => { setActionError(""); setConfirm(result); }}
      >
        {running ? "Deleting…" : label}
      </Button>
    );
  }

  function ReviewActions({ result }: { result: SnapshotResult }) {
    return (
      <div className="dup-cleanup-secondary-actions">
        <Button
          variant="text"
          compact
          className="dup-folder-dismiss-action"
          disabled={busy}
          title="Take it off this cleanup. The next one will offer it again."
          onClick={() => void post(
            `/api/library/gallery/duplicate-jobs/${job!.id}/results/${result.id}/mark`,
            result.id,
            "Unable to skip this one",
            { mark: result.reviewStatus === "skipped" ? "unreviewed" : "skipped" }
          )}
        >
          {result.reviewStatus === "skipped" ? "Put back" : "Skip"}
        </Button>
        <Button
          variant="text"
          compact
          className="dup-folder-dismiss-action"
          disabled={busy}
          title="These are not duplicates. No future scan will pair them again."
          onClick={() => { setActionError(""); setDismissing(result); }}
        >
          Not the same
        </Button>
      </div>
    );
  }

  function CardActions({ result }: { result: SnapshotResult }) {
    const running = busyId === result.id;
    const deletable = result.members.some((member) => member.role === "delete" && member.status !== "deleted");
    return (
      <div className="dup-group-actions">
        <Button
          variant="secondary"
          compact
          disabled={busy}
          title="Take it off this cleanup. The next one will offer it again."
          onClick={() => void post(
            `/api/library/gallery/duplicate-jobs/${job!.id}/results/${result.id}/mark`,
            result.id,
            "Unable to skip this one",
            { mark: result.reviewStatus === "skipped" ? "unreviewed" : "skipped" }
          )}
        >
          {result.reviewStatus === "skipped" ? "Put back" : "Skip"}
        </Button>
        <Button
          variant="secondary"
          compact
          disabled={busy}
          title="These are not duplicates. No future scan will pair them again."
          onClick={() => { setActionError(""); setDismissing(result); }}
        >
          Not the same
        </Button>
        <Button
          variant="secondary"
          danger
          compact
          className="dup-delete-action"
          disabled={busy || !deletable}
          onClick={() => { setActionError(""); setConfirm(result); }}
        >
          <Trash2 size={14} />
          <span>{running ? "Deleting…" : "Delete copies"}</span>
        </Button>
      </div>
    );
  }

  const renderResult = (result: SnapshotResult) => {
    if (result.type === "contained") return renderContained(result);
    if (result.type === "folder_set" || result.type === "overlap") return renderFolderSet(result);
    return renderPhotoSet(result);
  };

  // Each kind under its own heading, strongest statement first — the order the
  // server already sends them in, so a page can straddle the boundaries.
  const grouped = (["folder_set", "contained", "overlap", "photo_set"] as ResultType[])
    .map((type) => ({ type, items: results.results.filter((result) => result.type === type) }))
    .filter((group) => group.items.length > 0);

  const totalPages = Math.max(1, Math.ceil(results.total / results.perPage));
  const narrowed = search.trim() !== "" || typeFilter !== "" || reviewFilter !== "";

  return (
    <>
      <ControlSectionHead
        section="duplicateCleanup"
        className="dup-section-head"
        iconClassName="duplicates"
        icon={<Trash2 size={30} />}
        description="One saved cleanup at a time: choose what to compare, scan once, and work through it whenever you like."
      />

      <ExperimentalNotice />

      {error && <MessageBox tone="error" title="Unable to load duplicate cleanup">{error}</MessageBox>}
      {actionError && !confirm && !dismissing && (
        <MessageBox tone="error" title="Action failed">{actionError}</MessageBox>
      )}

      {loaded && !job && (
        <div className="dup-job-card">
          <div className="dup-job-card-body">
            <h2>No cleanup in progress</h2>
            <p className="datagrid-muted">
              A cleanup remembers what it found and what you decided, so you can stop and come back to it. Only one
              runs at a time.
            </p>
          </div>
          <Button variant="primary" onClick={() => { setActionError(""); setWizardOpen(true); }}>
            Start a cleanup
          </Button>
        </div>
      )}

      {job && (
        <JobCard
          job={job}
          isOwner={payload.isOwner}
          busy={busy}
          onScan={() => void post(`/api/library/gallery/duplicate-jobs/${job.id}/scan`, job.id, "The scan could not run")}
          onFinish={() => { setActionError(""); setFinishing(true); }}
          onCancel={() => { setActionError(""); setCancelling(true); }}
          onEdit={() => { setActionError(""); setWizardOpen(true); }}
        />
      )}

      {job && job.status !== "draft" && results.allResults > 0 && (
        <div className="dup-toolbar dup-folder-toolbar">
          <Button
            variant="secondary"
            compact
            className={narrowed ? "is-active" : ""}
            onClick={() => setFiltersOpen(true)}
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
            <span>{narrowed ? "Filters (on)" : "Filters"}</span>
          </Button>
          <label className="search-field dup-folder-search">
            <Search size={17} aria-hidden="true" />
            <span className="sr-only">Search this cleanup by folder, file or library</span>
            <input
              type="search"
              value={search}
              placeholder="Search this cleanup..."
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="dup-toolbar-controls">
            <span className="datagrid-muted">
              {results.total} of {results.allResults} shown
            </span>
          </div>
        </div>
      )}

      {job && job.status === "draft" && (
        <MessageBox tone="info" title="Nothing scanned yet">
          The cleanup knows which libraries to compare. Run the scan to see what it finds — it reads no files, only the
          fingerprints already stored, so it is quick.
        </MessageBox>
      )}

      {job && job.status !== "draft" && results.allResults === 0 && (
        <p className="management-empty">
          This cleanup found nothing to remove. Finish it, and start another whenever you like.
        </p>
      )}

      {job && results.allResults > 0 && results.total === 0 && (
        <p className="management-empty">Nothing matches what you've narrowed this to.</p>
      )}

      {grouped.map((group) => (
        <div key={group.type}>
          <h2 className="dup-tier-heading">{TYPE_HEADINGS[group.type].title}</h2>
          <p className="datagrid-muted dup-tier-note">{TYPE_HEADINGS[group.type].note}</p>
          <div className="dup-sets">{group.items.map(renderResult)}</div>
        </div>
      ))}

      {results.total > results.perPage && (
        <div className="dup-pager-row">
          <span className="datagrid-muted">
            Showing {(results.page - 1) * results.perPage + 1}–
            {Math.min(results.page * results.perPage, results.total)} of {results.total}
          </span>
          <Pager page={results.page} totalPages={totalPages} onChange={setPage} label="Cleanup result pages" />
        </div>
      )}

      <p className="dup-status dup-status-row datagrid-muted">
        <a href={controlHref("duplicatePhotos")}>The older Duplicate photos and Duplicate folders pages are still here</a>
      </p>

      {wizardOpen && (
        <CleanupWizard
          libraries={payload.libraries}
          job={job && job.status === "draft" ? job : null}
          ownerName={currentUser.displayName}
          onClose={() => setWizardOpen(false)}
          onSaved={async () => { setWizardOpen(false); await reload(); }}
        />
      )}

      {filtersOpen && (
        <Modal title="Narrow what's shown" onClose={() => setFiltersOpen(false)}>
          <div className="dup-filter-form">
            <label className="dup-filter-field">
              <span className="dup-filter-label">Kind of result</span>
              <SelectMenu
                value={typeFilter}
                options={typeFilters(job?.duplicateType ?? "folders")}
                label="Kind of result"
                onChange={setTypeFilter}
              />
            </label>
            <label className="dup-filter-field">
              <span className="dup-filter-label">Where you've got to</span>
              <SelectMenu value={reviewFilter} options={REVIEW_FILTERS} label="Review state" onChange={setReviewFilter} />
            </label>
          </div>
          <div className="modal-actions">
            <Button
              variant="text"
              disabled={!narrowed}
              onClick={() => { setSearch(""); setTypeFilter(""); setReviewFilter(""); }}
            >
              Clear filters
            </Button>
            <Button variant="secondary" onClick={() => setFiltersOpen(false)}>Done</Button>
          </div>
        </Modal>
      )}

      {confirm && (() => {
        const doomed = confirm.members.filter((member) => member.role === "delete" && member.status !== "deleted");
        // A folder result now has exactly one destination, so this is a name, not a
        // list. A photo set still names the surviving file itself.
        const survivesIn = confirm.type === "photo_set"
          ? confirm.members.find((member) => member.role !== "delete")?.path ?? ""
          : (() => { const keeper = keeperFolders(confirm)[0]; return keeper ? folderLabel(keeper) : ""; })();
        // Only a folder-shaped result leaves a directory behind; a photo set is
        // loose files and there is no folder to mention.
        const leavesFolder = confirm.type !== "photo_set";
        return (
          <ConfirmDialog
            title={`Delete ${doomed.length} cop${doomed.length === 1 ? "y" : "ies"}?`}
            confirmLabel={`Delete ${doomed.length} cop${doomed.length === 1 ? "y" : "ies"}`}
            busyLabel="Deleting…"
            danger
            busy={busyId === confirm.id}
            error={actionError}
            onConfirm={async () => {
              const ok = await post(
                `/api/library/gallery/duplicate-jobs/${job!.id}/results/${confirm.id}/resolve`,
                confirm.id,
                "Unable to remove these copies"
              );
              if (ok) setConfirm(null);
            }}
            onCancel={() => { setConfirm(null); setActionError(""); }}
            rich
          >
            <p>
              Every one of these {doomed.length} photo{doomed.length === 1 ? "" : "s"} also sits in
              {" "}<strong>{survivesIn}</strong>, which is not touched.
            </p>
            <p>
              That is checked again the moment you confirm, against the library as it stands rather than as the scan
              found it. If a photo has been deleted, edited or moved since then, nothing at all is removed and this
              card says what changed.
            </p>
            <p>
              Each photo hands its tags, albums, collections and tagged people to the copy that survives it first.
              Everything removed goes to the Recycle Bin and can be restored until you empty it.
              {leavesFolder
                ? " Only the photos go: the folder itself is left behind on disk, empty."
                : ""}
            </p>
          </ConfirmDialog>
        );
      })()}

      {dismissing && (
        <ConfirmDialog
          title="Mark these as not duplicates?"
          confirmLabel="Not the same"
          busyLabel="Saving…"
          busy={busyId === dismissing.id}
          error={actionError}
          onConfirm={async () => {
            const ok = await post(
              `/api/library/gallery/duplicate-jobs/${job!.id}/results/${dismissing.id}/dismiss`,
              dismissing.id,
              "Unable to dismiss this one"
            );
            if (ok) setDismissing(null);
          }}
          onCancel={() => { setDismissing(null); setActionError(""); }}
          rich
        >
          <p>
            This is a standing decision, not a note on this cleanup: no future scan will pair these again, on this page
            or the older ones. Nothing is deleted and no photo is changed.
          </p>
          <p>
            To set it aside for now and see it again next time, use <strong>Skip</strong> instead.
          </p>
        </ConfirmDialog>
      )}

      {finishing && job && (
        <ConfirmDialog
          title="Finish this cleanup?"
          confirmLabel="Finish cleanup"
          busyLabel="Finishing…"
          busy={busyId === job.id}
          error={actionError}
          onConfirm={async () => {
            const ok = await post(`/api/library/gallery/duplicate-jobs/${job.id}/complete`, job.id, "Unable to finish");
            if (ok) setFinishing(false);
          }}
          onCancel={() => setFinishing(false)}
          rich
        >
          <p>
            The cleanup is closed and kept as a record: {job.totals.deleted} cop{job.totals.deleted === 1 ? "y" : "ies"}
            {" "}removed, {formatBytes(job.totals.reclaimedBytes)} freed. Nothing more can be deleted from it.
          </p>
          <p>
            {job.totals.remaining > 0
              ? `${job.totals.remaining} result${job.totals.remaining === 1 ? "" : "s"} you haven't acted on will simply be found again by the next cleanup.`
              : "You can start a new cleanup straight away."}
          </p>
        </ConfirmDialog>
      )}

      {cancelling && job && (
        <ConfirmDialog
          title="Cancel this cleanup?"
          confirmLabel="Cancel cleanup"
          busyLabel="Cancelling…"
          danger
          busy={busyId === job.id}
          error={actionError}
          onConfirm={async () => {
            const ok = await post(`/api/library/gallery/duplicate-jobs/${job.id}/cancel`, job.id, "Unable to cancel");
            if (ok) setCancelling(false);
          }}
          onCancel={() => setCancelling(false)}
          rich
        >
          <p>
            The cleanup stops and its list is discarded. Photos already moved to the Recycle Bin stay there — cancelling
            does not put them back, and nothing here empties the bin.
          </p>
          <p>You can start a new cleanup afterwards.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

// ── The job card ────────────────────────────────────────────────────────────

function JobCard({
  job, isOwner, busy, onScan, onFinish, onCancel, onEdit
}: {
  job: DuplicateJob;
  isOwner: boolean;
  busy: boolean;
  onScan: () => void;
  onFinish: () => void;
  onCancel: () => void;
  onEdit: () => void;
}) {
  const included = job.libraries.filter((library) => library.included);
  // A library that changed under the job. Worth saying: the results were worked out
  // when it was something else.
  const changed = job.libraries.filter((library) =>
    !library.missing && (library.mode !== library.currentMode || library.isProtected !== library.currentlyProtected));

  return (
    <div className="dup-job-card">
      <div className="dup-job-card-body">
        <p className="eyebrow">{STATUS_WORDS[job.status]}</p>
        <h2>
          {included.length} librar{included.length === 1 ? "y" : "ies"}
          {job.duplicateType === "folders" ? " · whole folders" : " · single files"}
          {job.mediaType === "photo" ? " · photos" : job.mediaType === "video" ? " · videos" : ""}
        </h2>
        <p className="datagrid-muted">
          Started by {job.ownerName} · last touched {formatWhen(job.lastActivityAt)}
        </p>
        {job.status !== "draft" && (
          <p className="dup-set-meta datagrid-muted">
            <span>{job.totals.results} found</span>
            <span>{job.totals.reviewed} looked at</span>
            <span>{job.totals.deleted} removed</span>
            <span>{formatBytes(job.totals.reclaimableBytes)} still to reclaim</span>
            {job.totals.errors > 0 && <span>{job.totals.errors} with problems</span>}
          </p>
        )}
        {job.statusDetail && <p className="datagrid-muted">{job.statusDetail}</p>}
      </div>

      <div className="dup-group-actions">
        {!isOwner ? (
          <span className="datagrid-muted">
            <Lock size={14} aria-hidden="true" /> {job.ownerName} is working on this
          </span>
        ) : (
          <>
            {job.status === "draft" && (
              <Button variant="secondary" compact disabled={busy} onClick={onEdit}>Change what to compare</Button>
            )}
            {(job.status === "draft" || job.status === "review") && (
              <Button variant="primary" compact disabled={busy} onClick={onScan}>
                <RefreshCw size={14} aria-hidden="true" />
                <span>{job.status === "draft" ? "Run scan" : "Scan again"}</span>
              </Button>
            )}
            <Button variant="secondary" compact disabled={busy} onClick={onFinish}>Finish</Button>
            <Button variant="secondary" danger compact disabled={busy} onClick={onCancel}>Cancel</Button>
          </>
        )}
      </div>

      {changed.length > 0 && (
        <MessageBox tone="warning" title="A library has changed since this cleanup started">
          {changed.map((library) => library.name).join(", ")} {changed.length === 1 ? "is" : "are"} not what
          {" "}{changed.length === 1 ? "it was" : "they were"} when this was set up. Anything affected is re-checked
          before it can be deleted, and will be refused rather than acted on.
        </MessageBox>
      )}
    </div>
  );
}

// ── The wizard ──────────────────────────────────────────────────────────────
//
// Two steps: choose the scope, then look over the exact job that will be created.
// Everything about which copy survives belongs to the review, not here: choosing
// what to compare and choosing what to keep are different questions.

type DuplicateKind = DuplicateJob["duplicateType"];
type MediaKind = DuplicateJob["mediaType"];

const cleanupTypeLabel = (type: DuplicateKind): string =>
  type === "folders" ? "Duplicate folders" : "Individual files";

const cleanupTypeDescription = (type: DuplicateKind): string =>
  type === "folders"
    ? "Compare duplicate folders and their contents"
    : "Review duplicate photos or videos one by one";

const mediaTypeLabel = (type: MediaKind): string =>
  type === "photo" ? "Photos" : type === "video" ? "Videos" : "Photos and videos";

const mediaTypeDescription = (type: MediaKind): string =>
  type === "photo"
    ? "Image fingerprints only"
    : type === "video"
      ? "Video fingerprints only"
      : "Include both images and videos";

function libraryModeLabel(library: LibraryOption): string {
  return library.mode === "external" ? "External" : "Internal";
}

function libraryIcon(library: LibraryOption) {
  const text = `${library.name} ${library.sourcePath}`.toLowerCase();
  if (text.includes("phone") || text.includes("mobile") || text.includes("iphone") || text.includes("android")) {
    return <Smartphone size={19} aria-hidden="true" />;
  }
  if (text.includes("cloud") || text.includes("google") || text.includes("icloud")) {
    return <Cloud size={19} aria-hidden="true" />;
  }
  if (library.mode === "external" || text.includes("nas") || text.includes("usb") || text.includes("volume")) {
    return <HardDrive size={19} aria-hidden="true" />;
  }
  return <ImageIcon size={19} aria-hidden="true" />;
}

function CleanupWizard({
  libraries, job, ownerName, onClose, onSaved
}: {
  libraries: LibraryOption[];
  job: DuplicateJob | null;
  ownerName: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [step, setStep] = useState(Math.min(job?.currentStep ?? 1, 2));
  const [chosen, setChosen] = useState<string[]>(
    job ? job.libraries.filter((library) => library.included).map((library) => library.libraryId)
      : libraries.filter((library) => !library.isProtected).map((library) => library.id)
  );
  const [duplicateType, setDuplicateType] = useState<DuplicateKind>(job?.duplicateType ?? "folders");
  const [mediaType, setMediaType] = useState<MediaKind>(job?.mediaType ?? "photo");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = (id: string) => setChosen((current) =>
    current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);

  const chosenLibraries = libraries.filter((library) => chosen.includes(library.id));
  const externalCount = chosenLibraries.filter((library) => library.isProtected).length;
  const internalCount = chosenLibraries.length - externalCount;
  const hasProtected = libraries.some((library) => library.isProtected);
  const stepName = step === 1 ? "Select what to scan" : "Review and run";

  const cleanupTypeChoices: Choice<DuplicateKind>[] = [
    {
      value: "folders",
      label: "Duplicate folders",
      description: "Compare duplicate folders and their contents",
      icon: <FolderOpen size={22} />
    },
    {
      value: "files",
      label: "Individual files",
      description: "Review duplicate photos or videos one by one",
      icon: <File size={22} />
    }
  ];

  const mediaTypeChoices: Choice<MediaKind>[] = [
    {
      value: "photo",
      label: "Photos",
      description: "Image fingerprints only",
      icon: <ImageIcon size={21} />
    },
    {
      value: "video",
      label: "Videos",
      description: "Video fingerprints only",
      icon: <Video size={21} />
    },
    {
      value: "both",
      label: "Photos and videos",
      description: "Include both images and videos",
      icon: (
        <span className="cleanup-choice-pair" aria-hidden="true">
          <ImageIcon size={18} />
          <Video size={18} />
        </span>
      )
    }
  ];

  const save = async (andRun: boolean) => {
    setSaving(true);
    setError("");
    try {
      const body = { libraryIds: chosen, duplicateType, mediaType, currentStep: step };
      const id = job
        ? (await api<{ activeJob: DuplicateJob }>(`/api/library/gallery/duplicate-jobs/${job.id}`, {
            method: "PATCH", body: JSON.stringify(body)
          })).activeJob?.id ?? job.id
        : (await api<{ activeJob: DuplicateJob }>("/api/library/gallery/duplicate-jobs", {
            method: "POST", body: JSON.stringify(body)
          })).activeJob!.id;
      if (andRun) {
        await api(`/api/library/gallery/duplicate-jobs/${id}/scan`, { method: "POST", body: "{}" });
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save this cleanup");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="panel"
      title={job ? "Change duplicate cleanup job" : "Create duplicate cleanup job"}
      subtitle={`Step ${step} of 2 · ${stepName}`}
      icon={<FolderOpen size={30} />}
      className="cleanup-wizard-modal"
      headerClassName="cleanup-wizard-header"
      busy={saving}
      onClose={onClose}
    >
      <div className="cleanup-wizard-shell">
        <aside className="cleanup-wizard-rail" aria-label="Duplicate cleanup steps">
          {[
            { value: 1, title: "Scan setup", note: "Libraries, cleanup type, media" },
            { value: 2, title: "Summary", note: "Review and run" }
          ].map((item) => {
            const done = step > item.value;
            const active = step === item.value;
            return (
              <div
                className={`cleanup-step${active ? " is-active" : ""}${done ? " is-done" : ""}`}
                aria-current={active ? "step" : undefined}
                key={item.value}
              >
                <span className="cleanup-step-dot" aria-hidden="true">
                  {done ? <Check size={14} /> : item.value}
                </span>
                <span className="cleanup-step-copy">
                  <strong>{item.title}</strong>
                  <span>{item.note}</span>
                </span>
              </div>
            );
          })}
        </aside>

        <div className="cleanup-wizard-content">
          {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}

          {step === 1 && (
            <div className="cleanup-wizard-page">
              <div className="cleanup-wizard-intro">
                <h3>Select what to scan</h3>
                <p>Choose libraries, cleanup type, and media type for this duplicate cleanup job.</p>
              </div>

              <section className="cleanup-wizard-section">
                <h4>1. Select libraries</h4>
                {libraries.length === 0 ? (
                  <MessageBox tone="warning" title="No gallery libraries">
                    Create a gallery library before starting a duplicate cleanup job.
                  </MessageBox>
                ) : (
                  <div className="cleanup-library-list" role="list">
                    {libraries.map((library) => {
                      const included = chosen.includes(library.id);
                      return (
                        <div className={`cleanup-library-row${included ? " is-selected" : ""}`} role="listitem" key={library.id}>
                          <span className="cleanup-library-icon" aria-hidden="true">{libraryIcon(library)}</span>
                          <span className="cleanup-library-copy">
                            <strong>{library.name}</strong>
                            <span>{library.sourcePath}</span>
                          </span>
                          <span className={`cleanup-library-badge ${library.mode}`}>
                            {libraryModeLabel(library)}
                          </span>
                          {library.isProtected && (
                            <span className="cleanup-library-lock" title="This library is protected from cleanup actions">
                              <Lock size={15} aria-hidden="true" />
                            </span>
                          )}
                          <ToggleSwitch
                            checked={included}
                            onChange={() => toggle(library.id)}
                            disabled={saving}
                            ariaLabel={`${included ? "Exclude" : "Include"} ${library.name}`}
                            className="cleanup-library-toggle"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
                {hasProtected && (
                  <MessageBox tone="info" title="External libraries stay protected">
                    External libraries can be included for comparison, but files there cannot be cleaned.
                  </MessageBox>
                )}
              </section>

              <section className="cleanup-wizard-section">
                <ChoiceGroup
                  legend="2. Cleanup type"
                  className="cleanup-choice-grid"
                  value={duplicateType}
                  onChange={setDuplicateType}
                  disabled={saving}
                  options={cleanupTypeChoices}
                />
              </section>

              <section className="cleanup-wizard-section">
                <ChoiceGroup
                  legend="3. Media type"
                  className="cleanup-choice-grid"
                  value={mediaType}
                  onChange={setMediaType}
                  disabled={saving}
                  options={mediaTypeChoices}
                />
              </section>
            </div>
          )}

          {step === 2 && (
            <div className="cleanup-summary-layout">
              <div className="cleanup-summary-main">
                <div className="cleanup-wizard-intro">
                  <h3>Summary</h3>
                  <p>Review your selections before starting the duplicate cleanup scan.</p>
                </div>

                <section className="cleanup-summary-card">
                  <h4>1. Selected libraries</h4>
                  <div className="cleanup-summary-libraries">
                    {chosenLibraries.map((library) => (
                      <div className="cleanup-summary-library" key={library.id}>
                        <span className="cleanup-library-icon" aria-hidden="true">{libraryIcon(library)}</span>
                        <strong>{library.name}</strong>
                        <span className={`cleanup-library-badge ${library.mode}`}>{libraryModeLabel(library)}</span>
                      </div>
                    ))}
                    {chosenLibraries.length === 0 && (
                      <p className="datagrid-muted cleanup-summary-empty">No libraries selected.</p>
                    )}
                  </div>
                  <p className="cleanup-summary-count">
                    {chosenLibraries.length} librar{chosenLibraries.length === 1 ? "y" : "ies"} selected
                    {" · "}{internalCount} internal
                    {" · "}{externalCount} external
                  </p>
                </section>

                <section className="cleanup-summary-card cleanup-summary-choice">
                  <h4>2. Cleanup type</h4>
                  <div>
                    <span className="cleanup-summary-icon">
                      {duplicateType === "files"
                        ? <File size={22} aria-hidden="true" />
                        : <FolderOpen size={22} aria-hidden="true" />}
                    </span>
                    <span>
                      <strong>{cleanupTypeLabel(duplicateType)}</strong>
                      <small>{cleanupTypeDescription(duplicateType)}</small>
                    </span>
                  </div>
                </section>

                <section className="cleanup-summary-card cleanup-summary-choice">
                  <h4>3. Media type</h4>
                  <div>
                    <span className="cleanup-summary-icon">
                      {mediaType === "video" ? (
                        <Video size={22} aria-hidden="true" />
                      ) : mediaType === "both" ? (
                        <span className="cleanup-choice-pair" aria-hidden="true">
                          <ImageIcon size={18} />
                          <Video size={18} />
                        </span>
                      ) : (
                        <ImageIcon size={22} aria-hidden="true" />
                      )}
                    </span>
                    <span>
                      <strong>{mediaTypeLabel(mediaType)}</strong>
                      <small>{mediaTypeDescription(mediaType)}</small>
                    </span>
                  </div>
                </section>

                {externalCount > 0 && (
                  <MessageBox tone="info" title="External libraries are comparison only">
                    They are always protected and cannot be cleaned or selected for deletion.
                  </MessageBox>
                )}

                <div className="cleanup-summary-note">
                  <ShieldCheck size={17} aria-hidden="true" />
                  <span>This scan creates one active duplicate cleanup job assigned to the current user.</span>
                </div>
              </div>

              <aside className="cleanup-overview-card" aria-label="Job overview">
                <h4>Job overview</h4>
                <dl>
                  <div>
                    <dt><UserRound size={20} aria-hidden="true" />Owner</dt>
                    <dd>{job?.ownerName ?? ownerName}</dd>
                  </div>
                  <div>
                    <dt><RefreshCw size={20} aria-hidden="true" />Estimated action</dt>
                    <dd>Scan and review</dd>
                  </div>
                  <div>
                    <dt><Briefcase size={20} aria-hidden="true" />Job type</dt>
                    <dd>Duplicate cleanup</dd>
                  </div>
                </dl>
              </aside>
            </div>
          )}
        </div>
      </div>

      <div className="modal-actions cleanup-wizard-actions">
        {step > 1 && (
          <Button variant="secondary" disabled={saving} onClick={() => setStep(step - 1)}>
            <ArrowLeft size={16} aria-hidden="true" />
            <span>Back</span>
          </Button>
        )}
        <Button variant="secondary" disabled={saving} onClick={onClose}>Cancel</Button>
        <span className="cleanup-wizard-action-spacer" aria-hidden="true" />
        {step < 2 ? (
          <Button
            variant="primary"
            disabled={saving || chosen.length === 0}
            onClick={() => setStep(step + 1)}
          >
            <span>Next</span>
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        ) : (
          <>
            {job && (
              <Button variant="secondary" disabled={saving || chosen.length === 0} onClick={() => void save(false)}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            )}
            <Button variant="primary" disabled={saving || chosen.length === 0} onClick={() => void save(true)}>
              <span>{saving ? "Scanning…" : "Run scan"}</span>
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Shown when a result's copies have moved on since the scan. */
export function StaleNotice({ problems }: { problems: { path: string; stale: string | null }[] }) {
  return (
    <MessageBox tone="warning" title="These have changed since the scan">
      <ul>
        {problems.map((problem) => (
          <li key={problem.path}>
            <TriangleAlert size={12} aria-hidden="true" /> {problem.path} — {problem.stale === "modified"
              ? "changed on disk"
              : problem.stale === "protected"
                ? "now in a library nothing may be deleted from"
                : "no longer there"}
          </li>
        ))}
      </ul>
    </MessageBox>
  );
}
