import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../shared/Button";
import { formatDate } from "../../../shared/dates";

// "When was this taken?" for someone answering about an old print: how sure she
// is first (Exact · Approximate · Unknown), then a year from a list (decades as
// headings, this year at the top), a month if she knows it, and a day once a
// month is chosen. Nothing is typed. The precision the server stores falls out
// of how far she went (docs/photo-review-plan.md, phase 2).

export interface WhenValue {
  year: string;  // "" = not answered
  month: string; // "1".."12" or ""
  day: string;   // "1".."31" or ""
  approx: boolean;
}

type Sureness = "exact" | "approx" | "unknown";

const FIRST_YEAR = 1850;

function monthNames(): string[] {
  const names: string[] = [];
  for (let m = 0; m < 12; m += 1) {
    names.push(formatDate(new Date(2000, m, 1), "monthName"));
  }
  return names;
}

/** Host it keyed on the photo: the sureness pressed before a year exists is the
 *  picker's own, and belongs to the photo it was pressed on. */
export function WhenPicker({ value, onChange, disabled }: { value: WhenValue; onChange: (next: WhenValue) => void; disabled?: boolean }) {
  const { t } = useTranslation(["galleryReview", "gallery"]);
  // Exact or Approximate pressed while no year is chosen yet: shown as pressed,
  // and applied to the year when it comes.
  const [pending, setPending] = useState<"exact" | "approx" | null>(null);
  const thisYear = new Date().getFullYear();
  const months = monthNames();
  const daysInMonth = value.year && value.month ? new Date(Number(value.year), Number(value.month), 0).getDate() : 31;

  const sureness: Sureness = value.year ? (value.approx ? "approx" : "exact") : (pending ?? "unknown");

  const choose = (next: Sureness) => {
    if (next === "unknown") {
      setPending(null);
      onChange({ year: "", month: "", day: "", approx: false });
      return;
    }
    if (value.year) onChange({ ...value, approx: next === "approx" });
    else setPending(next);
  };

  // Decade headings, newest first, so the years she is likely to want are at
  // the top and a scroll wheel has landmarks.
  const decades: { label: string; years: number[] }[] = [];
  for (let start = Math.floor(thisYear / 10) * 10; start >= FIRST_YEAR; start -= 10) {
    const years: number[] = [];
    for (let y = Math.min(start + 9, thisYear); y >= start; y -= 1) years.push(y);
    decades.push({ label: t("gallery:date.decade", { year: start }), years });
  }

  const segments: { key: Sureness; label: string }[] = [
    { key: "exact", label: t("when.exact") },
    { key: "approx", label: t("when.approximate") },
    { key: "unknown", label: t("when.unknown") }
  ];

  return (
    <div className="review-when">
      <div className="review-segments" role="group" aria-label={t("when.exactnessAria")}>
        {segments.map((segment) => (
          <Button
            key={segment.key}
            variant="bare"
            className="review-segment"
            aria-pressed={sureness === segment.key}
            onClick={() => choose(segment.key)}
            disabled={disabled}
          >
            {segment.label}
          </Button>
        ))}
      </div>
      <div className="review-when-row">
        <label className="review-field">
          <span>{t("when.year")}</span>
          <select
            className="review-select"
            value={value.year}
            // A year on its own is a guess more often than not, so choosing one
            // starts as Approximate unless Exact was pressed first; a month or day
            // keeps whatever she chose.
            onChange={(event) => {
              const year = event.target.value;
              const approx = !value.year && year ? pending !== "exact" : value.approx;
              if (!year) setPending(null);
              onChange({ ...value, year, month: year ? value.month : "", day: year ? value.day : "", approx: year ? approx : false });
            }}
            disabled={disabled}
          >
            <option value="">{t("when.yearUnknown")}</option>
            {decades.map((decade) => (
              <optgroup key={decade.label} label={decade.label}>
                {decade.years.map((year) => <option key={year} value={String(year)}>{year}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="review-field">
          <span>{t("when.month")}</span>
          <select
            className="review-select"
            value={value.month}
            onChange={(event) => onChange({ ...value, month: event.target.value, day: event.target.value ? value.day : "" })}
            disabled={disabled || !value.year}
          >
            <option value="">{t("when.monthUnknown")}</option>
            {months.map((name, index) => <option key={name} value={String(index + 1)}>{name}</option>)}
          </select>
        </label>
        <label className="review-field">
          <span>{t("when.day")}</span>
          <select
            className="review-select"
            value={value.day}
            onChange={(event) => onChange({ ...value, day: event.target.value })}
            disabled={disabled || !value.month}
          >
            <option value="">{t("when.dayUnknown")}</option>
            {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => (
              <option key={day} value={String(day)}>{day}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
