import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Chart, type ChartType } from "chart.js/auto";

// Canvas can't resolve CSS custom properties, so chart colors are read from the
// live computed style at draw time — the same --mint/--blue/--rose/etc. tokens
// the rest of the app themes with (see styles/tokens.css), not hardcoded hex.
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export interface DashboardChartSeries {
  label: string;
  data: number[];
  /** A token name from tokens.css, e.g. "--mint". */
  colorVar: string;
}

export function DashboardChart({
  type,
  labels,
  series,
  stacked = false,
  height = 220
}: {
  type: Extract<ChartType, "line" | "bar">;
  labels: string[];
  series: DashboardChartSeries[];
  stacked?: boolean;
  height?: number;
}) {
  const { t } = useTranslation(["common", "controlDash"]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const muted = cssVar("--muted", "#888888");
    const line = cssVar("--line", "#dddddd");

    const datasets = series.map((s) => {
      const color = cssVar(s.colorVar, "#888888");
      return type === "line"
        ? {
            label: s.label,
            data: s.data,
            borderColor: color,
            backgroundColor: `${color}22`,
            fill: true,
            tension: 0.3,
            pointRadius: 2,
            borderWidth: 2
          }
        : {
            label: s.label,
            data: s.data,
            backgroundColor: color,
            borderRadius: 4
          };
    });

    chartRef.current?.destroy();
    chartRef.current = new Chart(canvas, {
      type,
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            stacked,
            grid: { display: false },
            ticks: { color: muted, font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 7 }
          },
          y: {
            stacked,
            beginAtZero: true,
            grid: { color: line },
            ticks: { color: muted, font: { size: 11 }, precision: 0 }
          }
        }
      }
    });

    return () => chartRef.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, stacked, JSON.stringify(labels), JSON.stringify(series)]);

  return (
    <div style={{ position: "relative", width: "100%", height }}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={t(type === "line" ? "controlDash:chart.lineAria" : "controlDash:chart.barAria", { series: series.map((s) => s.label).join(", ") })}
      />
    </div>
  );
}

export function DashboardChartLegend({ series }: { series: DashboardChartSeries[] }) {
  return (
    <div className="dashboard-chart-legend">
      {series.map((s) => (
        <span key={s.label} className="dashboard-chart-legend-item">
          <span className="dashboard-chart-legend-swatch" style={{ background: `var(${s.colorVar})` }} aria-hidden="true" />
          {s.label}
        </span>
      ))}
    </div>
  );
}
