// The top of the Duplicate cleanup page: the standing header, and the card for the
// one job that may be active. Both are told what to show and what their buttons do —
// the page owns every request.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  CircleCheck, FlaskConical, Lock, RefreshCw, Search, Sparkles, Trash2, TriangleAlert
} from "lucide-react";
import { formatBytes } from "../../../../shared/utils";
import { MessageBox } from "../../../../shared/MessageBox";
import { Button } from "../../../../shared/Button";
import { formatWhen } from "./shared";
import { cleanupKindSummary, statusWord, type DuplicateJob } from "./cleanup-types";

export function CleanupHero() {
  const { t } = useTranslation(["common", "controlDash"]);
  return (
    <section className="dup-cleanup-hero" aria-labelledby="dup-cleanup-title">
      <div className="dup-cleanup-hero-main">
        <span className="dup-cleanup-hero-icon" aria-hidden="true">
          <Trash2 size={54} />
        </span>
        <div className="dup-cleanup-hero-copy">
          <h1 id="dup-cleanup-title">{t("controlDash:dupes.heroTitle")}</h1>
          <p>{t("controlDash:dupes.heroIntro")}</p>

          <div className="dup-cleanup-experiment">
            <div className="dup-cleanup-experiment-label" tabIndex={0}>
              <FlaskConical size={20} aria-hidden="true" />
              <strong>{t("controlDash:dupes.experimental")}</strong>
            </div>
            <div className="dup-cleanup-experiment-card" role="status">
              <TriangleAlert size={28} aria-hidden="true" />
              <p>
                {t("controlDash:dupes.experimentalNote")}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function JobMetric({
  icon, value, label, strong = false
}: {
  icon: ReactNode;
  value: string | number;
  label?: string;
  strong?: boolean;
}) {
  return (
    <div className={`dup-job-metric${strong ? " is-strong" : ""}`}>
      <span className="dup-job-metric-icon" aria-hidden="true">{icon}</span>
      <span className="dup-job-metric-copy">
        <strong>{value}</strong>
        {label && <small>{label}</small>}
      </span>
    </div>
  );
}

export function JobCard({
  job, isOwner, busy, onScan, onFinish, onCancel, onTakeOver
}: {
  job: DuplicateJob;
  isOwner: boolean;
  busy: boolean;
  onScan: () => void;
  onFinish: () => void;
  onCancel: () => void;
  /** Any admin may take a cleanup over — see the note on the non-owner branch. */
  onTakeOver: () => void;
}) {
  const { t } = useTranslation(["common", "controlDash"]);
  const included = job.libraries.filter((library) => library.included);
  // A library that changed under the job. Worth saying: the results were worked out
  // when it was something else.
  const changed = job.libraries.filter((library) =>
    !library.missing && (library.mode !== library.currentMode || library.isProtected !== library.currentlyProtected));
  const canScan = job.status === "draft" || job.status === "review";
  const scanning = job.status === "scanning";
  const scopeTitle = t("controlDash:dupes.scopeTitle", {
    libraries: t("controlDash:libs.libraryCount", { count: included.length }),
    kind: cleanupKindSummary(job.duplicateType)
  });

  return (
    <div className="dup-job-card">
      <div className="dup-job-title-row">
        <div className="dup-job-card-body">
          <p className="eyebrow">{statusWord(job.status)}</p>
          <h2>{scopeTitle}</h2>
          <p className="datagrid-muted">
            {t("controlDash:dupes.startedBy", { name: job.ownerName, when: formatWhen(job.lastActivityAt) })}
          </p>
          {job.statusDetail && <p className="datagrid-muted">{job.statusDetail}</p>}
        </div>

        <div className="dup-job-actions">
          {!isOwner ? (
            /* Locked, but not stuck. Only one cleanup can be active install-wide, so a
               cleanup whose owner has gone would hold the slot for ever — which is why
               the server has always let ANY admin retire or reassign one, and why the
               two ways out are offered here rather than left to the API. Working the
               job stays the owner's: to act on results you take it over first. */
            <>
              <span className="datagrid-muted dup-job-owner-note">
                <Lock size={14} aria-hidden="true" /> {t("controlDash:dupes.workingOnThis", { name: job.ownerName })}
              </span>
              <Button variant="secondary" compact disabled={busy} onClick={onTakeOver}>{t("controlDash:dupes.takeOver")}</Button>
              <Button variant="secondary" danger compact disabled={busy} onClick={onCancel}>{t("common.cancel")}</Button>
            </>
          ) : (
            <>
              {canScan && (
                <Button variant="primary" compact className="dup-job-scan-action" disabled={busy} onClick={onScan}>
                  <RefreshCw size={18} aria-hidden="true" />
                  <span>{job.status === "draft" ? t("controlDash:dupes.runScan") : t("controlDash:dupes.scanAgain")}</span>
                </Button>
              )}
              <Button variant="secondary" compact disabled={busy || scanning} onClick={onFinish}>{t("controlDash:dupes.finish")}</Button>
              <Button variant="secondary" danger compact disabled={busy} onClick={onCancel}>{t("common.cancel")}</Button>
            </>
          )}
        </div>
      </div>

      {/* The scan reads files now, so it can take a while on a library nobody has
          fingerprinted before. Shown here rather than in a modal on purpose: the bar
          says "this is running", not "wait here" — you can close the page and the pass
          carries on. At zero it is queued behind a library or face scan rather than
          stalled, and says so, because a bar sitting at 0% reads as broken. */}
      {scanning && (
        <div className="dup-job-scan">
          <div className="dup-job-scan-bar">
            <div
              className="dup-job-scan-fill"
              style={{ width: `${Math.max(job.scanProgress, 2)}%` }}
              role="progressbar"
              aria-valuenow={job.scanProgress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t("controlDash:dupes.fingerprintingAria")}
            />
          </div>
          <p className="datagrid-muted">
            {job.scanProgress === 0
              ? t("controlDash:dupes.waitingToStart")
              : t("controlDash:dupes.fingerprinting", { percent: job.scanProgress })}
          </p>
        </div>
      )}

      <div className="dup-job-metrics" aria-label={t("controlDash:dupes.jobSummaryAria")}>
        <JobMetric icon={<Search size={22} />} value={job.totals.results} label={t("controlDash:dupes.metricFound")} />
        <JobMetric icon={<Trash2 size={22} />} value={job.totals.reviewed} label={t("controlDash:dupes.metricLookedAt")} />
        <JobMetric icon={<CircleCheck size={22} />} value={job.totals.deleted} label={t("controlDash:dupes.metricRemoved")} />
        <JobMetric icon={<Sparkles size={22} />} value={formatBytes(job.totals.reclaimableBytes)} label={t("controlDash:dupes.metricToReclaim")} strong />
        {job.totals.errors > 0 && (
          <JobMetric icon={<TriangleAlert size={22} />} value={job.totals.errors} label={t("controlDash:dupes.metricWithProblems")} />
        )}
      </div>

      {changed.length > 0 && (
        <MessageBox tone="warning" title={t("controlDash:dupes.changedTitle")}>
          {t("controlDash:dupes.changedBody", { count: changed.length, names: changed.map((library) => library.name).join(", ") })}
        </MessageBox>
      )}
    </div>
  );
}
