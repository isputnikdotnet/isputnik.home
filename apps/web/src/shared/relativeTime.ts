import i18n from "../i18n";

// "How long ago" — the one helper for it. Three surfaces used to carry their own
// copy (the control panel's timestamps, the home tiles, the activity feed), and
// they had already drifted apart on parsing, rounding and what a future moment
// says. They still read differently, on purpose: how much room a timestamp has
// decides how much of it can be spelled out, so the wording is a `style`.
//
//   long     "8 min ago", "21 days ago", "2 months ago", "in 6 hr" — wherever a
//            timestamp has a line to itself (tables, cards, lists). Rounds to the
//            nearest unit and can look ahead ("next scheduled run").
//   short    "8 min ago", "yesterday", "3 wk ago", "2 mo ago" — beside another
//            line of text under a fixed-width tile (the home shelves).
//   compact  "8m", "3h", "yesterday", "3 days", then the date — a narrow column
//            beside a sentence (the activity feed).
//
// short and compact count whole units elapsed (floor), and treat a moment still
// to come as "just now"; neither is used for anything scheduled.
//
// A plain function, not a hook, so it reads the strings through i18n directly and
// is re-evaluated on every call — a language switch shows up on the next render.
// Every number goes through a count-based key, so Russian gets its three forms.
export type RelativeTimeStyle = "long" | "short" | "compact";

// SQLite hands back "YYYY-MM-DD HH:MM:SS" (UTC, no zone); anything already
// carrying a T is a real ISO string and is left alone.
function parseTimestamp(value: string): number {
  return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).getTime();
}

export function relativeTime(value: string, { style = "long" }: { style?: RelativeTimeStyle } = {}): string {
  const then = parseTimestamp(value);
  // An unreadable timestamp says nothing rather than something untrue.
  if (Number.isNaN(then)) return "";
  const elapsedMs = Date.now() - then;
  return style === "long" ? longForm(elapsedMs) : countedForm(elapsedMs, style, value);
}

function longForm(elapsedMs: number): string {
  const seconds = Math.round(elapsedMs / 1000);
  // A moment still to come ("next scheduled run") reads "in 6 hr", not "just now".
  if (seconds < -45) return i18n.t("common:time.fromNow", { span: longSpan(-seconds) });
  if (seconds < 45) return i18n.t("common:time.justNow");
  return i18n.t("common:time.ago", { span: longSpan(seconds) });
}

/** A duration in the coarsest unit that still says something: "3 min", "6 hr", "2 days". */
function longSpan(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return i18n.t("common:time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return i18n.t("common:time.hours", { count: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return i18n.t("common:time.days", { count: days });
  const months = Math.round(days / 30);
  if (months < 12) return i18n.t("common:time.months", { count: months });
  return i18n.t("common:time.years", { count: Math.round(months / 12) });
}

function countedForm(elapsedMs: number, style: "short" | "compact", value: string): string {
  const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
  if (minutes < 1) return i18n.t("common:time.justNow");
  const ago = (span: string) => i18n.t("common:time.ago", { span });
  if (minutes < 60) {
    return style === "compact"
      ? i18n.t("common:time.minutesCompact", { count: minutes })
      : ago(i18n.t("common:time.minutes", { count: minutes }));
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return style === "compact"
      ? i18n.t("common:time.hoursCompact", { count: hours })
      : ago(i18n.t("common:time.hours", { count: hours }));
  }
  const days = Math.floor(hours / 24);
  if (days === 1) return i18n.t("common:time.yesterday");
  if (days < 7) {
    const span = i18n.t("common:time.days", { count: days });
    return style === "compact" ? span : ago(span);
  }
  // Past a week the activity feed gives the date itself: a count of days stops
  // meaning anything, and the column has no room for "3 wk ago".
  if (style === "compact") return new Date(parseTimestamp(value)).toLocaleDateString();
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return ago(i18n.t("common:time.weeksShort", { count: weeks }));
  const months = Math.floor(days / 30);
  if (months < 12) return ago(i18n.t("common:time.monthsShort", { count: months }));
  return ago(i18n.t("common:time.yearsShort", { count: Math.floor(days / 365) }));
}
