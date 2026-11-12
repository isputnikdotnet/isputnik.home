import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { InputRow, PickerRow } from "../../shared/GroupedList";

// The cadence / anchor day / clock time a scheduled job is edited with, as grouped
// rows (control panel v2): Repeat, then the day when it needs one, then the time.
// One component for a job's page under Scheduled jobs and for the two backup jobs
// on the Backup page, so "the same schedule options" is literally true: a job is a
// job wherever it is drawn. Every change writes straight through — no Save.

export type JobFrequency = "daily" | "weekly" | "monthly";

export interface JobScheduleFields {
  frequency: JobFrequency;
  time: string;      // local clock time, e.g. "01:00"
  dayOfWeek: number; // 0=Sunday..6=Saturday, used when weekly
  dayOfMonth: number; // 1..28, used when monthly
}

export const WEEKDAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

/** "Daily, 03:00" — what a job's row in a list says about when it runs. */
export function useScheduleSummary(): (schedule: JobScheduleFields & { enabled?: boolean }) => string {
  const { t } = useTranslation(["controlAdmin"]);
  return (schedule) => {
    if (schedule.enabled === false) return t("controlAdmin:scheduledJobs.off");
    switch (schedule.frequency) {
      case "weekly":
        return t("controlAdmin:scheduledJobs.summaryWeekly", { day: t(`controlAdmin:scheduledJobs.${WEEKDAY_KEYS[schedule.dayOfWeek] ?? "sunday"}`), time: schedule.time });
      case "monthly":
        return t("controlAdmin:scheduledJobs.summaryMonthly", { day: schedule.dayOfMonth, time: schedule.time });
      default:
        return t("controlAdmin:scheduledJobs.summaryDaily", { time: schedule.time });
    }
  };
}

export function JobScheduleRows({
  schedule,
  disabled,
  onChange
}: {
  schedule: JobScheduleFields;
  disabled?: boolean;
  onChange: (patch: Partial<JobScheduleFields>) => void;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  // The time is kept here while it is typed and saved when the field is left, so a
  // half-typed "0" does not reschedule the job on the way to "03:00".
  const [time, setTime] = useState(schedule.time);
  useEffect(() => setTime(schedule.time), [schedule.time]);

  return (
    <>
      <PickerRow
        label={t("controlAdmin:scheduledJobs.repeatRow")}
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
        <PickerRow
          label={t("controlAdmin:scheduledJobs.dayRow")}
          value={String(schedule.dayOfWeek)}
          disabled={disabled}
          onChange={(value) => onChange({ dayOfWeek: Number(value) })}
          options={WEEKDAY_KEYS.map((key, i) => ({ value: String(i), label: t(`controlAdmin:scheduledJobs.${key}`) }))}
        />
      )}
      {schedule.frequency === "monthly" && (
        <PickerRow
          label={t("controlAdmin:scheduledJobs.dayRow")}
          value={String(schedule.dayOfMonth)}
          disabled={disabled}
          onChange={(value) => onChange({ dayOfMonth: Number(value) })}
          options={MONTH_DAYS.map((day) => ({ value: String(day), label: t("controlAdmin:scheduledJobs.dayN", { day }) }))}
        />
      )}
      <InputRow
        label={t("controlAdmin:scheduledJobs.timeRow")}
        type="time"
        value={time}
        disabled={disabled}
        onChange={setTime}
        onCommit={() => {
          if (!time) setTime(schedule.time);
          else if (time !== schedule.time) onChange({ time });
        }}
      />
    </>
  );
}
