import { useState, useEffect } from "react";
import { Clock3, HardDrive, Image, Images, Library, RefreshCw, Video } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { formatBytes } from "../../../shared/utils";
import type { SystemStatus } from "../types";
import { StatusMetric, formatHours, formatClock } from "./StatusMetric";

export function GalleryStatsSection() {
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState("");

  const loadStatus = async () => {
    const payload = await api<{ status: SystemStatus }>("/api/status");
    setSystemStatus(payload.status);
  };

  useEffect(() => {
    loadStatus().catch((err) => setError(err instanceof Error ? err.message : "Unable to load stats"));
  }, []);

  const stats = systemStatus?.galleryStats;

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Digital Library</p>
          <h1>Gallery stats</h1>
        </div>
        <Button variant="secondary" compact onClick={() => loadStatus().catch((err) => setError(err instanceof Error ? err.message : "Unable to refresh stats"))}>
          <RefreshCw size={15} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {error && <MessageBox tone="error" title="Stats error">{error}</MessageBox>}

      {stats && (
        <div className="status-stack">
          <section className="status-block">
            <div className="status-block-head">
              <div>
                <p className="eyebrow">Catalog</p>
                <h2>Libraries & Media</h2>
              </div>
            </div>

            <div className="status-grid status-grid-four">
              <StatusMetric icon={Library} label="Total libraries" value={String(stats.totalLibraries)} />
              <StatusMetric icon={Images} label="Total items" value={String(stats.totalItems)} />
              <StatusMetric icon={HardDrive} label="Total size" value={formatBytes(stats.totalSizeBytes)} />
              <StatusMetric icon={Clock3} label="Video hours" value={formatHours(stats.totalDurationSeconds)} />
            </div>

            <div className="status-grid status-grid-four">
              <StatusMetric icon={Image} label="Photos" value={stats.totalPhotos.toLocaleString()} />
              <StatusMetric icon={Video} label="Videos" value={stats.totalVideos.toLocaleString()} />
            </div>

            <div className="status-subsection">
              <div className="status-table-title">
                <h3>Libraries</h3>
                <span>{stats.libraries.length} total</span>
              </div>
              {stats.libraries.length === 0 ? (
                <p className="status-empty">No gallery libraries have been added yet.</p>
              ) : (
                <div className="datagrid-wrap">
                  <table className="datagrid">
                    <thead>
                      <tr>
                        <th>Library</th>
                        <th className="col-num">Photos</th>
                        <th className="col-num">Videos</th>
                        <th className="col-num">Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.libraries.map((library) => (
                        <tr key={library.id}>
                          <td>
                            <div className="datagrid-primary">
                              <strong>{library.name}</strong>
                              <small>{library.itemCount} items · {formatBytes(library.totalSizeBytes)} on disk</small>
                            </div>
                          </td>
                          <td className="col-num datagrid-muted">{library.photoCount}</td>
                          <td className="col-num datagrid-muted">{library.videoCount}</td>
                          <td className="col-num datagrid-muted">{formatBytes(library.totalSizeBytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <section className="status-block">
            <div className="status-block-head">
              <div>
                <p className="eyebrow">Largest files</p>
                <h2>Top 10 Items by Size</h2>
              </div>
            </div>
            {stats.largestItems.length === 0 ? (
              <p className="status-empty">No gallery items have been catalogued yet.</p>
            ) : (
              <div className="datagrid-wrap">
                <table className="datagrid">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Library</th>
                      <th>Type</th>
                      <th className="col-num">Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.largestItems.map((item, index) => (
                      <tr key={item.id}>
                        <td>
                          <div className="datagrid-primary">
                            <strong>{index + 1}. {item.title}</strong>
                            {item.kind === "video" && item.durationSeconds > 0 && (
                              <small>{formatClock(item.durationSeconds)} long</small>
                            )}
                          </div>
                        </td>
                        <td className="datagrid-muted">{item.libraryName}</td>
                        <td className="datagrid-muted">{item.kind === "video" ? "Video" : "Photo"}</td>
                        <td className="col-num datagrid-muted">{formatBytes(item.totalSizeBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
