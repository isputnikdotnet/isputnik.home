import { useState, useEffect, useCallback, useRef } from "react";
import { Trans, useTranslation } from "react-i18next";
import { CalendarClock, CheckCircle2, Info, Play, XCircle } from "lucide-react";
import { api } from "../../../api";
import { controlHref, followRoute } from "../../../router";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { ControlSectionHead } from "../ControlSectionHead";
import { ToggleSwitch } from "../../../shared/ToggleSwitch";
import { formatManagedDate } from "../../../shared/utils";

type Frequency = "daily" | "weekly" | "monthly";
type Category = "audiobooks" | "ebooks" | "gallery" | "system";

interface ScheduledJob {
  key: string;
  label: string;
  description: string;
  category: Category;
  enabled: boolean;
  frequency: Frequency;
  time: string; // local clock time the job runs at, e.g. "01:00"
  dayOfWeek: number; // 0=Sunday..6=Saturday, used when frequency is weekly
  dayOfMonth: number; // 1..28, used when frequency is monthly
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | null;
  lastMessage: string | null;
}

// What a manual run is doing right now. `taskIds` is empty for jobs that finish
// inside the request (emptying the bin); the rest queue work that outlives it.
interface RunState {
  jobKey: string;
  label: string;
  message: string;
  taskIds: string[];
  phase: "working" | "done" | "failed";
}

const WEEKDAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

const CATEGORY_LABEL_KEYS: Record<Category, "catAudiobooks" | "catEbooks" | "catGallery" | "catSystem"> = {
  audiobooks: "catAudiobooks",
  ebooks: "catEbooks",
  gallery: "catGallery",
  system: "catSystem"
};

const POLL_MS = 2000;

export function ScheduledJobsSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [error, setError] = useState("");
  const [run, setRun] = useState<RunState | null>(null);

  const load = useCallback(async () => {
    const payload = await api<{ jobs: ScheduledJob[] }>("/api/scheduled-jobs");
    setJobs(payload.jobs);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:scheduledJobs.loadFailed")));
  }, [load]);

  // Follow the tasks a manual run queued until every one of them has left the
  // queue — that, not the POST returning, is when the work is actually finished.
  const runRef = useRef<RunState | null>(null);
  runRef.current = run;
  useEffect(() => {
    if (!run || run.phase !== "working" || run.taskIds.length === 0) return;
    const timer = window.setInterval(() => {
      api<{ tasks: { id: string; status: string }[] }>(`/api/jobs/status?ids=${run.taskIds.join(",")}`)
        .then((payload) => {
          const active = payload.tasks.filter((task) => task.status === "pending" || task.status === "running");
          if (active.length > 0) return;
          const failed = payload.tasks.filter((task) => task.status === "failed").length;
          const current = runRef.current;
          if (!current || current.jobKey !== run.jobKey) return;
          setRun({
            ...current,
            phase: failed > 0 ? "failed" : "done",
            message: failed > 0
              ? t("controlAdmin:scheduledJobs.tasksFailed", { failed, count: run.taskIds.length })
              : t("controlAdmin:scheduledJobs.tasksFinished", { count: run.taskIds.length })
          });
          void load().catch(() => undefined);
        })
        .catch(() => { /* keep polling — a blip shouldn't strand the notice */ });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [run, load]);

  const startRun = async (job: ScheduledJob) => {
    setError("");
    setRun({ jobKey: job.key, label: job.label, message: t("controlAdmin:scheduledJobs.starting"), taskIds: [], phase: "working" });
    try {
      const result = await api<{ taskIds: string[]; job: ScheduledJob }>(
        `/api/scheduled-jobs/${job.key}/run`,
        { method: "POST", body: "{}" }
      );
      await load();
      setRun({
        jobKey: job.key,
        label: job.label,
        // The job's own summary is the useful sentence — "Queued a scan for 3
        // libraries", "Purged 12 photos" — so lead with it.
        message: result.job?.lastMessage ?? t("controlAdmin:scheduledJobs.finished"),
        taskIds: result.taskIds ?? [],
        // No queued tasks means the work happened inside the request: already done.
        phase: (result.taskIds ?? []).length === 0 ? "done" : "working"
      });
    } catch (err) {
      setRun(null);
      setError(err instanceof Error ? err.message : t("controlAdmin:scheduledJobs.runFailed"));
      await load().catch(() => undefined);
    }
  };

  const busyKey = run?.phase === "working" ? run.jobKey : null;

  return (
    <>
      <ControlSectionHead section="scheduledJobs">
        <RefreshButton
          onRefresh={async () => {
            setError("");
            try {
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : t("controlAdmin:scheduledJobs.refreshFailed"));
              throw err;
            }
          }}
        />
      </ControlSectionHead>

      <p className="scheduled-jobs-intro muted">
        <Trans i18nKey="scheduledJobs.intro" ns="controlAdmin" components={{ bold: <strong /> }} />
      </p>

      {error && <MessageBox tone="error" title={t("controlAdmin:scheduledJobs.errorTitle")}>{error}</MessageBox>}

      {run && (
        <MessageBox
          tone={run.phase === "working" ? "info" : run.phase === "failed" ? "warning" : "success"}
          title={
            run.phase === "working"
              ? t("controlAdmin:scheduledJobs.runningTitle", { label: run.label })
              : run.phase === "failed"
                ? t("controlAdmin:scheduledJobs.finishedWithErrorsTitle", { label: run.label })
                : t("controlAdmin:scheduledJobs.finishedTitle", { label: run.label })
          }
        >
          {run.message}
          {run.taskIds.length > 0 && (
            <>
              {" "}
              <a href={`${controlHref("dashboard")}?view=tasks`} onClick={(event) => followRoute(event, `${controlHref("dashboard")}?view=tasks`)}>
                {run.phase === "working" ? t("controlAdmin:scheduledJobs.watchProgress") : t("controlAdmin:scheduledJobs.seeOnTasks")}
              </a>
              .
            </>
          )}
        </MessageBox>
      )}

      <div className="datagrid-wrap scheduled-jobs-wrap">
        <table className="datagrid scheduled-jobs-table">
          <thead>
            <tr>
              <th scope="col">{t("controlAdmin:scheduledJobs.thJob")}</th>
              <th scope="col">{t("controlAdmin:scheduledJobs.thSchedule")}</th>
              <th scope="col">{t("controlAdmin:scheduledJobs.thRun")}</th>
              <th scope="col" className="scheduled-col-enabled">{t("controlAdmin:scheduledJobs.thEnabled")}</th>
              <th scope="col" className="scheduled-col-actions">{t("controlAdmin:scheduledJobs.thActions")}</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <ScheduledJobRow
                key={job.key}
                job={job}
                running={busyKey === job.key}
                anyRunning={busyKey !== null}
                onChanged={load}
                onError={setError}
                onRun={() => startRun(job)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {jobs.length === 0 && <p className="management-empty">{t("controlAdmin:scheduledJobs.empty")}</p>}
    </>
  );
}

function ScheduledJobRow({
  job,
  running,
  anyRunning,
  onChanged,
  onError,
  onRun
}: {
  job: ScheduledJob;
  running: boolean;
  anyRunning: boolean;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  onRun: () => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [saving, setSaving] = useState(false);

  // Every control writes straight through — the row has no Save button, so an
  // edit that only lived in local state would silently not happen. The server's
  // answer is then reloaded, which is what recomputes "next run".
  const save = async (patch: Partial<Pick<ScheduledJob, "enabled" | "frequency" | "time" | "dayOfWeek" | "dayOfMonth">>) => {
    setSaving(true);
    onError("");
    try {
      await api(`/api/scheduled-jobs/${job.key}`, {
        method: "PATCH",
        body: JSON.stringify({
          enabled: job.enabled,
          frequency: job.frequency,
          time: job.time,
          dayOfWeek: job.dayOfWeek,
          dayOfMonth: job.dayOfMonth,
          ...patch
        })
      });
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : t("controlAdmin:scheduledJobs.saveFailed"));
      await onChanged().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  const controlsDisabled = saving || running;

  return (
    <tr className={job.enabled ? undefined : "scheduled-row-off"}>
      <td>
        <div className="scheduled-job-name">
          <span>{job.label}</span>
          <span className="scheduled-job-info" title={job.description}>
            <Info size={15} aria-hidden="true" />
            <span className="sr-only">{job.description}</span>
          </span>
        </div>
        <span className={`scheduled-job-chip ${job.category}`}>{t(`controlAdmin:scheduledJobs.${CATEGORY_LABEL_KEYS[job.category]}`)}</span>
      </td>

      <td>
        <div className="scheduled-job-schedule">
          <select
            value={job.frequency}
            disabled={controlsDisabled}
            aria-label={t("controlAdmin:scheduledJobs.ariaFrequency", { label: job.label })}
            onChange={(e) => void save({ frequency: e.target.value as Frequency })}
          >
            <option value="daily">{t("controlAdmin:scheduledJobs.freqDaily")}</option>
            <option value="weekly">{t("controlAdmin:scheduledJobs.freqWeekly")}</option>
            <option value="monthly">{t("controlAdmin:scheduledJobs.freqMonthly")}</option>
          </select>
          {job.frequency === "weekly" && (
            <select
              value={job.dayOfWeek}
              disabled={controlsDisabled}
              aria-label={t("controlAdmin:scheduledJobs.ariaDayOfWeek", { label: job.label })}
              onChange={(e) => void save({ dayOfWeek: Number(e.target.value) })}
            >
              {WEEKDAY_KEYS.map((key, i) => (
                <option key={key} value={i}>{t(`controlAdmin:scheduledJobs.${key}`)}</option>
              ))}
            </select>
          )}
          {job.frequency === "monthly" && (
            <select
              value={job.dayOfMonth}
              disabled={controlsDisabled}
              aria-label={t("controlAdmin:scheduledJobs.ariaDayOfMonth", { label: job.label })}
              onChange={(e) => void save({ dayOfMonth: Number(e.target.value) })}
            >
              {MONTH_DAYS.map((day) => (
                <option key={day} value={day}>{t("controlAdmin:scheduledJobs.dayN", { day })}</option>
              ))}
            </select>
          )}
          <input
            type="time"
            value={job.time}
            disabled={controlsDisabled}
            aria-label={t("controlAdmin:scheduledJobs.ariaTime", { label: job.label })}
            onChange={(e) => { if (e.target.value) void save({ time: e.target.value }); }}
          />
        </div>
      </td>

      <td>
        <div className="scheduled-job-runs">
          {job.lastRunAt ? (
            <span
              className={`scheduled-job-run-line ${job.lastStatus ?? ""}`}
              title={job.lastMessage ?? undefined}
            >
              {job.lastStatus === "error"
                ? <XCircle size={15} aria-hidden="true" />
                : <CheckCircle2 size={15} aria-hidden="true" />}
              <span>{formatManagedDate(job.lastRunAt)}</span>
            </span>
          ) : (
            <span className="scheduled-job-run-line muted">{t("controlAdmin:scheduledJobs.neverRun")}</span>
          )}
          {job.enabled && job.nextRunAt ? (
            <span className="scheduled-job-run-line muted" title={t("controlAdmin:scheduledJobs.nextRun")}>
              <CalendarClock size={15} aria-hidden="true" />
              <span>{formatManagedDate(job.nextRunAt)}</span>
            </span>
          ) : (
            <span className="scheduled-job-run-line muted">
              <CalendarClock size={15} aria-hidden="true" />
              <span>{t("controlAdmin:scheduledJobs.notScheduled")}</span>
            </span>
          )}
        </div>
      </td>

      <td className="scheduled-col-enabled">
        <ToggleSwitch
          checked={job.enabled}
          disabled={controlsDisabled}
          onChange={(next) => void save({ enabled: next })}
          ariaLabel={job.enabled ? t("controlAdmin:scheduledJobs.ariaToggleOn", { label: job.label }) : t("controlAdmin:scheduledJobs.ariaToggleOff", { label: job.label })}
        />
      </td>

      <td className="scheduled-col-actions">
        <Button
          variant="icon"
          onClick={onRun}
          // One at a time: these jobs queue heavy work and several skip themselves
          // when another is already running, which would look like a dead button.
          disabled={saving || anyRunning}
          aria-label={running ? t("controlAdmin:scheduledJobs.runningAria", { label: job.label }) : t("controlAdmin:scheduledJobs.runNowAria", { label: job.label })}
          title={running ? t("controlAdmin:scheduledJobs.running") : t("controlAdmin:scheduledJobs.runNow")}
        >
          {running
            ? <span className="icon-spin" aria-hidden="true"><Play size={16} /></span>
            : <Play size={16} aria-hidden="true" />}
        </Button>
      </td>
    </tr>
  );
}
