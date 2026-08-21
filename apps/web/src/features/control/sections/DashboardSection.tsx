import { useEffect, useState, type ReactNode } from "react";
import { Globe2, LayoutDashboard, LineChart, LogIn, Monitor, PlayCircle, Upload } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { controlHref } from "../../../router";
import { ControlSectionHead } from "../ControlSectionHead";
import type { DashboardSummary, DbInfo, SystemStatus } from "../types";
import { SystemView } from "./dashboard/SystemView";
import { ActivityView } from "./dashboard/ActivityView";
import { LoginsView } from "./dashboard/LoginsView";
import { LocationsView } from "./dashboard/LocationsView";
import { ContentActivityView } from "./dashboard/ContentActivityView";
import { PlaybackView } from "./dashboard/PlaybackView";

// Overview › Dashboard. This used to be two pages — "System" (server health) and
// "Dashboard" (activity trends) — folded into one, with a lighter secondary tab
// strip switching between them: real tabs (not a dropdown), but visually distinct
// from the page-level tab row above so it doesn't read as a second copy of it.
type DashboardView = "system" | "activity" | "logins" | "locations" | "content" | "playback";

// Logins leads: "who got in, and from where" is what this page gets opened for.
const DASHBOARD_VIEWS: { value: DashboardView; label: string; icon: ReactNode }[] = [
  { value: "logins", label: "Logins", icon: <LogIn size={15} aria-hidden="true" /> },
  { value: "locations", label: "Locations", icon: <Globe2 size={15} aria-hidden="true" /> },
  { value: "activity", label: "Activity", icon: <LineChart size={15} aria-hidden="true" /> },
  { value: "system", label: "System", icon: <Monitor size={15} aria-hidden="true" /> },
  { value: "content", label: "Content activity", icon: <Upload size={15} aria-hidden="true" /> },
  { value: "playback", label: "Reading and playback", icon: <PlayCircle size={15} aria-hidden="true" /> }
];

function viewFromUrl(): DashboardView {
  const value = new URLSearchParams(window.location.search).get("view");
  return DASHBOARD_VIEWS.some((entry) => entry.value === value) ? (value as DashboardView) : "logins";
}

export function DashboardSection() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<DashboardView>(viewFromUrl);

  const load = async () => {
    const [statusPayload, summaryPayload] = await Promise.all([
      api<{ status: SystemStatus }>("/api/status"),
      api<DashboardSummary>("/api/dashboard/summary?days=14")
    ]);
    setStatus(statusPayload.status);
    setSummary(summaryPayload);
    // Database details are secondary — load them separately so a db-info failure
    // never hides the rest of the page.
    api<{ db: DbInfo }>("/api/db/info")
      .then((dbPayload) => setDbInfo(dbPayload.db))
      .catch(() => setDbInfo(null));
  };

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Unable to load dashboard"));
  }, []);

  // Devices lived here as a view until 3.12, when it merged into Overview ›
  // Sign-ins. An old bookmark lands there rather than silently falling back to
  // Logins; replaceState, so the back button doesn't return to a dead address.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("view") === "devices") {
      window.history.replaceState({}, "", controlHref("signins"));
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, []);

  const chooseView = (next: DashboardView) => {
    setView(next);
    const href = next === "logins" ? controlHref("dashboard") : `${controlHref("dashboard")}?view=${next}`;
    window.history.replaceState({}, "", href);
  };

  return (
    <>
      <ControlSectionHead
        section="dashboard"
        icon={<LayoutDashboard size={30} />}
        description="Server health, and activity trends: logins, uploads, downloads, deletes, and what's being read or played."
      >
        <RefreshButton
          onRefresh={async () => {
            setError("");
            try {
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Unable to refresh dashboard");
              throw err;
            }
          }}
        />
      </ControlSectionHead>

      {error && <MessageBox tone="error" title="Dashboard error">{error}</MessageBox>}

      <div className="dashboard-subtabs" role="tablist" aria-label="Dashboard views">
        {DASHBOARD_VIEWS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={view === entry.value}
            className={view === entry.value ? "active" : undefined}
            onClick={() => chooseView(entry.value)}
          >
            {entry.icon}
            {entry.label}
          </button>
        ))}
      </div>

      {status && view === "system" && <SystemView status={status} dbInfo={dbInfo} />}
      {status && summary && view === "activity" && <ActivityView summary={summary} status={status} />}
      {view === "logins" && <LoginsView />}
      {view === "locations" && <LocationsView />}
      {view === "content" && <ContentActivityView />}
      {view === "playback" && <PlaybackView />}
    </>
  );
}
