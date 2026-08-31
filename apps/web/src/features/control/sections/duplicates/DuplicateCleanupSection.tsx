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
import { Trans, useTranslation } from "react-i18next";
import { Briefcase, Search, SlidersHorizontal, Trash2, TriangleAlert } from "lucide-react";
import { api, ApiError, type PublicUser } from "../../../../api";
import { formatBytes } from "../../../../shared/utils";
import { MessageBox } from "../../../../shared/MessageBox";
import { Button } from "../../../../shared/Button";
import { Modal } from "../../../../shared/Modal";
import { ConfirmDialog } from "../../../../shared/ConfirmDialog";
import { Pager } from "../../../../shared/Pager";
import { SelectMenu } from "../../../../shared/SelectMenu";
import { SortMenu } from "../../../../shared/SortMenu";
import { controlHref } from "../../../../router";
import { CleanupHero, JobCard } from "./CleanupJobCard";
import { CleanupWizard } from "./CleanupWizard";
import { CleanupResultCard } from "./CleanupResultCard";
import {
  EMPTY_PAYLOAD, EMPTY_RESULTS, RESULT_SECTIONS, folderLabel,
  keeperFolders, reviewFilters, sectionHeading, sectionQuery, sortOrders, typeFilters,
  type DuplicateJob, type JobsPayload, type MemberCheck, type ResultCheck, type ResultsPage,
  type SnapshotResult, type StaleReason
} from "./cleanup-types";

export function DuplicateCleanupSection({ currentUser }: { currentUser: PublicUser }) {
  const { t } = useTranslation(["common", "controlDash"]);
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
  // Order within each section; the sections themselves hold. "size" is what the
  // page has always shown and stays the default.
  const [sortOrder, setSortOrder] = useState<"size" | "copies">("size");
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
    if (sortOrder !== "size") params.set("sort", sortOrder);
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
      .catch((err) => setError(err instanceof Error ? err.message : t("controlDash:dupes.loadFailed")))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!job || job.status === "draft") { setResults(EMPTY_RESULTS); return; }
    const handle = window.setTimeout(() => {
      loadResults(job.id).catch((err) =>
        setError(err instanceof Error ? err.message : t("controlDash:dupes.resultsFailed")));
    }, search ? 250 : 0);
    return () => window.clearTimeout(handle);
  }, [job?.id, job?.status, job?.scanCompletedAt, search, typeFilter, reviewFilter, sortOrder, page]);

  useEffect(() => { setPage(1); }, [search, typeFilter, reviewFilter, sortOrder]);

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
      setActionError(err instanceof Error ? err.message : t("controlDash:dupes.removeCopiesFailed"));
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

  /** Move one copy between keep and delete, and patch the card where it stands.
   *
   *  Everything else on this page reloads after it acts, which is right when a card
   *  leaves the list. This one stays, and reloading would MOVE it: reclaimable bytes are
   *  part of the results ordering, so the set someone just clicked slides to wherever
   *  its new total belongs while the scroll position stays put — and the next click
   *  lands on a different set. So the reply carries just this result, and it is swapped
   *  in at its own index. The list re-sorts on the next real load, not under the hand
   *  that is working it.
   */
  const setMemberRole = async (
    result: SnapshotResult, memberId: string, role: "keep" | "delete"
  ) => {
    if (!job) return;
    setBusyId(result.id);
    setActionError("");
    try {
      const params = new URLSearchParams(resultQuery());
      const answer = await api<{
        result: SnapshotResult | null; sweep: ResultsPage["sweep"]; job: DuplicateJob;
      }>(
        `/api/library/gallery/duplicate-jobs/${job.id}/results/${result.id}/members/${memberId}/role?${params}`,
        { method: "POST", body: JSON.stringify({ role }) }
      );
      setResults((current) => ({
        ...current,
        results: current.results.map((row) =>
          (row.id === result.id && answer.result ? answer.result : row)),
        sweep: answer.sweep
      }));
      setPayload((current) => ({ ...current, activeJob: answer.job }));
    } catch (err) {
      setActionError(err instanceof Error
        ? err.message
        : role === "keep" ? t("controlDash:dupes.keepFailed") : t("controlDash:dupes.markDeleteFailed"));
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
                <p className="eyebrow">{t("controlDash:dupes.noActiveEyebrow")}</p>
                <h2>{t("controlDash:dupes.noActiveTitle")}</h2>
                <p className="dup-note">
                  {t("controlDash:dupes.noActiveNote")}
                </p>
                <p className="dup-note">
                  {worthChecking === 0
                    ? t("controlDash:dupes.nothingToClean")
                    : t("controlDash:dupes.worthChecking", { count: worthChecking })}
                </p>
              </div>
            </div>
            <Button variant="primary" onClick={() => { setActionError(""); setWizardOpen(true); }}>
              {t("controlDash:dupes.startCleanup")}
            </Button>
          </div>
        )}

        {job && (
          <JobCard
            job={job}
            isOwner={payload.isOwner}
            busy={busy}
            onScan={() => void post(`/api/library/gallery/duplicate-jobs/${job.id}/scan`, job.id, t("controlDash:dupes.scanFailed"))}
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
              <span>{narrowed ? t("controlDash:dupes.filtersOn") : t("controlDash:dupes.filters")}</span>
            </Button>
            {/* Order within each section — the sections (folders before files,
                certain before uncertain) hold either way. */}
            <SortMenu
              value={sortOrder}
              options={sortOrders()}
              presentation="labelled"
              ariaLabel={t("controlDash:dupes.orderResults")}
              onChange={(value) => setSortOrder(value as "size" | "copies")}
            />
            <label className="search-field dup-folder-search">
              <Search size={17} aria-hidden="true" />
              <span className="sr-only">{t("controlDash:dupes.searchSr")}</span>
              <input
                type="search"
                value={search}
                placeholder={t("controlDash:dupes.searchPlaceholder")}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="dup-toolbar-controls">
              <span className="datagrid-muted">
                {t("controlDash:dupes.shownOf", { shown: results.total, all: results.allResults })}
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
                  <span>{t("controlDash:dupes.sweepButton", { count: results.sweep.copies })}</span>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {error && <MessageBox tone="error" title={t("controlDash:dupes.loadFailed")}>{error}</MessageBox>}
      {actionError && !confirm && !dismissing && (
        <MessageBox tone="error" title={t("common:errors.actionFailed")}>{actionError}</MessageBox>
      )}

      {job && job.status === "draft" && (
        <MessageBox tone="info" title={t("controlDash:dupes.nothingScannedTitle")}>
          {t("controlDash:dupes.nothingScannedBody")}
        </MessageBox>
      )}

      {job && job.status !== "draft" && job.status !== "scanning" && results.allResults === 0 && (
        unread > 0 ? (
          <MessageBox tone="warning" title={t("controlDash:dupes.unreadTitle")}>
            {t("controlDash:dupes.unreadBody", { count: unread })}
          </MessageBox>
        ) : (
          <p className="management-empty">
            {t("controlDash:dupes.nothingFound")}
          </p>
        )
      )}

      {job && results.allResults > 0 && results.total === 0 && (
        <p className="management-empty">{t("controlDash:dupes.noMatches")}</p>
      )}

      {grouped.map((group) => (
        <div key={group.section.key}>
          <h2 className="dup-tier-heading">{sectionHeading(group.section.key).title}</h2>
          <p className="dup-tier-note">{sectionHeading(group.section.key).note}</p>
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
                    t("controlDash:dupes.skipFailed"),
                    { mark: result.reviewStatus === "skipped" ? "unreviewed" : "skipped" }
                  ),
                  onDismiss: () => { setActionError(""); setDismissing(result); },
                  onDelete: () => { setActionError(""); setConfirm(result); },
                  // Not confirmed: it changes what a later Delete would take, and
                  // changes nothing about the photos themselves. The confirm belongs on
                  // the deletion, which already has one.
                  onSetRole: (memberId, role) => void setMemberRole(result, memberId, role)
                }}
              />
            ))}
          </div>
        </div>
      ))}

      {results.total > results.perPage && (
        <div className="dup-pager-row">
          <span className="datagrid-muted">
            {t("controlDash:dupes.showingRange", {
              from: (results.page - 1) * results.perPage + 1,
              to: Math.min(results.page * results.perPage, results.total),
              total: results.total
            })}
          </span>
          <Pager page={results.page} totalPages={totalPages} onChange={setPage} label={t("controlDash:pagers.cleanupResults")} />
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
        <Modal title={t("controlDash:dupes.narrowTitle")} onClose={() => setFiltersOpen(false)}>
          <div className="dup-filter-form">
            <label className="dup-filter-field">
              <span className="dup-filter-label">{t("controlDash:dupes.kindOfResult")}</span>
              <SelectMenu
                value={typeFilter}
                options={typeFilters(job?.duplicateType ?? "folders")}
                label={t("controlDash:dupes.kindOfResult")}
                onChange={setTypeFilter}
              />
            </label>
            <label className="dup-filter-field">
              <span className="dup-filter-label">{t("controlDash:dupes.whereGotTo")}</span>
              <SelectMenu value={reviewFilter} options={reviewFilters()} label={t("controlDash:dupes.reviewState")} onChange={setReviewFilter} />
            </label>
          </div>
          <div className="modal-actions">
            <Button
              variant="text"
              disabled={!narrowed}
              onClick={() => { setSearch(""); setTypeFilter(""); setReviewFilter(""); }}
            >
              {t("controlDash:dupes.clearFilters")}
            </Button>
            <Button variant="secondary" onClick={() => setFiltersOpen(false)}>{t("common.done")}</Button>
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
            title={t("controlDash:dupes.deleteCopiesTitle", { count: doomed.length })}
            confirmLabel={t("controlDash:dupes.deleteCopiesLabel", { count: doomed.length })}
            busyLabel={t("controlDash:dupes.deleting")}
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
            {checking && <p className="datagrid-muted">{t("controlDash:dupes.checkingStill")}</p>}
            {stale.length > 0 && <StaleNotice problems={stale} />}
            <p>
              <Trans
                i18nKey="dupes.deleteBody1"
                ns="controlDash"
                count={doomed.length}
                values={{ place: survivesIn }}
                components={{ bold: <strong /> }}
              />
            </p>
            <p>
              {t("controlDash:dupes.deleteBody2")}
            </p>
            <p>
              {t("controlDash:dupes.deleteBody3")}
              {leavesFolder ? t("controlDash:dupes.deleteBody3Folder") : ""}
            </p>
          </ConfirmDialog>
        );
      })()}

      {dismissing && (
        <ConfirmDialog
          title={t("controlDash:dupes.dismissTitle")}
          confirmLabel={t("controlDash:dupes.dismissConfirm")}
          busyLabel={t("controlDash:dupes.saving")}
          busy={busyId === dismissing.id}
          error={actionError}
          onConfirm={async () => {
            const ok = await post(
              `/api/library/gallery/duplicate-jobs/${job!.id}/results/${dismissing.id}/dismiss`,
              dismissing.id,
              t("controlDash:dupes.dismissFailed")
            );
            if (ok) setDismissing(null);
          }}
          onCancel={() => { setDismissing(null); setActionError(""); }}
          rich
        >
          <p>
            {t("controlDash:dupes.dismissBody1")}
          </p>
          <p>
            <Trans i18nKey="dupes.dismissBody2" ns="controlDash" components={{ bold: <strong /> }} />
          </p>
        </ConfirmDialog>
      )}

      {sweeping && job && (
        <ConfirmDialog
          title={t("controlDash:dupes.sweepTitle", { count: results.sweep.copies })}
          confirmLabel={t("controlDash:dupes.sweepConfirm", { count: results.sweep.copies })}
          busyLabel={t("controlDash:dupes.deleting")}
          danger
          busy={busyId === job.id}
          error={actionError}
          onConfirm={async () => {
            const ok = await post(
              `/api/library/gallery/duplicate-jobs/${job.id}/results/sweep?${resultQuery()}`,
              job.id,
              t("controlDash:dupes.sweepFailed")
            );
            if (ok) setSweeping(false);
          }}
          onCancel={() => { setSweeping(false); setActionError(""); }}
          rich
        >
          <p>
            <Trans
              i18nKey="dupes.sweepBody1"
              ns="controlDash"
              count={results.sweep.results}
              values={{ bytes: formatBytes(results.sweep.bytes) }}
              components={{ bold: <strong /> }}
            />
          </p>
          <p>
            <Trans i18nKey="dupes.sweepBody2" ns="controlDash" components={{ bold: <strong /> }} />
          </p>
          {narrowed && (
            <p>
              {t("controlDash:dupes.sweepBody3", { shown: results.total, all: results.allResults })}
            </p>
          )}
          <p>
            {t("controlDash:dupes.sweepBody4")}
          </p>
        </ConfirmDialog>
      )}

      {finishing && job && (
        <ConfirmDialog
          title={t("controlDash:dupes.finishTitle")}
          confirmLabel={t("controlDash:dupes.finishConfirm")}
          busyLabel={t("controlDash:dupes.finishing")}
          busy={busyId === job.id}
          error={actionError}
          onConfirm={async () => {
            const ok = await post(`/api/library/gallery/duplicate-jobs/${job.id}/complete`, job.id, t("controlDash:dupes.finishFailed"));
            if (ok) setFinishing(false);
          }}
          onCancel={() => setFinishing(false)}
          rich
        >
          <p>
            {t("controlDash:dupes.finishBody1", { count: job.totals.deleted, bytes: formatBytes(job.totals.reclaimedBytes) })}
          </p>
          <p>
            {job.totals.remaining > 0
              ? t("controlDash:dupes.finishBody2", { count: job.totals.remaining })
              : t("controlDash:dupes.finishBodyNone")}
          </p>
        </ConfirmDialog>
      )}

      {takingOver && job && (
        <ConfirmDialog
          title={t("controlDash:dupes.takeOverTitle", { name: job.ownerName })}
          confirmLabel={t("controlDash:dupes.takeOverConfirm")}
          busyLabel={t("controlDash:dupes.takingOver")}
          busy={busyId === job.id}
          error={actionError}
          onConfirm={async () => {
            const ok = await post(
              `/api/library/gallery/duplicate-jobs/${job.id}/reassign`,
              job.id,
              t("controlDash:dupes.takeOverFailed"),
              { userId: currentUser.id }
            );
            if (ok) setTakingOver(false);
          }}
          onCancel={() => setTakingOver(false)}
          rich
        >
          <p>
            {t("controlDash:dupes.takeOverBody1", { name: job.ownerName })}
          </p>
          <p>
            {t("controlDash:dupes.takeOverBody2")}
          </p>
        </ConfirmDialog>
      )}

      {cancelling && job && (
        <ConfirmDialog
          title={t("controlDash:dupes.cancelTitle")}
          confirmLabel={t("controlDash:dupes.cancelConfirm")}
          busyLabel={t("controlDash:dupes.cancelling")}
          danger
          busy={busyId === job.id}
          error={actionError}
          onConfirm={async () => {
            const ok = await post(`/api/library/gallery/duplicate-jobs/${job.id}/cancel`, job.id, t("controlDash:dupes.cancelFailed"));
            if (ok) setCancelling(false);
          }}
          onCancel={() => setCancelling(false)}
          rich
        >
          <p>
            {t("controlDash:dupes.cancelBody1")}
          </p>
          <p>{t("controlDash:dupes.cancelBody2")}</p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** Shown when a result's copies have moved on since the scan. */
// Each reason gets its own words because each has its own remedy: re-scan, look at the
// file, or change the library's settings. "Something changed" sends someone hunting.
const STALE_KEY: Record<StaleReason, "staleMissing" | "staleModified" | "staleProtected"> = {
  missing: "staleMissing",
  modified: "staleModified",
  protected: "staleProtected"
};

function StaleNotice({ problems }: { problems: MemberCheck[] }) {
  const { t } = useTranslation(["common", "controlDash"]);
  return (
    <MessageBox tone="warning" title={t("controlDash:dupes.staleTitle")}>
      <p>
        {t("controlDash:dupes.staleBody")}
      </p>
      <ul>
        {problems.map((problem) => (
          <li key={problem.memberId}>
            <TriangleAlert size={12} aria-hidden="true" /> {problem.path}
            {" — "}{problem.stale ? t(`controlDash:dupes.${STALE_KEY[problem.stale]}`) : t("controlDash:dupes.staleUnusable")}
          </li>
        ))}
      </ul>
    </MessageBox>
  );
}