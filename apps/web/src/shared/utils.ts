// SQLite hands back "YYYY-MM-DD HH:MM:SS" with no zone; anything already
// carrying a T is a real ISO string and is left alone.
function parseManagedDate(value: string) {
  return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

/** ISO 3166-1 alpha-2 → the reader's own name for that country ("NL" → "Netherlands"). */
export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(undefined, { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * ISO 3166-1 alpha-2 → the flag emoji ("NL" → 🇳🇱), or "" for anything that isn't
 * a plain two-letter code. The pair of regional-indicator codepoints is what
 * every platform's emoji font keys flags on; render it inside a `country-flag`
 * span, which carries the bundled flag font for platforms (Windows) whose system
 * fonts draw the letters instead of a flag.
 */
export function countryFlag(code: string | null | undefined): string {
  if (!code || !/^[a-zA-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...[...code.toUpperCase()].map((letter) => 0x1f1a5 + letter.charCodeAt(0)));
}

export function formatManagedDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(parseManagedDate(value));
}

// Date and time separately, for the metric cards. Their value line is sized for
// something short and scannable — "17.6 MB", "40" — so a full timestamp wraps in
// them at any card width. The date goes on the value line, the time underneath.
export function formatManagedDateParts(value: string): { date: string; time: string } {
  const parsed = parseManagedDate(value);
  return {
    date: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed),
    time: new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(parsed)
  };
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

export function formatUptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours} hr ${minutes} min` : `${minutes} min`;
}

export function formatLogName(event: string) {
  return event.replaceAll(".", " ");
}

// Coarse "time remaining" phrasing for live task/scan progress lines.
export function formatEta(seconds: number): string {
  if (seconds < 60) return "less than a minute left";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `about ${mins} min left`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `about ${hrs} hr left` : `about ${hrs} hr ${rem} min left`;
}

// Document formats the in-app foliate reader can render (its EPUB engine plus the
// FB2 parser). PDFs are deliberately excluded — they use the native <iframe>
// viewer, not foliate.
export type FoliateFormat = "epub" | "fb2";

export function isFoliateFormat(format: string | null | undefined): format is FoliateFormat {
  return format === "epub" || format === "fb2";
}

// foliate-js detects a book's format from the File *name* (and falls back to the
// MIME type), so any blob handed to the reader must be named to match its format.
export function foliateFileInfo(format: string): { name: string; mime: string } {
  return format === "fb2"
    ? { name: "book.fb2", mime: "application/x-fictionbook+xml" }
    : { name: "book.epub", mime: "application/epub+zip" };
}

// Compact "time ago" label (e.g. "8 min ago", "2 days ago"). Accepts the app's
// ISO timestamps (with or without the trailing Z) the same way formatManagedDate does.
export function relativeTime(value: string): string {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "just now";
  // A moment still to come ("next scheduled run") reads "in 6 hr", not "just now".
  if (seconds < -45) return `in ${relativeSpan(-seconds)}`;
  if (seconds < 45) return "just now";
  return `${relativeSpan(seconds)} ago`;
}

/** A duration in the coarsest unit that still says something: "3 min", "6 hr", "2 days". */
function relativeSpan(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"}`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"}`;
  const years = Math.round(months / 12);
  return `${years} ${years === 1 ? "year" : "years"}`;
}
