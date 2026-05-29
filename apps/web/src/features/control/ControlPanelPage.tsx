import type { PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute } from "../../router";
import type { ControlSection } from "../../router";
import { UsersSection } from "./sections/UsersSection";
import { InvitesSection } from "./sections/InvitesSection";
import { SessionsSection } from "./sections/SessionsSection";
import { LogsSection } from "./sections/LogsSection";
import { StatusSection } from "./sections/StatusSection";
import { AboutSection } from "./sections/AboutSection";
import { StorageSection } from "./sections/StorageSection";
import { LibrariesSection } from "./sections/LibrariesSection";

export function ControlPanelPage({
  section,
  user,
  logout
}: {
  section: ControlSection;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const sceneClasses: Partial<Record<ControlSection, string>> = {
    status: "scene-page rocket-scene status-scene",
    about: "scene-page sputnik-scene about-scene",
    users: "scene-page cosmonaut-scene user-admin-scene",
    invites: "scene-page cosmonaut-scene user-admin-scene",
    sessions: "scene-page cosmonaut-scene user-admin-scene",
    logs: "scene-page control-center-scene logs-scene",
    libraries: "scene-page audiobook-scene library-storage-scene",
    storage: "scene-page audiobook-scene library-storage-scene"
  };
  const sceneClass = sceneClasses[section] ?? "";

  return (
    <DashboardShell active="control" user={user} logout={logout}>
      <div className={`control-panel${sceneClass ? ` ${sceneClass}` : ""}`}>
        <aside className="control-nav">
          <nav className="control-links" aria-label="Management">
            <div className="control-group">
              <p>Application</p>
              <a className={section === "status" ? "active" : ""} href="/control/status" onClick={(event) => followRoute(event, "/control/status")}>Status</a>
              <a className={section === "storage" ? "active" : ""} href="/control/storage" onClick={(event) => followRoute(event, "/control/storage")}>Storage</a>
              <a className={section === "libraries" ? "active" : ""} href="/control/libraries" onClick={(event) => followRoute(event, "/control/libraries")}>Digital Library</a>
              <a className={section === "logs" ? "active" : ""} href="/control/logs" onClick={(event) => followRoute(event, "/control/logs")}>Logs</a>
              <a className={section === "about" ? "active" : ""} href="/control/about" onClick={(event) => followRoute(event, "/control/about")}>About</a>
            </div>
            <div className="control-group">
              <p>User administration</p>
              <a className={section === "users" ? "active" : ""} href="/control/users" onClick={(event) => followRoute(event, "/control/users")}>Users</a>
              <a className={section === "invites" ? "active" : ""} href="/control/invites" onClick={(event) => followRoute(event, "/control/invites")}>Invite links</a>
              <a className={section === "sessions" ? "active" : ""} href="/control/sessions" onClick={(event) => followRoute(event, "/control/sessions")}>Sessions</a>
            </div>
          </nav>
        </aside>
        <section className="work-area control-work">
          {section === "users"     && <UsersSection currentUser={user} />}
          {section === "invites"   && <InvitesSection />}
          {section === "sessions"  && <SessionsSection />}
          {section === "logs"      && <LogsSection />}
          {section === "status"    && <StatusSection />}
          {section === "about"     && <AboutSection />}
          {section === "storage"   && <StorageSection />}
          {section === "libraries" && <LibrariesSection />}
        </section>
      </div>
    </DashboardShell>
  );
}
