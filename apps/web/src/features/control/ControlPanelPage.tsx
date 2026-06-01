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
import { CategoriesSection } from "./sections/CategoriesSection";
import { GroupsSection } from "./sections/GroupsSection";
import { JobsSection } from "./sections/JobsSection";
import { DatabaseSection } from "./sections/DatabaseSection";

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
    jobs: "scene-page job-queue-scene logs-scene",
    libraries: "scene-page sputnik-storage-scene library-storage-scene",
    storage: "scene-page sputnik-storage-scene library-storage-scene"
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
              <a className={section === "categories" ? "active" : ""} href="/control/categories" onClick={(event) => followRoute(event, "/control/categories")}>Categories</a>
              <a className={section === "logs" ? "active" : ""} href="/control/logs" onClick={(event) => followRoute(event, "/control/logs")}>Logs</a>
              <a className={section === "jobs" ? "active" : ""} href="/control/jobs" onClick={(event) => followRoute(event, "/control/jobs")}>Jobs</a>
              <a className={section === "database" ? "active" : ""} href="/control/database" onClick={(event) => followRoute(event, "/control/database")}>Database</a>
            </div>
            <div className="control-group">
              <p>User administration</p>
              <a className={section === "users" ? "active" : ""} href="/control/users" onClick={(event) => followRoute(event, "/control/users")}>Users</a>
              <a className={section === "groups" ? "active" : ""} href="/control/groups" onClick={(event) => followRoute(event, "/control/groups")}>Groups</a>
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
          {section === "categories" && <CategoriesSection />}
          {section === "groups"    && <GroupsSection />}
          {section === "jobs"      && <JobsSection />}
          {section === "database"  && <DatabaseSection />}
        </section>
      </div>
    </DashboardShell>
  );
}
