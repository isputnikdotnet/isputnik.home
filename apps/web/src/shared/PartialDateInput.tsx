import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SelectField } from "./SelectField";

// A partial date as Day · Month · Year. Same value as PartialDateField — "1924",
// "1924-05" or "1924-05-17" — but nobody has to know that shape: a year alone is
// a whole answer, a month narrows it, a day narrows it further. Genealogy dates
// are mostly year-only, which is why a native date input (all or nothing) can't
// be used.
//
// A half-given date (a day with no month, a month with no year, the 31st of
// April) is not silently trimmed to what fits: the part at fault carries a
// validity message, so the form won't submit until it is fixed, and the value
// handed up is one the server refuses too.

interface Parts {
  day: string;
  month: string;
  year: string;
}

function toParts(value: string): Parts {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value.trim());
  if (!match) return { day: "", month: "", year: value.trim() };
  return {
    year: match[1],
    month: match[2] ? String(Number(match[2])) : "",
    day: match[3] ? String(Number(match[3])) : ""
  };
}

type Problem = { part: keyof Parts; key: "year" | "yearNeeded" | "monthNeeded" | "day" } | null;

function problemWith({ day, month, year }: Parts): Problem {
  if (year && !/^\d{4}$/.test(year)) return { part: "year", key: "year" };
  if ((day || month) && !year) return { part: "year", key: "yearNeeded" };
  if (day && !month) return { part: "month", key: "monthNeeded" };
  if (day) {
    const n = Number(day);
    const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    if (!/^\d{1,2}$/.test(day) || n < 1 || n > daysInMonth) return { part: "day", key: "day" };
  }
  return null;
}

/** Only trailing empty parts are dropped: a gap in the middle ("-05-17",
 *  "1924--17") stays a value the server rejects, never a date meaning less. */
function compose({ day, month, year }: Parts): string {
  const segments = [year, month && month.padStart(2, "0"), day && day.padStart(2, "0")];
  while (segments.length > 1 && !segments[segments.length - 1]) segments.pop();
  return segments.join("-");
}

export function PartialDateInput({
  label,
  value,
  onChange,
  className
}: {
  label: string;
  /** "" | "YYYY" | "YYYY-MM" | "YYYY-MM-DD". */
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const { t, i18n } = useTranslation("common");
  const labelId = useId();
  const [parts, setParts] = useState<Parts>(() => toParts(value));
  // What this field last handed up. A different value arriving means someone else
  // set it (a reset, a loaded record), so the parts are read again.
  const emitted = useRef(value);
  const dayRef = useRef<HTMLInputElement>(null);
  const yearRef = useRef<HTMLInputElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value !== emitted.current) {
      emitted.current = value;
      setParts(toParts(value));
    }
  }, [value]);

  const months = useMemo(() => {
    const format = new Intl.DateTimeFormat(i18n.language, { month: "long", timeZone: "UTC" });
    return Array.from({ length: 12 }, (_, index) => {
      const name = format.format(Date.UTC(2000, index, 1));
      return { value: String(index + 1), label: name.charAt(0).toLocaleUpperCase(i18n.language) + name.slice(1) };
    });
  }, [i18n.language]);

  const problem = problemWith(parts);

  // The message sits on the part to fix, so the browser points there on submit.
  useEffect(() => {
    const month = groupRef.current?.querySelector("select") ?? null;
    const controls: Record<keyof Parts, HTMLInputElement | HTMLSelectElement | null> = {
      day: dayRef.current,
      month,
      year: yearRef.current
    };
    for (const [part, control] of Object.entries(controls) as [keyof Parts, HTMLInputElement | HTMLSelectElement | null][]) {
      if (!control) continue;
      const message = problem?.part === part ? t(`partialDate.problem.${problem.key}`) : "";
      control.setCustomValidity(message);
      if (message) control.setAttribute("aria-invalid", "true");
      else control.removeAttribute("aria-invalid");
    }
  }, [problem?.part, problem?.key, t]);

  const update = (patch: Partial<Parts>) => {
    const next = { ...parts, ...patch };
    setParts(next);
    const composed = compose(next);
    emitted.current = composed;
    onChange(composed);
  };

  return (
    <div className={["field", "partial-date-input", className].filter(Boolean).join(" ")} role="group" aria-labelledby={labelId}>
      <span id={labelId}>{label}</span>
      <div className="partial-date-parts" ref={groupRef}>
        <input
          ref={dayRef}
          className="partial-date-day"
          type="text"
          inputMode="numeric"
          maxLength={2}
          value={parts.day}
          placeholder={t("partialDate.dayPlaceholder")}
          aria-label={t("partialDate.day")}
          onChange={(event) => update({ day: event.target.value.replace(/\D/g, "") })}
        />
        <SelectField
          className="partial-date-month"
          label={t("partialDate.month")}
          hideLabel
          value={parts.month}
          options={[{ value: "", label: t("partialDate.month") }, ...months]}
          onChange={(month) => update({ month })}
        />
        <input
          ref={yearRef}
          className="partial-date-year"
          type="text"
          inputMode="numeric"
          maxLength={4}
          value={parts.year}
          placeholder={t("partialDate.yearPlaceholder")}
          aria-label={t("partialDate.year")}
          onChange={(event) => update({ year: event.target.value.replace(/\D/g, "") })}
        />
      </div>
    </div>
  );
}
