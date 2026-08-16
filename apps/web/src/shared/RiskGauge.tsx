// A small dial: how much attention something deserves before you act on it, read at a
// glance. A semicircular scale runs green → gold → amber → red and a needle points
// into the zone for the current severity; the zone under the needle is lit and the
// rest sit faded, so the reading survives colour-blindness (needle position), a
// half-second glance (colour), and a screen reader (the label and sentence). The
// gauge never replaces the explanation, it points at it — the full sentence rides the
// tooltip and the aria-label.
//
// Shared rather than a duplicates one-off: the shape is "N ordered severities, one
// value" and nothing in it knows about photos.

const ZONES = [
  { tone: "is-none", color: "var(--mint)" },
  { tone: "is-low", color: "var(--gold)" },
  { tone: "is-medium", color: "var(--amber)" },
  { tone: "is-high", color: "var(--rose)" }
] as const;

// The dial's geometry, in a 44×24 viewBox: pivot at the bottom centre, scale on a
// semicircle above it. Each zone is a quarter of the sweep with a small gap.
const CX = 22;
const CY = 21;
const RADIUS = 16;
const ZONE_SWEEP = 45;
const ZONE_GAP = 3; // degrees shaved off each side of a zone

// SVG y grows downward, so the upper semicircle is sin-negative. 180° is the left end
// of the scale (severity 0), 0° the right end.
function polar(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY - radius * Math.sin(rad) };
}

function zoneArc(index: number): string {
  const from = 180 - index * ZONE_SWEEP - ZONE_GAP;
  const to = 180 - (index + 1) * ZONE_SWEEP + ZONE_GAP;
  const start = polar(from, RADIUS);
  const end = polar(to, RADIUS);
  // Sweep flag 1: clockwise from the left end of the scale toward the right.
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${RADIUS} ${RADIUS} 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

export function RiskGauge({
  severity,
  label,
  explanation
}: {
  /** 0 (calm, green) … 3 (stop and look, red). Clamped. */
  severity: number;
  label: string;
  /** The sentence behind the reading — shown as the tooltip. */
  explanation?: string;
}) {
  const level = Math.max(0, Math.min(ZONES.length - 1, Math.floor(severity)));
  const needleAngle = 180 - (level + 0.5) * ZONE_SWEEP;
  const tip = polar(needleAngle, RADIUS - 4.5);

  return (
    <span
      className={`risk-gauge ${ZONES[level].tone}`}
      role="img"
      aria-label={`${label}${explanation ? ` — ${explanation}` : ""}`}
      title={explanation}
    >
      <svg className="risk-gauge-dial" viewBox="0 0 44 24" aria-hidden="true">
        {ZONES.map((zone, index) => (
          <path
            key={zone.tone}
            className={`risk-gauge-zone${index === level ? " is-active" : ""}`}
            d={zoneArc(index)}
            style={{ stroke: zone.color }}
          />
        ))}
        <line className="risk-gauge-needle" x1={CX} y1={CY} x2={tip.x.toFixed(2)} y2={tip.y.toFixed(2)} />
        <circle className="risk-gauge-pivot" cx={CX} cy={CY} r={2.4} />
      </svg>
      <span className="risk-gauge-label">{label}</span>
    </span>
  );
}
