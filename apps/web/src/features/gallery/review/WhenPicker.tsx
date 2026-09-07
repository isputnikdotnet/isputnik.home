import { useTranslation } from "react-i18next";

// "When was this taken?" for someone answering about an old print: a year from a
// list (decades as headings, this year at the top), then a month if she knows
// it, then a day once a month is chosen, and Exactly / About. Nothing is typed.
// The precision the server stores falls out of how far she went
// (docs/photo-review-plan.md, phase 2).

export interface WhenValue {
  year: string;  // "" = not answered
  month: string; // "1".."12" or ""
  day: string;   // "1".."31" or ""
  approx: boolean;
}

const FIRST_YEAR = 1850;

function monthNames(): string[] {
  const names: string[] = [];
  for (let m = 0; m < 12; m += 1) {
    names.push(new Date(2000, m, 1).toLocaleDateString(undefined, { month: "long" }));
  }
  return names;
}

export function WhenPicker({ value, onChange, disabled }: { value: WhenValue; onChange: (next: WhenValue) => void; disabled?: boolean }) {
  const { t } = useTranslation(["galleryReview", "gallery"]);
  const thisYear = new Date().getFullYear();
  const months = monthNames();
  const daysInMonth = value.year && value.month ? new Date(Number(value.year), Number(value.month), 0).getDate() : 31;

  // Decade headings, newest first, so the years she is likely to want are at
  // the top and a scroll wheel has landmarks.
  const decades: { label: string; years: number[] }[] = [];
  for (let start = Math.floor(thisYear / 10) * 10; start >= FIRST_YEAR; start -= 10) {
    const years: number[] = [];
    for (let y = Math.min(start + 9, thisYear); y >= start; y -= 1) years.push(y);
    decades.push({ label: t("gallery:date.decade", { year: start }), years });
  }

  return (
    <div className="review-when">
      <div className="review-when-row">
        <select
          className="review-select"
          value={value.year}
          // A year on its own is a guess more often than not, so choosing one
          // starts as "About"; she can press Exactly, and a month or day keeps
          // whatever she chose.
          onChange={(event) => onChange({
            ...value,
            year: event.target.value,
            month: event.target.value ? value.month : "",
            day: event.target.value ? value.day : "",
            approx: !value.year && event.target.value ? true : value.approx
          })}
          aria-label={t("when.year")}
          disabled={disabled}
        >
          <option value="">{t("when.yearUnknown")}</option>
          {decades.map((decade) => (
            <optgroup key={decade.label} label={decade.label}>
              {decade.years.map((year) => <option key={year} value={String(year)}>{year}</option>)}
            </optgroup>
          ))}
        </select>
        <select
          className="review-select"
          value={value.month}
          onChange={(event) => onChange({ ...value, month: event.target.value, day: event.target.value ? value.day : "" })}
          aria-label={t("when.month")}
          disabled={disabled || !value.year}
        >
          <option value="">{t("when.monthUnknown")}</option>
          {months.map((name, index) => <option key={name} value={String(index + 1)}>{name}</option>)}
        </select>
        {value.month && (
          <select
            className="review-select review-select-day"
            value={value.day}
            onChange={(event) => onChange({ ...value, day: event.target.value })}
            aria-label={t("when.day")}
            disabled={disabled}
          >
            <option value="">{t("when.dayUnknown")}</option>
            {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => (
              <option key={day} value={String(day)}>{day}</option>
            ))}
          </select>
        )}
      </div>
      <div className="review-toggle" role="group" aria-label={t("when.exactnessAria")}>
        <button type="button" aria-pressed={!value.approx} onClick={() => onChange({ ...value, approx: false })} disabled={disabled || !value.year}>
          {t("when.exactly")}
        </button>
        <button type="button" aria-pressed={value.approx} onClick={() => onChange({ ...value, approx: true })} disabled={disabled || !value.year}>
          {t("when.about")}
        </button>
      </div>
    </div>
  );
}
