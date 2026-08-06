// The top of the Duplicate cleanup page: the standing header, and the card for the
// one job that may be active. Both are told what to show and what their buttons do —
// the page owns every request.
import type { ReactNode } from "react";
import {
  CircleCheck, FlaskConical, Lock, RefreshCw, Search, Sparkles, Trash2, TriangleAlert
} from "lucide-react";
import { formatBytes } from "../../../../shared/utils";
import { MessageBox } from "../../../../shared/MessageBox";
import { Button } from "../../../../shared/Button";
import { formatWhen } from "./shared";
import { cleanupKindSummary, STATUS_WORDS, type DuplicateJob } from "./cleanup-types";

export function CleanupHero() {
  return (
    <section className="dup-cleanup-hero" aria-labelledby="dup-cleanup-title">
      <div className="dup-cleanup-hero-main">
        <span className="dup-cleanup-hero-icon" aria-hidden="true">
          <Trash2 size={54} />
        </span>
        <div className="dup-cleanup-hero-copy">
          <h1 id="dup-cleanup-title">Duplicate cleanup</h1>
          <p>One saved cleanup at a time: choose what to compare, scan once, and work through it whenever you like.</p>

          <div className="dup-cleanup-experiment">
            <div className="dup-cleanup-experiment-label" tabIndex={0}>
              <FlaskConical size={20} aria-hidden="true" />
              <strong>Experimental</strong>
            </div>
            <div className="dup-cleanup-experiment-card" role="status">
              <TriangleAlert size={28} aria-hidden="true" />
              <p>
                Duplicate detection is still being proven. Check sets before deleting. Items go to the Recycle Bin and
                can be restored until emptied.
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
  const included = job.libraries.filter((library) => library.included);
  // A library that changed under the job. Worth saying: the results were worked out
  // when it was something else.
  const changed = job.libraries.filter((library) =>
    !library.missing && (library.mode !== library.currentMode || library.isProtected !== library.currentlyProtected));
  const canScan = job.status === "draft" || job.status === "review";
  const scanning = job.status === "scanning";
  const scopeTitle = `${included.length} librar${included.length === 1 ? "y" : "ies"} • ${cleanupKindSummary(job.duplicateType)}`;

  return (
    <div className="dup-job-card">
      <div className="dup-job-title-row">
        <div className="dup-job-card-body">
          <p className="eyebrow">{STATUS_WORDS[job.status]}</p>
          <h2>{scopeTitle}</h2>
          <p className="datagrid-muted">
            Started by {job.ownerName} • last touched {formatWhen(job.lastActivityAt)}
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
                <Lock size={14} aria-hidden="true" /> {job.ownerName} is working on this
              </span>
              <Button variant="secondary" compact disabled={busy} onClick={onTakeOver}>Take over</Button>
              <Button variant="secondary" danger compact disabled={busy} onClick={onCancel}>Cancel</Button>
            </>
          ) : (
            <>
              {canScan && (
                <Button variant="primary" compact className="dup-job-scan-action" disabled={busy} onClick={onScan}>
                  <RefreshCw size={18} aria-hidden="true" />
                  <span>{job.status === "draft" ? "Run scan" : "Scan again"}</span>
                </Button>
              )}
              <Button variant="secondary" compact disabled={busy || scanning} onClick={onFinish}>Finish</Button>
              <Button variant="secondary" danger compact disabled={busy} onClick={onCancel}>Cancel</Button>
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
              aria-label="Fingerprinting progress"
            />
          </div>
          <p className="datagrid-muted">
            {job.scanProgress === 0
              ? "Waiting to start — a library or face scan is using the disk. This carries on without you."
              : `Fingerprinting photos… ${job.scanProgress}%. This carries on if you close the page.`}
          </p>
        </div>
      )}

      <div className="dup-job-metrics" aria-label="Cleanup job summary">
        <JobMetric icon={<Search size={22} />} value={job.totals.results} label="found" />
        <JobMetric icon={<Trash2 size={22} />} value={job.totals.reviewed} label="looked at" />
        <JobMetric icon={<CircleCheck size={22} />} value={job.totals.deleted} label="removed" />
        <JobMetric icon={<Sparkles size={22} />} value={formatBytes(job.totals.reclaimableBytes)} label="to reclaim" strong />
        {job.totals.errors > 0 && (
          <JobMetric icon={<TriangleAlert size={22} />} value={job.totals.errors} label="with problems" />
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
