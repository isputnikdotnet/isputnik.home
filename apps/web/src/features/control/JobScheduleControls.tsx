import { useTranslation } from "react-i18next";
import { SelectField } from "../../shared/SelectField";

// The cadence / anchor day / clock time trio a scheduled job is edited with. One
// component for the Scheduled jobs table and for the two backup rows on the
// Backup page, so "the same schedule options" is literally true: a job is a job
// wherever its row happens to be drawn. Every change writes straight through —
// there is no Save button on either page.

export type JobFrequency = "daily" | "weekly" | "monthly";

export interface JobScheduleFields {
  frequency: JobFrequency;
  time: string;      // local clock time, e.g. "01:00"
  dayOfWeek: number; // 0=Sunday..6=Saturday, used when weekly
  dayOfMonth: number; // 1..28, used when monthly
}

export const WEEKDAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

export function JobScheduleControls({
  label,
  schedule,
  disabled,
  onChange
}: {
  label: string;
  schedule: JobScheduleFields;
  disabled?: boolean;
  onChange: (patch: Partial<JobScheduleFields>) => void;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  return (
    <div className="scheduled-job-schedule">
      <SelectField
        compact
        hideLabel
        label={t("controlAdmin:scheduledJobs.ariaFrequency", { label })}
        value={schedule.frequency}
        disabled={disabled}
        onChange={(value) => onChange({ frequency: value as JobFrequency })}
        options={[
          { value: "daily", label: t("controlAdmin:scheduledJobs.freqDaily") },
          { value: "weekly", label: t("controlAdmin:scheduledJobs.freqWeekly") },
          { value: "monthly", label: t("controlAdmin:scheduledJobs.freqMonthly") }
        ]}
      />
      {schedule.frequency === "weekly" && (
        <SelectField
          compact
          hideLabel
          label={t("controlAdmin:scheduledJobs.ariaDayOfWeek", { label })}
          value={String(schedule.dayOfWeek)}
          disabled={disabled}
          onChange={(value: string) => onChange({ dayOfWeek: Number(value) })}
          options={WEEKDAY_KEYS.map((key, i) => ({ value: String(i), label: t(`controlAdmin:scheduledJobs.${key}`) }))}
        />
      )}
      {schedule.frequency === "monthly" && (
        <SelectField
          compact
          hideLabel
          label={t("controlAdmin:scheduledJobs.ariaDayOfMonth", { label })}
          value={String(schedule.dayOfMonth)}
          disabled={disabled}
          onChange={(value: string) => onChange({ dayOfMonth: Number(value) })}
          options={MONTH_DAYS.map((day) => ({ value: String(day), label: t("controlAdmin:scheduledJobs.dayN", { day }) }))}
        />
      )}
      <input
        type="time"
        value={schedule.time}
        disabled={disabled}
        aria-label={t("controlAdmin:scheduledJobs.ariaTime", { label })}
        onChange={(e) => { if (e.target.value) onChange({ time: e.target.value }); }}
      />
    </div>
  );
}
