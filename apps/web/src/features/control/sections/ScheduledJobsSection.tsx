import { useState, useEffect, useCallback, useRef } from "react";
import { Trans, useTranslation } from "react-i18next";
import { CalendarClock, CheckCircle2, Clock, XCircle } from "lucide-react";
import { api } from "../../../api";
import { controlHref, followRoute } from "../../../router";
import { ActionRow, GroupedList, InfoRow, NavRow, ToggleRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { PageBack, PageTitle, useQueryPage } from "../../../shared/useQueryPage";
import { ControlSectionHead } from "../ControlSectionHead";
import { JobScheduleRows, useScheduleSummary, type JobFrequency, type JobScheduleFields } from "../JobScheduleControls";
import { formatManagedDate } from "../../../shared/utils";

type Category = "audiobooks" | "ebooks" | "gallery" | "system";

interface ScheduledJob {
  key: string;
  label: string;
  description: string;
  category: Category;
  enabled: boolean;
  frequency: JobFrequency;
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

const CATEGORIES: Category[] = ["system", "gallery", "ebooks", "audiobooks"];
const CATEGORY_LABEL_KEYS: Record<Category, "catAudiobooks" | "catEbooks" | "catGallery" | "catSystem"> = {
  audiobooks: "catAudiobooks",
  ebooks: "catEbooks",
  gallery: "catGallery",
  system: "catSystem"
};

const POLL_MS = 2000;

// Infrastructure › Scheduled jobs, laid out like a phone's Settings (control panel
// v2): the jobs as rows grouped by what they look after, each saying when it runs;
// a job opens its own page (?show=<job key>) with its switch, schedule, last and
// next run, and Run now. Every change writes straight through.
export function ScheduledJobsSection() {
  const { t } = useTranslation(["common", "controlAdmin", "control"]);
  const [jobs, setJobs] = useState<ScheduledJob[] | null>(null);
  const [error, setError] = useState("");
  const [run, setRun] = useState<RunState | null>(null);
  const [saving, setSaving] = useState(false);
  const [show, go] = useQueryPage();
  const scheduleSummary = useScheduleSummary();

  const load = useCallback(async () => {
    const payload = await api<{ jobs: ScheduledJob[] }>("/api/scheduled-jobs");
    setJobs(payload.jobs);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:scheduledJobs.loadFailed")));
  }, [load, t]);

  // Follow the tasks a manual run queued until every one of them has left the
  // queue — that, not the POST returning, is when the work is actually finished.
  // Refreshed after the commit, not while rendering: the only reader is a poll tick
  // two seconds later, and this effect is written above the one that schedules it.
  const runRef = useRef<RunState | null>(null);
  useEffect(() => { runRef.current = run; });
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
  }, [run, load, t]);

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

  // Every control writes straight through; the server's answer is then reloaded,
  // which is what recomputes "next run".
  const save = async (job: ScheduledJob, patch: Partial<JobScheduleFields> & { enabled?: boolean }) => {
    setSaving(true);
    setError("");
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
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:scheduledJobs.saveFailed"));
      await load().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  const busyKey = run?.phase === "working" ? run.jobKey : null;

  const head = (
    <ControlSectionHead section="scheduledJobs" icon={<CalendarClock size={30} />}>
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
  );

  const notices = (
    <>
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
              <a href={controlHref("tasks")} onClick={(event) => followRoute(event, controlHref("tasks"))}>
                {run.phase === "working" ? t("controlAdmin:scheduledJobs.watchProgress") : t("controlAdmin:scheduledJobs.seeOnTasks")}
              </a>
              .
            </>
          )}
        </MessageBox>
      )}
    </>
  );

  if (!jobs) {
    return <>{head}{notices}{!error && <p className="muted">{t("controlAdmin:ui.loading")}</p>}</>;
  }

  // ── One job ────────────────────────────────────────────────────────────────
  if (show) {
    const job = jobs.find((candidate) => candidate.key === show);
    const back = <PageBack label={t("control:nav.tabs.scheduledJobs")} onBack={() => go(null)} />;
    if (!job) return <>{head}<div className="grouped-page">{back}<p className="muted">{t("controlAdmin:scheduledJobs.gone")}</p></div></>;
    const running = busyKey === job.key;
    return (
      <>
        {head}
        <div className="grouped-page">
          {back}
          <PageTitle>{job.label}</PageTitle>
          {notices}
          <GroupedList note={job.description}>
            <ToggleRow
              label={t("controlAdmin:scheduledJobs.onRow")}
              checked={job.enabled}
              disabled={saving || running}
              onChange={(next) => void save(job, { enabled: next })}
            />
          </GroupedList>
          {job.enabled && (
            <GroupedList title={t("controlAdmin:scheduledJobs.groupSchedule")}>
              <JobScheduleRows schedule={job} disabled={saving || running} onChange={(patch) => void save(job, patch)} />
            </GroupedList>
          )}
          <JobRunRows job={job} />
          {/* One at a time: these jobs queue heavy work and several skip themselves
              when another is already running, which would look like a dead button. */}
          <GroupedList>
            <ActionRow
              label={running ? t("controlAdmin:scheduledJobs.running") : t("controlAdmin:scheduledJobs.runNow")}
              disabled={saving || busyKey !== null}
              onClick={() => void startRun(job)}
            />
          </GroupedList>
        </div>
      </>
    );
  }

  // ── The list ───────────────────────────────────────────────────────────────
  return (
    <>
      {head}
      <div className="grouped-page">
        <p className="grouped-list-note">
          <Trans i18nKey="scheduledJobs.intro" ns="controlAdmin" components={{ bold: <strong /> }} />
        </p>
        {notices}
        {CATEGORIES.map((category) => {
          const inCategory = jobs.filter((job) => job.category === category);
          if (inCategory.length === 0) return null;
          return (
            <GroupedList key={category} title={t(`controlAdmin:scheduledJobs.${CATEGORY_LABEL_KEYS[category]}`)}>
              {inCategory.map((job) => (
                <NavRow
                  key={job.key}
                  icon={job.lastStatus === "error" ? <XCircle size={17} /> : busyKey === job.key ? <Clock size={17} /> : <CalendarClock size={17} />}
                  iconTone={job.lastStatus === "error" ? "danger" : job.enabled ? undefined : "muted"}
                  label={job.label}
                  sub={scheduleSummary(job)}
                  value={busyKey === job.key
                    ? t("controlAdmin:scheduledJobs.running")
                    : job.lastStatus === "error"
                      ? t("controlAdmin:scheduledJobs.lastFailed")
                      : undefined}
                  valueTone={job.lastStatus === "error" ? "danger" : undefined}
                  onClick={() => go(job.key)}
                />
              ))}
            </GroupedList>
          );
        })}
        {jobs.length === 0 && <p className="muted">{t("controlAdmin:scheduledJobs.empty")}</p>}
      </div>
    </>
  );
}

/** Last run (how it went) and next run, as two rows — shared with Backup's job pages. */
export function JobRunRows({ job }: { job: { enabled: boolean; nextRunAt: string | null; lastRunAt?: string | null; lastStatus?: "success" | "error" | null; lastMessage?: string | null } }) {
  const { t } = useTranslation(["controlAdmin"]);
  return (
    <GroupedList>
      {job.lastRunAt !== undefined && (
        <InfoRow
          icon={job.lastStatus === "error" ? <XCircle size={17} /> : <CheckCircle2 size={17} />}
          iconTone={job.lastRunAt ? (job.lastStatus === "error" ? "danger" : "ok") : "muted"}
          label={t("controlAdmin:scheduledJobs.lastRun")}
          sub={job.lastMessage ?? undefined}
          value={job.lastRunAt ? formatManagedDate(job.lastRunAt) : t("controlAdmin:scheduledJobs.neverRun")}
        />
      )}
      <InfoRow
        icon={<CalendarClock size={17} />}
        iconTone="muted"
        label={t("controlAdmin:scheduledJobs.nextRun")}
        value={job.enabled && job.nextRunAt ? formatManagedDate(job.nextRunAt) : t("controlAdmin:scheduledJobs.notScheduled")}
      />
    </GroupedList>
  );
}
