import { useState, useEffect, useCallback } from "react";
import { CalendarClock, CheckCircle2, Play, Save, XCircle } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ToggleSwitch } from "../../../shared/ToggleSwitch";
import { formatManagedDate } from "../../../shared/utils";

type Frequency = "daily" | "weekly" | "monthly";

interface ScheduledJob {
  key: string;
  label: string;
  description: string;
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

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

export function ScheduledJobsSection() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const payload = await api<{ jobs: ScheduledJob[] }>("/api/scheduled-jobs");
    setJobs(payload.jobs);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Unable to load scheduled jobs"));
  }, [load]);

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Maintenance</p>
          <h1>Scheduled jobs</h1>
        </div>
      </div>

      <p className="scheduled-jobs-intro muted">
        Recurring upkeep tasks. Pick how often each one runs — and on which day, at what
        time — or turn it off entirely. You can also run any task once with <strong>Run now</strong>.
      </p>

      {error && <MessageBox tone="error" title="Scheduled jobs error">{error}</MessageBox>}

      <div className="scheduled-jobs">
        {jobs.map((job) => (
          <ScheduledJobCard key={job.key} job={job} onChanged={load} onError={setError} />
        ))}
      </div>
    </>
  );
}

function ScheduledJobCard({
  job,
  onChanged,
  onError
}: {
  job: ScheduledJob;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [enabled, setEnabled] = useState(job.enabled);
  const [frequency, setFrequency] = useState<Frequency>(job.frequency);
  const [time, setTime] = useState(job.time);
  const [dayOfWeek, setDayOfWeek] = useState(job.dayOfWeek);
  const [dayOfMonth, setDayOfMonth] = useState(job.dayOfMonth);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const dirty =
    enabled !== job.enabled ||
    frequency !== job.frequency ||
    time !== job.time ||
    dayOfWeek !== job.dayOfWeek ||
    dayOfMonth !== job.dayOfMonth;

  const save = async () => {
    setSaving(true);
    onError("");
    try {
      await api(`/api/scheduled-jobs/${job.key}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled, frequency, time, dayOfWeek, dayOfMonth })
      });
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to save scheduled job");
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    onError("");
    try {
      await api(`/api/scheduled-jobs/${job.key}/run`, { method: "POST", body: "{}" });
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Job failed to run");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="scheduled-job-card">
      <div className="scheduled-job-head">
        <div className="scheduled-job-copy">
          <h2>{job.label}</h2>
          <p className="muted">{job.description}</p>
        </div>
        <ToggleSwitch
          className="scheduled-job-toggle"
          checked={enabled}
          onChange={setEnabled}
          label={enabled ? "On" : "Off"}
          ariaLabel={`${job.label}: ${enabled ? "on" : "off"}`}
        />
      </div>

      <div className="scheduled-job-foot">
        <div className="scheduled-job-when">
          <span>Runs</span>
          <select
            value={frequency}
            disabled={!enabled}
            aria-label={`${job.label}: frequency`}
            onChange={(e) => setFrequency(e.target.value as Frequency)}
          >
            <option value="daily">every day</option>
            <option value="weekly">every week</option>
            <option value="monthly">every month</option>
          </select>
          {frequency === "weekly" && (
            <>
              <span>on</span>
              <select
                value={dayOfWeek}
                disabled={!enabled}
                aria-label={`${job.label}: day of week`}
                onChange={(e) => setDayOfWeek(Number(e.target.value))}
              >
                {WEEKDAYS.map((name, i) => (
                  <option key={name} value={i}>{name}</option>
                ))}
              </select>
            </>
          )}
          {frequency === "monthly" && (
            <>
              <span>on day</span>
              <select
                value={dayOfMonth}
                disabled={!enabled}
                aria-label={`${job.label}: day of month`}
                onChange={(e) => setDayOfMonth(Number(e.target.value))}
              >
                {MONTH_DAYS.map((day) => (
                  <option key={day} value={day}>{day}</option>
                ))}
              </select>
            </>
          )}
          <span>at</span>
          <input
            type="time"
            value={time}
            disabled={!enabled}
            aria-label={`${job.label}: time of day`}
            onChange={(e) => { if (e.target.value) setTime(e.target.value); }}
          />
        </div>

        <div className="scheduled-job-actions">
          <button className="secondary-button compact-button" onClick={runNow} disabled={running || saving}>
            <Play size={14} /> {running ? "Running…" : "Run now"}
          </button>
          <button className="primary-button compact-button" onClick={save} disabled={!dirty || saving || running}>
            <Save size={14} /> {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="scheduled-job-status">
        {job.lastRunAt ? (
          <span className={`scheduled-job-last ${job.lastStatus ?? ""}`}>
            {job.lastStatus === "error" ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
            <span>
              Last run {formatManagedDate(job.lastRunAt)}
              {job.lastMessage && <small> — {job.lastMessage}</small>}
            </span>
          </span>
        ) : (
          <span className="muted">Never run.</span>
        )}
        {job.enabled && job.nextRunAt && (
          <span className="scheduled-job-next muted">
            <CalendarClock size={14} /> Next run {formatManagedDate(job.nextRunAt)}
          </span>
        )}
      </div>
    </section>
  );
}
