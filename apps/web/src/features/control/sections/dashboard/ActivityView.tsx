import { Download, HardDrive, LogIn, Trash2, Upload } from "lucide-react";
import { formatBytes } from "../../../../shared/utils";
import { StatusMetric } from "../StatusMetric";
import type { DashboardSummary, SystemStatus } from "../../types";
import { DashboardChart, DashboardChartLegend } from "./DashboardChart";

export function ActivityView({ summary, status }: { summary: DashboardSummary; status: SystemStatus }) {
  const storageBytes = status.libraryStats.totalSizeBytes + status.ebookStats.totalSizeBytes + status.galleryStats.totalSizeBytes;

  const loginSeries = [
    { label: "Successful", data: summary.series.loginsSuccess, colorVar: "--mint" },
    { label: "Failed", data: summary.series.loginsFailed, colorVar: "--rose" }
  ];
  const contentSeries = [
    { label: "Uploads", data: summary.series.uploads, colorVar: "--blue" },
    { label: "Downloads", data: summary.series.downloads, colorVar: "--gold" },
    { label: "Deletes", data: summary.series.deletes, colorVar: "--rose" }
  ];

  return (
    <div className="status-stack">
      <section className="status-block">
        <div className="status-grid status-grid-four">
          <StatusMetric icon={LogIn} label="Logins (24h)" value={String(summary.kpis.logins24h)} />
          <StatusMetric icon={Upload} label="Uploads (7d)" value={String(summary.kpis.uploads7d)} />
          <StatusMetric icon={Download} label="Downloads (7d)" value={String(summary.kpis.downloads7d)} />
          <StatusMetric icon={Trash2} label="Deletes (7d)" value={String(summary.kpis.deletes7d)} />
          <StatusMetric icon={HardDrive} label="Storage used" value={formatBytes(storageBytes)} />
        </div>

        <div className="status-subsection">
          <div className="status-table-title">
            <h3>Logins, last {summary.days.length} days</h3>
          </div>
          <DashboardChartLegend series={loginSeries} />
          <DashboardChart type="line" labels={summary.days} series={loginSeries} />
        </div>

        <div className="status-subsection">
          <div className="status-table-title">
            <h3>Content activity, last {summary.days.length} days</h3>
          </div>
          <DashboardChartLegend series={contentSeries} />
          <DashboardChart type="bar" labels={summary.days} series={contentSeries} stacked />
        </div>
      </section>
    </div>
  );
}
