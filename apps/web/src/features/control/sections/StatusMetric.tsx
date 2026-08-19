import type { LucideIcon } from "lucide-react";

// Shared building blocks for the per-type stats pages (audiobook / ebook / gallery).

export function StatusMetric({ icon: Icon, label, value, note }: { icon: LucideIcon; label: string; value: string; note?: string }) {
  return (
    <article className="status-metric">
      <span className="status-metric-label">
        <span className="status-metric-icon" aria-hidden="true"><Icon size={11} /></span>
        {label}
      </span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </article>
  );
}

export function formatHours(seconds: number) {
  if (seconds <= 0) return "0 hr";
  const hours = seconds / 3600;
  return `${hours >= 100 ? Math.round(hours).toLocaleString() : hours.toFixed(hours >= 10 ? 1 : 2)} hr`;
}

// Clock-style duration (m:ss or h:mm:ss) for a single item, where "0.01 hr"
// would read poorly.
export function formatClock(seconds: number) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
