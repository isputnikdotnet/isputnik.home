import { ArrowDown, ArrowUp, type LucideIcon } from "lucide-react";

// A headline number with its own tinted icon, a change badge, and one line of
// context under it — the "how is this doing right now" card, as opposed to
// StatusMetric's compact tile for dense stat grids.
//
// The badge is coloured by meaning, not by direction: `goodWhen` says which way
// is the good way for this number, so a drop in failed sign-ins reads green and a
// rise reads rose, while a neutral metric (total attempts) stays informational.

export type KpiTone = "info" | "success" | "danger" | "warning";

export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return current > 0 ? null : 0;
  return ((current - previous) / previous) * 100;
}

export function KpiCard({
  icon: Icon,
  tone = "info",
  label,
  value,
  change,
  goodWhen = "neither",
  context
}: {
  icon: LucideIcon;
  tone?: KpiTone;
  label: string;
  value: string;
  /** Percent change against the comparison period; null when there's nothing to compare against. */
  change?: number | null;
  goodWhen?: "up" | "down" | "neither";
  context?: string;
}) {
  const rounded = change == null ? null : Math.round(change * 10) / 10;
  const direction = rounded == null || rounded === 0 ? "flat" : rounded > 0 ? "up" : "down";
  const badgeTone =
    direction === "flat" || goodWhen === "neither"
      ? "neutral"
      : direction === goodWhen
        ? "good"
        : "bad";

  return (
    <article className="kpi-card">
      <span className={`kpi-card-icon ${tone}`} aria-hidden="true">
        <Icon size={24} />
      </span>
      <div className="kpi-card-copy">
        <span className="kpi-card-label">{label}</span>
        <span className="kpi-card-value">
          <strong>{value}</strong>
          {rounded != null && rounded !== 0 && (
            <span className={`kpi-card-change ${badgeTone}`}>
              {direction === "up" ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />}
              {Math.abs(rounded).toFixed(1)}%
            </span>
          )}
        </span>
        {context && <span className="kpi-card-context">{context}</span>}
      </div>
    </article>
  );
}
