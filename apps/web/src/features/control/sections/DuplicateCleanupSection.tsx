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
import { useEffect, useState } from "react";
import {
  ArrowRight, CircleCheck, FolderOpen, HardDrive, Images, Lock, RefreshCw, Search,
  SlidersHorizontal, Trash2, TriangleAlert
} from "lucide-react";
import { api } from "../../../api";
import { formatBytes } from "../../../shared/utils";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { Modal } from "../../../shared/Modal";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Pager } from "../../../shared/Pager";
import { SelectMenu } from "../../../shared/SelectMenu";
import { ControlSectionHead } from "../ControlSectionHead";
import { controlHref } from "../../../router";
import { ExperimentalNotice, formatWhen } from "./duplicate-shared";

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
  duplicateType: "folders" | "files" | "both";
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

const TYPE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "Everything" },
  { value: "folder_set", label: "Identical folders" },
  { value: "contained", label: "Stored elsewhere" },
  { value: "photo_set", label: "Single photos" }
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

/** A folder path as a person reads it. "" is the library's own top folder — not a
 *  place with a name, so it is described rather than named. */
const folderLabel = (path: string): string => path || "the top level";

// "A", "A and B", "A, B and C", "A, B, C and 2 more folders" — a list, because the
// answer is a list. The single-target column this replaces could only ever name one
// place, and named the library root whenever the copies were spread out.
function folderSentence(folders: SnapshotFolder[]): string {
  const names = folders.map((folder) => `“${folderLabel(folder.folderPath)}”`);
  if (names.length === 0) return "another folder";
  if (names.length === 1) return names[0];
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const shown = names.slice(0, 3).join(", ");
  const rest = names.length - 3;
  return `${shown} and ${rest} more folder${rest === 1 ? "" : "s"}`;
}

// ── The page ────────────────────────────────────────────────────────────────

export function DuplicateCleanupSection() {
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

  const renderContained = (result: SnapshotResult) => {
    const going = doomedFolder(result);
    const keepers = keeperFolders(result);
    const doomedCount = result.members.filter((member) => member.role === "delete").length;
    const elsewhere = new Set(keepers.map((folder) => folder.libraryName));
    const otherLibrary = elsewhere.size === 1 && going && !elsewhere.has(going.libraryName)
      ? ` in ${[...elsewhere][0]}`
      : "";

    return (
      <div className="dup-set" key={result.id}>
        <div className="dup-set-head">
          <div className="dup-set-summary">
            <h3 className="dup-set-title">“{folderLabel(going?.folderPath ?? "")}”</h3>
            <p className="dup-set-meta datagrid-muted">
              <span><Images size={14} aria-hidden="true" /> {doomedCount} photo{doomedCount === 1 ? "" : "s"}</span>
              <span><HardDrive size={14} aria-hidden="true" /> {formatBytes(result.reclaimableBytes)}</span>
              {result.reviewStatus !== "unreviewed" && (
                <span><CircleCheck size={14} aria-hidden="true" /> {result.reviewStatus === "skipped" ? "Skipped" : "Looked at"}</span>
              )}
            </p>
            {/* The whole point of the snapshot, in one sentence: every folder the
                copies really sit in, named. */}
            <p className="dup-set-explain datagrid-muted">
              Every photo here also sits in {folderSentence(keepers)}{otherLibrary}.
            </p>
          </div>
          {canWork && <CardActions result={result} />}
        </div>

        <div className="dup-set-body">
          <div className="dup-set-folders">
            <div className="dup-set-folder-wrap">
              <div className="dup-set-folder is-trash">
                <div className="dup-set-folder-top">
                  <span className="dup-copy-badge dup-set-badge" aria-hidden="true">Delete</span>
                </div>
                <span className="dup-set-name-row">
                  <FolderOpen size={17} aria-hidden="true" />
                  <strong className="dup-set-folder-name">{folderLabel(going?.folderPath ?? "")}</strong>
                </span>
                <span className="dup-set-line"><Images size={12} aria-hidden="true" /><span>{going?.libraryName}</span></span>
              </div>
            </div>
            <ArrowRight className="dup-set-arrow" size={18} aria-hidden="true" />
            {keepers.map((folder) => (
              <div className="dup-set-folder-wrap" key={`${folder.libraryId}:${folder.folderPath}`}>
                <div className="dup-set-folder is-keep">
                  <div className="dup-set-folder-top">
                    <span className="dup-copy-badge dup-set-badge" aria-hidden="true">
                      {folder.role === "protected" ? "Protected" : "Keep"}
                    </span>
                  </div>
                  <span className="dup-set-name-row">
                    <FolderOpen size={17} aria-hidden="true" />
                    <strong className="dup-set-folder-name">{folderLabel(folder.folderPath)}</strong>
                  </span>
                  <span className="dup-set-line">
                    <Images size={12} aria-hidden="true" />
                    <span>{folder.itemCount} of them here</span>
                  </span>
                  <span className="dup-set-line"><span>{folder.libraryName}</span></span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderFolderSet = (result: SnapshotResult) => {
    const kept = result.folders.find((folder) => folder.role === "keep");
    const going = result.folders.filter((folder) => folder.role !== "keep");

    return (
      <div className="dup-set" key={result.id}>
        <div className="dup-set-head">
          <div className="dup-set-summary">
            <h3 className="dup-set-title">“{folderLabel(kept?.folderPath ?? "")}”</h3>
            <p className="dup-set-meta datagrid-muted">
              <span><Images size={14} aria-hidden="true" /> {kept?.itemCount ?? 0} photo{kept?.itemCount === 1 ? "" : "s"}</span>
              <span><HardDrive size={14} aria-hidden="true" /> {formatBytes(result.reclaimableBytes)}</span>
            </p>
            {result.keeperReason && (
              <p className="dup-set-explain datagrid-muted">Kept because: {result.keeperReason}</p>
            )}
          </div>
          {canWork && <CardActions result={result} />}
        </div>

        <div className="dup-set-body">
          <div className="dup-set-folders">
            {kept && (
              <div className="dup-set-folder-wrap">
                <div className="dup-set-folder is-keep">
                  <div className="dup-set-folder-top">
                    <span className="dup-copy-badge dup-set-badge" aria-hidden="true">Keep</span>
                  </div>
                  <span className="dup-set-name-row">
                    <FolderOpen size={17} aria-hidden="true" />
                    <strong className="dup-set-folder-name">{folderLabel(kept.folderPath)}</strong>
                  </span>
                  <span className="dup-set-line"><span>{kept.libraryName}</span></span>
                </div>
              </div>
            )}
            {going.map((folder) => (
              <div className="dup-set-folder-wrap" key={`${folder.libraryId}:${folder.folderPath}`}>
                <ArrowRight className="dup-set-arrow" size={18} aria-hidden="true" />
                <div className={`dup-set-folder ${folder.role === "protected" ? "is-keep" : "is-trash"}`}>
                  <div className="dup-set-folder-top">
                    <span className="dup-copy-badge dup-set-badge" aria-hidden="true">
                      {folder.role === "protected" ? "Protected" : "Delete"}
                    </span>
                  </div>
                  <span className="dup-set-name-row">
                    <FolderOpen size={17} aria-hidden="true" />
                    <strong className="dup-set-folder-name">{folderLabel(folder.folderPath)}</strong>
                  </span>
                  <span className="dup-set-line"><span>{folder.libraryName}</span></span>
                </div>
              </div>
            ))}
          </div>
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
          onClose={() => setWizardOpen(false)}
          onSaved={async () => { setWizardOpen(false); await reload(); }}
        />
      )}

      {filtersOpen && (
        <Modal title="Narrow what's shown" onClose={() => setFiltersOpen(false)}>
          <div className="dup-filter-form">
            <label className="dup-filter-field">
              <span className="dup-filter-label">Kind of result</span>
              <SelectMenu value={typeFilter} options={TYPE_FILTERS} label="Kind of result" onChange={setTypeFilter} />
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
        const keepers = confirm.type === "photo_set"
          ? confirm.members.filter((member) => member.role !== "delete").map((member) => member.path)
          : keeperFolders(confirm).map((folder) => folderLabel(folder.folderPath));
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
              {" "}<strong>{keepers.slice(0, 3).join(", ")}</strong>
              {keepers.length > 3 ? ` and ${keepers.length - 3} more` : ""}, which {keepers.length === 1 ? "is" : "are"} not touched.
            </p>
            <p>
              That is checked again the moment you confirm, against the library as it stands rather than as the scan
              found it. If a photo has been deleted, edited or moved since then, nothing at all is removed and this
              card says what changed.
            </p>
            <p>
              Each photo hands its tags, albums, collections and tagged people to the copy that survives it first.
              Everything removed goes to the Recycle Bin and can be restored until you empty it.
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
          {job.duplicateType === "folders" ? " · folders only" : job.duplicateType === "files" ? " · single files only" : ""}
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
// Three steps and no more. Everything about which copy survives belongs to the
// review, not here: choosing what to compare and choosing what to keep are different
// questions, and answering the second before seeing anything is guesswork.

function CleanupWizard({
  libraries, job, onClose, onSaved
}: {
  libraries: LibraryOption[];
  job: DuplicateJob | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [step, setStep] = useState(job?.currentStep ?? 1);
  const [chosen, setChosen] = useState<string[]>(
    job ? job.libraries.filter((library) => library.included).map((library) => library.libraryId)
      : libraries.filter((library) => !library.isProtected).map((library) => library.id)
  );
  const [duplicateType, setDuplicateType] = useState(job?.duplicateType ?? "both");
  const [mediaType, setMediaType] = useState(job?.mediaType ?? "both");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = (id: string) => setChosen((current) =>
    current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);

  const chosenLibraries = libraries.filter((library) => chosen.includes(library.id));
  const externalCount = chosenLibraries.filter((library) => library.isProtected).length;

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
      title={job ? "Change what to compare" : "New duplicate cleanup"}
      busy={saving}
      onClose={onClose}
    >
      <div className="modal-tab-content dup-filter-form">
        {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}

        {step === 1 && (
          <>
            <p className="dup-filter-hint">
              Which photo libraries should be compared with each other. A copy is only ever found — and only ever
              removed — inside what you tick here.
            </p>
            <div className="dup-folder-picker">
              {libraries.map((library) => (
                <div className="dup-folder-choice dup-folder-row" key={library.id}>
                  <input
                    type="checkbox"
                    id={`lib-${library.id}`}
                    checked={chosen.includes(library.id)}
                    onChange={() => toggle(library.id)}
                  />
                  <label className="dup-folder-choice-body" htmlFor={`lib-${library.id}`}>
                    <strong>{library.name}</strong>
                    <span className="datagrid-muted">
                      {library.sourcePath}
                      {library.isProtected ? ` · ${library.mode === "external" ? "External" : "Read-only"}` : ""}
                    </span>
                  </label>
                  {library.isProtected && (
                    <span className="dup-mode-group" title="Nothing can be deleted from this library">
                      <Lock size={14} aria-hidden="true" />
                    </span>
                  )}
                </div>
              ))}
            </div>
            {libraries.some((library) => library.isProtected) && (
              <MessageBox tone="info" title="Read-only libraries are always protected">
                They can be compared, so a copy kept there counts as somewhere the photo survives — but nothing in them
                is ever offered for deletion, and no folder rule can change that.
              </MessageBox>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <div className="dup-filter-field">
              <span className="dup-filter-label">What to look for</span>
              <div className="dup-tier-choices" role="radiogroup" aria-label="What to look for">
                {[
                  { value: "both", label: "Folders and single files", hint: "Everything, strongest statement first" },
                  { value: "folders", label: "Whole folders only", hint: "Folders that duplicate or are stored inside another" },
                  { value: "files", label: "Single files only", hint: "Byte-identical copies of one picture" }
                ].map((choice) => (
                  <label className={`dup-tier-choice${duplicateType === choice.value ? " is-on" : ""}`} key={choice.value}>
                    <input
                      type="radio"
                      name="dup-job-type"
                      checked={duplicateType === choice.value}
                      onChange={() => setDuplicateType(choice.value as typeof duplicateType)}
                    />
                    <span>
                      <strong>{choice.label}</strong>
                      <span className="datagrid-muted">{choice.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="dup-filter-field">
              <span className="dup-filter-label">Photos or videos</span>
              <div className="dup-tier-choices" role="radiogroup" aria-label="Photos or videos">
                {[
                  { value: "both", label: "Photos and videos", hint: "" },
                  { value: "photo", label: "Photos only", hint: "" },
                  { value: "video", label: "Videos only", hint: "A handful of videos can outweigh a thousand photos" }
                ].map((choice) => (
                  <label className={`dup-tier-choice${mediaType === choice.value ? " is-on" : ""}`} key={choice.value}>
                    <input
                      type="radio"
                      name="dup-job-media"
                      checked={mediaType === choice.value}
                      onChange={() => setMediaType(choice.value as typeof mediaType)}
                    />
                    <span>
                      <strong>{choice.label}</strong>
                      {choice.hint && <span className="datagrid-muted">{choice.hint}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <p className="dup-filter-hint">
              Once the scan runs, these can't be changed — everything it finds is worked out under them. Start a new
              cleanup to compare something else.
            </p>
            <ul className="dup-member-list">
              <li className="dup-member-row">
                <span className="dup-member-path">Libraries</span>
                <span className="datagrid-muted">{chosenLibraries.map((library) => library.name).join(", ") || "none"}</span>
              </li>
              <li className="dup-member-row">
                <span className="dup-member-path">Read-only among them</span>
                <span className="datagrid-muted">{externalCount} — compared, never deleted from</span>
              </li>
              <li className="dup-member-row">
                <span className="dup-member-path">Looking for</span>
                <span className="datagrid-muted">
                  {duplicateType === "both" ? "Folders and single files" : duplicateType === "folders" ? "Whole folders" : "Single files"}
                </span>
              </li>
              <li className="dup-member-row">
                <span className="dup-member-path">Media</span>
                <span className="datagrid-muted">
                  {mediaType === "both" ? "Photos and videos" : mediaType === "photo" ? "Photos" : "Videos"}
                </span>
              </li>
            </ul>
            <MessageBox tone="info" title="The scan reads no files">
              It works from the fingerprints already stored, so it costs seconds rather than a pass over the library.
            </MessageBox>
          </>
        )}
      </div>

      <div className="modal-actions">
        {step > 1 && (
          <Button variant="text" disabled={saving} onClick={() => setStep(step - 1)}>Back</Button>
        )}
        <Button variant="secondary" disabled={saving} onClick={onClose}>Cancel</Button>
        {step < 3 ? (
          <Button
            variant="primary"
            disabled={saving || chosen.length === 0}
            onClick={() => setStep(step + 1)}
          >
            Next
          </Button>
        ) : (
          <>
            <Button variant="secondary" disabled={saving} onClick={() => void save(false)}>
              {saving ? "Saving…" : "Save for later"}
            </Button>
            <Button variant="primary" disabled={saving || chosen.length === 0} onClick={() => void save(true)}>
              {saving ? "Scanning…" : "Run scan"}
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
