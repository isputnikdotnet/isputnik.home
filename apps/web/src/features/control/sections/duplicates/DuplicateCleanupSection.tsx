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
// This file is the page itself: loading, filtering, paging, and every request. What
// a result LOOKS like lives in CleanupResultCard, the header and job summary in
// CleanupJobCard, and the scope wizard in CleanupWizard.
import { useEffect, useState } from "react";
import { Briefcase, Search, SlidersHorizontal, Trash2, TriangleAlert } from "lucide-react";
import { api, ApiError, type PublicUser } from "../../../../api";
import { formatBytes } from "../../../../shared/utils";
import { MessageBox } from "../../../../shared/MessageBox";
import { Button } from "../../../../shared/Button";
import { Modal } from "../../../../shared/Modal";
import { ConfirmDialog } from "../../../../shared/ConfirmDialog";
import { Pager } from "../../../../shared/Pager";
import { SelectMenu } from "../../../../shared/SelectMenu";
import { controlHref } from "../../../../router";
import { CleanupHero, JobCard } from "./CleanupJobCard";
import { CleanupWizard } from "./CleanupWizard";
import { CleanupResultCard } from "./CleanupResultCard";
import {
  EMPTY_PAYLOAD, EMPTY_RESULTS, REVIEW_FILTERS, RESULT_SECTIONS, SECTION_HEADINGS, folderLabel,
  keeperFolders, sectionQuery, typeFilters,
  type JobsPayload, type MemberCheck, type ResultCheck, type ResultsPage, type SnapshotResult,
  type StaleReason
} from "./cleanup-types";

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
  // What a re-check says stands in the way, and whether one is in flight.
  const [stale, setStale] = useState<MemberCheck[]>([]);
  const [checking, setChecking] = useState(false);
  const [dismissing, setDismissing] = useState<SnapshotResult | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [takingOver, setTakingOver] = useState(false);

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

  // The filters as the API takes them, built in one place and used by both the listing
  // and the sweep — so the button can never clear something the page was not showing.
  const resultQuery = (): string => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    // The select offers page sections; the API takes a result type and a tier.
    const scope = sectionQuery(typeFilter);
    if (scope.type) params.set("type", scope.type);
    if (scope.tier) params.set("tier", scope.tier);
    if (reviewFilter) params.set("review", reviewFilter);
    return params.toString();
  };

  const loadResults = async (jobId: string) => {
    const params = new URLSearchParams(resultQuery());
    params.set("page", String(page));
    params.set("perPage", "25");
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

  // Re-check the moment the confirm opens, not after someone presses Delete. The
  // server checks again anyway and refuses all-or-nothing, but being told "no" after
  // committing to a destructive action is a worse way to learn a photo moved than
  // being shown it beforehand. One request, at the one moment it is worth making.
  useEffect(() => {
    if (!confirm || !job) { setStale([]); return; }
    let live = true;
    setChecking(true);
    api<ResultCheck>(`/api/library/gallery/duplicate-jobs/${job.id}/results/${confirm.id}/check`)
      .then((result) => { if (live) setStale(result.problems); })
      // A failed check is not itself a reason to block: the confirm path re-checks and
      // will refuse with the detail if something really has moved.
      .catch(() => { if (live) setStale([]); })
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [confirm?.id, job?.id]);

  // Delete one result's copies. Not routed through post(): that helper reduces every
  // failure to a sentence, and a refusal here carries a list of what changed and why.
  const resolveResult = async (result: SnapshotResult) => {
    setBusyId(result.id);
    setActionError("");
    try {
      await api(
        `/api/library/gallery/duplicate-jobs/${job!.id}/results/${result.id}/resolve`,
        { method: "POST", body: "{}" }
      );
      await reload();
      setConfirm(null);
      setStale([]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const check = (err.body as { check?: ResultCheck } | undefined)?.check;
        if (check) setStale(check.problems);
        // The snapshot moved under us, so bring the list up to date behind the dialog.
        await reload().catch(() => { /* the error below is the thing worth saying */ });
      }
      setActionError(err instanceof Error ? err.message : "Unable to remove these copies");
    } finally {
      setBusyId("");
    }
  };

  // While the fingerprint pass runs it is the JOB that changes, not the results — so
  // poll the job alone until it stops scanning. The effect above is watching
  // `job.status`, so the snapshot loads by itself the moment this lands on 'review'.
  useEffect(() => {
    if (job?.status !== "scanning") return;
    const handle = window.setInterval(() => {
      load().catch(() => { /* a blip mid-scan is not worth an error box; the next tick retries */ });
    }, 1500);
    return () => window.clearInterval(handle);
  }, [job?.status]);

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

  // Each kind under its own heading, strongest statement first — the order the server
  // already sends them in, so a page can straddle the boundaries. Single files split
  // by TIER as well as type: identical copies and near-identical ones are different
  // promises, and running them together under one heading is how a judgement call gets
  // swept up with the certainties.
  const grouped = RESULT_SECTIONS
    .map((section) => ({
      section,
      items: results.results.filter((result) =>
        result.type === section.type && (!section.tier || result.tier === section.tier))
    }))
    .filter((group) => group.items.length > 0);

  const totalPages = Math.max(1, Math.ceil(results.total / results.perPage));
  const narrowed = search.trim() !== "" || typeFilter !== "" || reviewFilter !== "";

  // Photos worth checking across every gallery library — pure SQL on the server, no
  // scan involved, so it can sit on the page permanently. It answers "is there anything
  // here at all?" without anyone having to create a job to find out.
  const worthChecking = payload.libraries.reduce((sum, library) => sum + library.candidateCount, 0);

  // Photos in THIS job's libraries that still have no fingerprint after a scan. Should
  // be zero: the scan reads whatever is missing. Anything left means the pass could not
  // open those files — almost always a library whose storage was offline when it ran —
  // and saying "nothing found" then would be a lie.
  const includedIds = new Set(job?.libraries.filter((library) => library.included).map((l) => l.libraryId));
  const unread = payload.libraries
    .filter((library) => includedIds.has(library.id))
    .reduce((sum, library) => sum + library.pendingCount, 0);

  return (
    <>
      <div className="dup-cleanup-top">
        <CleanupHero />

        {loaded && !job && (
          <div className="dup-job-card dup-job-card-empty">
            <div className="dup-job-title-row">
              <span className="dup-job-card-icon" aria-hidden="true">
                <Briefcase size={24} />
              </span>
              <div className="dup-job-card-body">
                <p className="eyebrow">No active cleanup</p>
                <h2>No cleanup in progress</h2>
                <p className="dup-note">
                  A cleanup remembers what it found and what you decided, so you can stop and come back to it.
                </p>
                <p className="dup-note">
                  {worthChecking === 0
                    ? "No two photos here share a file size, so nothing can be a copy of anything. There is nothing to clean up."
                    : `${worthChecking.toLocaleString()} photo${worthChecking === 1 ? " shares" : "s share"} a file size with another one, which is the first thing a copy has to do.`}
                </p>
              </div>
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
            onTakeOver={() => { setActionError(""); setTakingOver(true); }}
          />
        )}

        {job && job.status !== "draft" && results.allResults > 0 && (
          <div className="dup-toolbar dup-folder-toolbar dup-cleanup-toolbar">
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
              {/* Only ever the certain ones, so it is offered only when there are some.
                  A page of near-identical sets shows no sweep at all rather than a
                  disabled button, which would read as "this could clear these too". */}
              {canWork && results.sweep.results > 0 && (
                <Button
                  variant="secondary"
                  danger
                  compact
                  disabled={busy}
                  onClick={() => { setActionError(""); setSweeping(true); }}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  <span>Delete {results.sweep.copies} identical cop{results.sweep.copies === 1 ? "y" : "ies"}</span>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {error && <MessageBox tone="error" title="Unable to load duplicate cleanup">{error}</MessageBox>}
      {actionError && !confirm && !dismissing && (
        <MessageBox tone="error" title="Action failed">{actionError}</MessageBox>
      )}

      {job && job.status === "draft" && (
        <MessageBox tone="info" title="Nothing scanned yet">
          The cleanup knows which libraries to compare. Run the scan and it will fingerprint anything new before
          looking — the first scan of a library can take a while, and you can leave the page while it runs.
        </MessageBox>
      )}

      {job && job.status !== "draft" && job.status !== "scanning" && results.allResults === 0 && (
        unread > 0 ? (
          <MessageBox tone="warning" title="Some photos could not be read">
            {unread.toLocaleString()} photo{unread === 1 ? "" : "s"} in this cleanup's libraries still
            {unread === 1 ? " has" : " have"} no fingerprint, so {unread === 1 ? "it was" : "they were"} never
            compared. That usually means the library's storage was unavailable while the scan ran. Check the library
            is reachable and scan again.
          </MessageBox>
        ) : (
          <p className="management-empty">
            This cleanup found nothing to remove. Finish it, and start another whenever you like.
          </p>
        )
      )}

      {job && results.allResults > 0 && results.total === 0 && (
        <p className="management-empty">Nothing matches what you've narrowed this to.</p>
      )}

      {grouped.map((group) => (
        <div key={group.section.key}>
          <h2 className="dup-tier-heading">{SECTION_HEADINGS[group.section.key].title}</h2>
          <p className="datagrid-muted dup-tier-note">{SECTION_HEADINGS[group.section.key].note}</p>
          <div className="dup-sets">
            {group.items.map((result) => (
              <CleanupResultCard
                key={result.id}
                result={result}
                canWork={canWork}
                actions={{
                  busy,
                  running: busyId === result.id,
                  onSkip: () => void post(
                    `/api/library/gallery/duplicate-jobs/${job!.id}/results/${result.id}/mark`,
                    result.id,
                    "Unable to skip this one",
                    { mark: result.reviewStatus === "skipped" ? "unreviewed" : "skipped" }
                  ),
                  onDismiss: () => { setActionError(""); setDismissing(result); },
                  onDelete: () => { setActionError(""); setConfirm(result); }
                }}
              />
            ))}
          </div>
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
            busy={busyId === confirm.id || checking}
            // Nothing would be removed anyway — the server refuses all-or-nothing — so
            // say that here rather than letting someone press Delete to be told no.
            confirmDisabled={stale.length > 0}
            error={actionError}
            onConfirm={() => void resolveResult(confirm)}
            onCancel={() => { setConfirm(null); setActionError(""); setStale([]); }}
            rich
          >
            {checking && <p className="datagrid-muted">Checking these are still as the scan found them…</p>}
            {stale.length > 0 && <StaleNotice problems={stale} />}
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

      {sweeping && job && (
        <ConfirmDialog
          title={`Delete ${results.sweep.copies} identical cop${results.sweep.copies === 1 ? "y" : "ies"}?`}
          confirmLabel={`Delete ${results.sweep.copies} cop${results.sweep.copies === 1 ? "y" : "ies"}`}
          busyLabel="Deleting…"
          danger
          busy={busyId === job.id}
          error={actionError}
          onConfirm={async () => {
            const ok = await post(
              `/api/library/gallery/duplicate-jobs/${job.id}/results/sweep?${resultQuery()}`,
              job.id,
              "The sweep could not finish"
            );
            if (ok) setSweeping(false);
          }}
          onCancel={() => { setSweeping(false); setActionError(""); }}
          rich
        >
          <p>
            Across <strong>{results.sweep.results} set{results.sweep.results === 1 ? "" : "s"}</strong>, freeing
            about {formatBytes(results.sweep.bytes)}. One copy of every picture stays, and each copy that goes
            hands its tags, albums and people to the one that survives it first.
          </p>
          <p>
            Only <strong>byte-identical</strong> copies — the same file twice, where the copies are
            interchangeable. Near-identical sets are never swept: those are different files, and each one is a
            judgement to make by looking.
          </p>
          {narrowed && (
            <p>
              This follows the filters you have on, so it covers only what is on screen — {results.total} of
              the {results.allResults} results this cleanup found.
            </p>
          )}
          <p>
            Every set is re-checked against the library first, exactly as deleting one at a time is. Any whose
            photos have moved since the scan is left alone and the rest go ahead. Everything removed goes to
            the Recycle Bin.
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

      {takingOver && job && (
        <ConfirmDialog
          title={`Take this cleanup over from ${job.ownerName}?`}
          confirmLabel="Take over"
          busyLabel="Taking over…"
          busy={busyId === job.id}
          error={actionError}
          onConfirm={async () => {
            const ok = await post(
              `/api/library/gallery/duplicate-jobs/${job.id}/reassign`,
              job.id,
              "Unable to take this cleanup over",
              { userId: currentUser.id }
            );
            if (ok) setTakingOver(false);
          }}
          onCancel={() => setTakingOver(false)}
          rich
        >
          <p>
            It becomes yours: you scan, review and delete, and {job.ownerName} can no longer act on it.
            Everything it found and every decision already made is kept exactly as it is.
          </p>
          <p>
            For when the person who started a cleanup isn't coming back to it — only one can be active
            at a time, so theirs holds the slot until it is finished, cancelled, or taken over.
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

/** Shown when a result's copies have moved on since the scan. */
// Each reason gets its own words because each has its own remedy: re-scan, look at the
// file, or change the library's settings. "Something changed" sends someone hunting.
const STALE_WORDS: Record<StaleReason, string> = {
  missing: "no longer there",
  modified: "changed on disk since the scan",
  protected: "now in a library nothing may be deleted from"
};

function StaleNotice({ problems }: { problems: MemberCheck[] }) {
  return (
    <MessageBox tone="warning" title="These have changed since the scan">
      <p>
        Nothing will be removed while this is true — the whole set is refused rather than the part that still
        matches, so no photo is ever deleted without the copy that was meant to survive it. Scan again to pick
        the change up.
      </p>
      <ul>
        {problems.map((problem) => (
          <li key={problem.memberId}>
            <TriangleAlert size={12} aria-hidden="true" /> {problem.path}
            {" — "}{problem.stale ? STALE_WORDS[problem.stale] : "no longer usable"}
          </li>
        ))}
      </ul>
    </MessageBox>
  );
}