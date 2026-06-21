export function formatManagedDate(value: string) {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
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
  if (!Number.isFinite(seconds) || seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`;
  const years = Math.round(months / 12);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}
