import i18n from "../i18n";

// Dates, times and numbers in the language the INTERFACE is set to — not the
// one the browser happens to run in. `toLocaleDateString()` with no locale asks
// the browser, so a Russian interface on an English machine printed
// "September 7, 2026" where it owed "7 сентября 2026 г."; every date in the app
// now comes through here instead.
//
// A shape is named, never spelled out at the call site, so the same kind of date
// reads the same everywhere and a language orders it itself — "Sep 1, 1971" in
// English is "1 сент. 1971 г." in Russian, and no hand-assembled
// `${month} ${day}, ${year}` can say both.
//
// Plain functions, not hooks: they read `i18n.language` on every call, so a
// language switch shows up on the next render (components that show dates
// already re-render through `useTranslation`). The `Intl` objects are memoized
// per language + shape — a list of 200 rows constructing one formatter per cell
// is measurably slow, and the cache key carries the language so a switch never
// serves the old one.

/** How much of a date is spelled out. English · Russian: */
export type DateShape =
  /** 9/7/2026 · 07.09.2026 — the browser-default all-numeric date */
  | "numeric"
  /** Sep 7, 2026 · 7 сент. 2026 г. */
  | "medium"
  /** September 7, 2026 · 7 сентября 2026 г. */
  | "long"
  /** Sep 7 · 7 сент. */
  | "dayMonth"
  /** September 7 · 7 сентября */
  | "dayMonthLong"
  /** September 2026 · сентябрь 2026 г. */
  | "monthYear"
  /** Sep 2026 · сент. 2026 г. */
  | "monthShortYear"
  /** September · сентябрь */
  | "monthName"
  /** Saturday · суббота */
  | "weekday"
  /** Saturday, Jul 12, 2004 · суббота, 12 июл. 2004 г. */
  | "weekdayMedium";

/** How the clock is written. English · Russian: */
export type TimeShape =
  /** 3:04 PM · 15:04 */
  | "time"
  /** 03:04 PM · 15:04 — the zero-padded hour dense tables use */
  | "padded"
  /** 3:04:05 PM · 15:04:05 — the browser-default time, seconds and all */
  | "seconds";

const DATE_OPTIONS: Record<DateShape, Intl.DateTimeFormatOptions> = {
  numeric: { year: "numeric", month: "numeric", day: "numeric" },
  medium: { year: "numeric", month: "short", day: "numeric" },
  long: { year: "numeric", month: "long", day: "numeric" },
  dayMonth: { month: "short", day: "numeric" },
  dayMonthLong: { month: "long", day: "numeric" },
  monthYear: { year: "numeric", month: "long" },
  monthShortYear: { year: "numeric", month: "short" },
  monthName: { month: "long" },
  weekday: { weekday: "long" },
  weekdayMedium: { weekday: "long", year: "numeric", month: "short", day: "numeric" }
};

const TIME_OPTIONS: Record<TimeShape, Intl.DateTimeFormatOptions> = {
  time: { hour: "numeric", minute: "2-digit" },
  padded: { hour: "2-digit", minute: "2-digit" },
  seconds: { hour: "numeric", minute: "2-digit", second: "2-digit" }
};

/** Anything a caller has on hand: a Date, an ISO string, a SQLite timestamp, an
 *  epoch. Null, blank and unparseable values format as "" so a call site can
 *  fall back with `|| "—"` rather than printing "Invalid Date". */
export type DateLike = Date | string | number | null | undefined;

// SQLite hands back "YYYY-MM-DD HH:MM:SS" (UTC, no zone); anything already
// carrying a T is a real ISO string and is left alone. Same rule as
// shared/relativeTime.ts.
const SQLITE_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

function toDate(value: DateLike): Date | null {
  if (value == null) return null;
  const date =
    value instanceof Date
      ? value
      : typeof value === "number"
        ? new Date(value)
        : new Date(SQLITE_STAMP.test(value.trim()) ? `${value.trim().replace(" ", "T")}Z` : value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

function language(): string {
  return i18n.language || "en";
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(date: DateShape | null, time: TimeShape | null, utc: boolean): Intl.DateTimeFormat {
  const lng = language();
  const key = `${lng}|${date ?? ""}|${time ?? ""}|${utc ? "utc" : ""}`;
  const cached = dateFormatters.get(key);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat(lng, {
    ...(date ? DATE_OPTIONS[date] : {}),
    ...(time ? TIME_OPTIONS[time] : {}),
    ...(utc ? { timeZone: "UTC" } : {})
  });
  dateFormatters.set(key, made);
  return made;
}

/** `utc: true` reads the instant as a UTC calendar date — for a value that only
 *  ever meant a day (a partial date, a coarse "taken" date), which read in local
 *  time can roll back to the evening before west of Greenwich. */
export interface DateFormatOptions {
  utc?: boolean;
}

/** A date on its own, in the interface language. */
export function formatDate(value: DateLike, shape: DateShape = "numeric", { utc = false }: DateFormatOptions = {}): string {
  const date = toDate(value);
  return date ? formatter(shape, null, utc).format(date) : "";
}

/** A clock time on its own, in the interface language. */
export function formatTime(value: DateLike, shape: TimeShape = "time"): string {
  const date = toDate(value);
  return date ? formatter(null, shape, false).format(date) : "";
}

/** A date and the time on it — each language joins the two its own way. */
export function formatDateTime(
  value: DateLike,
  shape: DateShape = "numeric",
  time: TimeShape = "time",
  { utc = false }: DateFormatOptions = {}
): string {
  const date = toDate(value);
  return date ? formatter(shape, time, utc).format(date) : "";
}

const numberFormatters = new Map<string, Intl.NumberFormat>();

/** A number with the interface language's grouping and decimal marks —
 *  "1,204" in English, "1 204" in Russian. Counts, totals, sizes. */
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  if (!Number.isFinite(value)) return String(value);
  const lng = language();
  const key = `${lng}|${options.maximumFractionDigits ?? ""}|${options.minimumFractionDigits ?? ""}|${options.style ?? ""}|${options.unit ?? ""}`;
  let made = numberFormatters.get(key);
  if (!made) {
    made = new Intl.NumberFormat(lng, options);
    numberFormatters.set(key, made);
  }
  return made.format(value);
}

const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();

/** "3 days ago" / "3 дня назад" — a span of whole days, negative for the past. */
export function formatRelativeDays(days: number): string {
  const lng = language();
  let made = relativeFormatters.get(lng);
  if (!made) {
    made = new Intl.RelativeTimeFormat(lng, { numeric: "always" });
    relativeFormatters.set(lng, made);
  }
  return made.format(days, "day");
}

const regionNames = new Map<string, Intl.DisplayNames | null>();

/** ISO 3166-1 alpha-2 → the country's name in the interface language
 *  ("NL" → "Netherlands" · "Нидерланды"), or the code itself if it has none. */
export function formatRegion(code: string): string {
  const lng = language();
  if (!regionNames.has(lng)) {
    try {
      regionNames.set(lng, new Intl.DisplayNames(lng, { type: "region" }));
    } catch {
      regionNames.set(lng, null);
    }
  }
  try {
    return regionNames.get(lng)?.of(code) ?? code;
  } catch {
    return code;
  }
}
