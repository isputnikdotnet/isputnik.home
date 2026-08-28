import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Fingerprint, Globe2, LayoutDashboard, LibraryBig, LineChart, ListTodo, Monitor } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { controlHref } from "../../../router";
import { ControlSectionHead } from "../ControlSectionHead";
import type { DbInfo, SystemStatus } from "../types";
import { SystemView } from "./dashboard/SystemView";
import { ActivityView } from "./dashboard/ActivityView";
import { SignInsView } from "./dashboard/SignInsView";
import { LocationsView } from "./dashboard/LocationsView";
import { LibrariesView } from "./dashboard/LibrariesView";
import { TasksView } from "./dashboard/TasksView";

// Overview › Dashboard. This used to be two pages — "System" (server health) and
// "Dashboard" (activity trends) — folded into one, with a lighter secondary tab
// strip switching between them: real tabs (not a dropdown), but visually distinct
// from the page-level tab row above so it doesn't read as a second copy of it.
type DashboardView = "system" | "activity" | "libraries" | "tasks" | "signins" | "locations";

const DASHBOARD_VIEW_LABEL_KEYS: Record<DashboardView, "viewSignIns" | "viewLocations" | "viewActivity" | "viewLibraries" | "viewTasks" | "viewSystem"> = {
  signins: "viewSignIns",
  locations: "viewLocations",
  activity: "viewActivity",
  libraries: "viewLibraries",
  tasks: "viewTasks",
  system: "viewSystem"
};

// Sign-ins leads: "who got in, and from where" is what this page gets opened for.
const DASHBOARD_VIEW_ORDER: { value: DashboardView; icon: ReactNode }[] = [
  { value: "signins", icon: <Fingerprint size={15} aria-hidden="true" /> },
  { value: "locations", icon: <Globe2 size={15} aria-hidden="true" /> },
  { value: "activity", icon: <LineChart size={15} aria-hidden="true" /> },
  { value: "libraries", icon: <LibraryBig size={15} aria-hidden="true" /> },
  { value: "tasks", icon: <ListTodo size={15} aria-hidden="true" /> },
  { value: "system", icon: <Monitor size={15} aria-hidden="true" /> }
];

// Views that used to be their own tab and now live inside another one. Content
// activity and Reading and playback folded into Activity in 3.14; Devices went
// to Sign-ins, which lists the same sessions with revoke; and Logins itself was
// absorbed by Sign-ins, which answers everything it did and says where from.
// The addresses keep resolving so a bookmark lands on the page that took the
// work over rather than on whatever now happens to open first.
const RETIRED_VIEWS: Record<string, DashboardView> = {
  content: "activity",
  playback: "activity",
  devices: "signins",
  logins: "signins"
};

// Statistics and Tasks were pages of their own until they became views here.
// The router aliases their old paths to this section without rewriting them,
// so the path is what says which view was meant.
const LEGACY_PATH_VIEWS: [RegExp, DashboardView][] = [
  [/(statistics|stats)\/?$/, "libraries"],
  [/(tasks|jobs)\/?$/, "tasks"],
  // Sign-ins was an Overview tab of its own, and Sessions a Members one before
  // that; both are this view now.
  [/(sign-ins|sessions)\/?$/, "signins"]
];

function viewFromLegacyPath(): DashboardView | null {
  const match = LEGACY_PATH_VIEWS.find(([pattern]) => pattern.test(window.location.pathname));
  return match ? match[1] : null;
}

function viewFromUrl(): DashboardView {
  const legacy = viewFromLegacyPath();
  if (legacy) return legacy;
  const value = new URLSearchParams(window.location.search).get("view");
  if (value && value in RETIRED_VIEWS) return RETIRED_VIEWS[value];
  return DASHBOARD_VIEW_ORDER.some((entry) => entry.value === value) ? (value as DashboardView) : "signins";
}

export function DashboardSection() {
  const { t } = useTranslation(["common", "controlDash"]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<DashboardView>(viewFromUrl);

  const load = async () => {
    const statusPayload = await api<{ status: SystemStatus }>("/api/status");
    setStatus(statusPayload.status);
    // Database details are secondary — load them separately so a db-info failure
    // never hides the rest of the page.
    api<{ db: DbInfo }>("/api/db/info")
      .then((dbPayload) => setDbInfo(dbPayload.db))
      .catch(() => setDbInfo(null));
  };

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : t("controlDash:dash.loadFailed")));
  }, []);

  // Tidy a retired name or an old path into the address that exists today.
  // replaceState, so the back button doesn't return to a dead address — and the
  // rest of the query string is carried over, because a Sign-ins link arriving
  // at /control/overview/sign-ins?ip=… is a dive, not just a page.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("view");
    const target = requested
      ? requested in RETIRED_VIEWS
        ? RETIRED_VIEWS[requested]
        : null
      : viewFromLegacyPath();
    if (!target) return;
    params.set("view", target);
    window.history.replaceState(window.history.state, "", `${controlHref("dashboard")}?${params}`);
  }, []);

  // Links from elsewhere in the panel — a Locations arrow, a name on the Logs
  // page — land on this section with only the query string changed, so the route
  // itself never re-runs. Reading the view back on popstate is what makes them
  // arrive on the right tab instead of leaving whichever one was already open.
  useEffect(() => {
    const onPop = () => {
      if (window.location.pathname.startsWith("/control")) setView(viewFromUrl());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const chooseView = (next: DashboardView) => {
    // Clicking the tab you are already on is not a navigation and must not be
    // treated as one: Sign-ins would lose the dive out of its query string
    // while the scope chip went on showing it.
    if (next === view) return;
    setView(next);
    // The opening view owns the bare address; the others name themselves. A
    // dive's scope belongs to the tab being left, so it is dropped here.
    const href = next === "signins" ? controlHref("dashboard") : `${controlHref("dashboard")}?view=${next}`;
    window.history.replaceState(window.history.state, "", href);
  };

  return (
    <>
      <ControlSectionHead
        section="dashboard"
        icon={<LayoutDashboard size={30} />}
        description={t("controlDash:dash.description")}
      >
        <RefreshButton
          onRefresh={async () => {
            setError("");
            try {
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : t("controlDash:dash.refreshFailed"));
              throw err;
            }
          }}
        />
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlDash:dash.errorTitle")}>{error}</MessageBox>}

      <div className="dashboard-subtabs" role="tablist" aria-label={t("controlDash:dash.viewsAria")}>
        {DASHBOARD_VIEW_ORDER.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={view === entry.value}
            className={view === entry.value ? "active" : undefined}
            onClick={() => chooseView(entry.value)}
          >
            {entry.icon}
            {t(`controlDash:dash.${DASHBOARD_VIEW_LABEL_KEYS[entry.value]}`)}
          </button>
        ))}
      </div>

      {status && view === "system" && <SystemView status={status} dbInfo={dbInfo} />}
      {status && view === "libraries" && <LibrariesView status={status} />}
      {view === "tasks" && <TasksView />}
      {status && view === "activity" && <ActivityView status={status} />}
      {view === "signins" && <SignInsView />}
      {view === "locations" && <LocationsView />}
    </>
  );
}
