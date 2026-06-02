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
import { AudiobookStatsSection } from "./sections/AudiobookStatsSection";
import { BackupSection } from "./sections/BackupSection";
import { CategoriesSection, CategoryEditorPage } from "./sections/CategoriesSection";
import { TagsSection } from "./sections/TagsSection";
import { GroupsSection } from "./sections/GroupsSection";
import { JobsSection } from "./sections/JobsSection";

export function ControlPanelPage({
  section,
  categoryId,
  user,
  logout
}: {
  section: ControlSection;
  categoryId?: string | null;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const sceneClasses: Partial<Record<ControlSection, string>> = {
    status: "scene-page rocket-scene status-scene",
    about: "scene-page sputnik-scene about-scene",
    users: "scene-page cosmonaut-scene user-admin-scene",
    groups: "scene-page cosmonaut-scene user-admin-scene",
    invites: "scene-page cosmonaut-scene user-admin-scene",
    sessions: "scene-page cosmonaut-scene user-admin-scene",
    logs: "scene-page control-center-scene logs-scene",
    jobs: "scene-page job-queue-scene logs-scene",
    libraries: "scene-page sputnik-storage-scene library-storage-scene",
    librariesSpecial: "scene-page sputnik-storage-scene library-storage-scene",
    librariesStats: "scene-page sputnik-storage-scene library-storage-scene",
    media: "scene-page sputnik-storage-scene library-storage-scene",
    otherMedia: "scene-page sputnik-storage-scene library-storage-scene",
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
              <a className={section === "categories" || section === "tags" ? "active" : ""} href="/control/categories" onClick={(event) => followRoute(event, "/control/categories")}>Labels</a>
              <a className={section === "logs" ? "active" : ""} href="/control/logs" onClick={(event) => followRoute(event, "/control/logs")}>Logs</a>
              <a className={["jobs", "backup"].includes(section) ? "active" : ""} href="/control/maintenance" onClick={(event) => followRoute(event, "/control/maintenance")}>Maintenance</a>
            </div>
            <div className="control-group">
              <p>Digital Library</p>
              <a className={section === "storage" ? "active" : ""} href="/control/storage" onClick={(event) => followRoute(event, "/control/storage")}>Storage</a>
              <a className={["libraries", "librariesSpecial", "librariesStats"].includes(section) ? "active" : ""} href="/control/libraries" onClick={(event) => followRoute(event, "/control/libraries")}>Audiobooks</a>
              <a className={`control-link-soon${section === "media" ? " active" : ""}`} href="/control/media" onClick={(event) => followRoute(event, "/control/media")}>Gallery<span className="control-soon-badge">Soon</span></a>
              <a className={`control-link-soon${section === "otherMedia" ? " active" : ""}`} href="/control/other-media" onClick={(event) => followRoute(event, "/control/other-media")}>Other Media<span className="control-soon-badge">Soon</span></a>
            </div>
            <div className="control-group">
              <p>User administration</p>
              <a className={["users", "groups", "invites", "sessions"].includes(section) ? "active" : ""} href="/control/accounts" onClick={(event) => followRoute(event, "/control/accounts")}>Accounts</a>
            </div>
          </nav>
        </aside>
        <section className={`work-area control-work${section === "backup" ? " backup-control-work" : ""}`}>
          {(section === "users" || section === "groups" || section === "invites" || section === "sessions") && <AccountsSection section={section} currentUser={user} />}
          {section === "logs"      && <LogsSection />}
          {(section === "jobs" || section === "backup") && <MaintenanceSection section={section} />}
          {section === "status"    && <StatusSection />}
          {section === "about"     && <AboutSection />}
          {section === "storage"   && <StorageSection />}
          {(section === "libraries" || section === "librariesSpecial" || section === "librariesStats") && <AudiobooksControl section={section} />}
          {section === "media"     && <ComingSoonSection title="Gallery" blurb="Photo and video library types — albums, thumbnails, and streaming playback — are planned." />}
          {section === "otherMedia" && <ComingSoonSection title="Other Media" blurb="A flexible library type for media that isn't an audiobook, photo, or video is planned." />}
          {section === "categories" && categoryId !== undefined && <CategoryEditorPage categoryId={categoryId} />}
          {section === "categories" && categoryId === undefined && <TaxonomySection section="categories" />}
          {section === "tags"      && <TaxonomySection section="tags" />}
        </section>
      </div>
    </DashboardShell>
  );
}

interface ControlTab {
  label: string;
  href: string;
  active: boolean;
  soon?: boolean;
}

// Shared in-page tab bar for the grouped control sections (Audiobooks, Labels,
// Accounts, Maintenance). Each tab is a real link so it stays deep-linkable.
function ControlTabs({ tabs }: { tabs: ControlTab[] }) {
  return (
    <div className="control-tabs" role="tablist">
      {tabs.map((tab) => (
        <a
          key={tab.href}
          role="tab"
          aria-selected={tab.active}
          className={`${tab.soon ? "control-tab-soon" : ""}${tab.active ? " active" : ""}`.trim()}
          href={tab.href}
          onClick={(event) => followRoute(event, tab.href)}
        >
          {tab.label}
          {tab.soon && <span className="control-soon-badge">Soon</span>}
        </a>
      ))}
    </div>
  );
}

function AudiobooksControl({ section }: { section: "libraries" | "librariesSpecial" | "librariesStats" }) {
  return (
    <>
      <ControlTabs tabs={[
        { label: "Audiobooks", href: "/control/libraries", active: section === "libraries" },
        { label: "Special libraries", href: "/control/libraries/special", active: section === "librariesSpecial" },
        { label: "Stats", href: "/control/libraries/stats", active: section === "librariesStats" }
      ]} />
      {section === "libraries"        && <LibrariesSection tab="audiobooks" />}
      {section === "librariesSpecial" && <LibrariesSection tab="special" />}
      {section === "librariesStats"   && <AudiobookStatsSection />}
    </>
  );
}

function TaxonomySection({ section }: { section: "categories" | "tags" }) {
  return (
    <>
      <ControlTabs tabs={[
        { label: "Categories", href: "/control/categories", active: section === "categories" },
        { label: "Tags", href: "/control/categories/tags", active: section === "tags" }
      ]} />
      {section === "categories" && <CategoriesSection />}
      {section === "tags"       && <TagsSection />}
    </>
  );
}

function AccountsSection({ section, currentUser }: { section: "users" | "groups" | "invites" | "sessions"; currentUser: PublicUser }) {
  return (
    <>
      <ControlTabs tabs={[
        { label: "Users", href: "/control/accounts", active: section === "users" },
        { label: "Groups", href: "/control/accounts/groups", active: section === "groups" },
        { label: "Invite links", href: "/control/accounts/invites", active: section === "invites" },
        { label: "Sessions", href: "/control/accounts/sessions", active: section === "sessions" }
      ]} />
      {section === "users"    && <UsersSection currentUser={currentUser} />}
      {section === "groups"   && <GroupsSection />}
      {section === "invites"  && <InvitesSection />}
      {section === "sessions" && <SessionsSection />}
    </>
  );
}

function MaintenanceSection({ section }: { section: "jobs" | "backup" }) {
  return (
    <>
      <ControlTabs tabs={[
        { label: "Jobs", href: "/control/maintenance", active: section === "jobs" },
        { label: "Backup", href: "/control/maintenance/backup", active: section === "backup" }
      ]} />
      {section === "jobs"   && <JobsSection />}
      {section === "backup" && <BackupSection />}
    </>
  );
}

function ComingSoonSection({ title, blurb }: { title: string; blurb: string }) {
  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Digital Library</p>
          <h1>{title}</h1>
        </div>
      </div>
      <div className="empty-state">
        <h2>Coming soon</h2>
        <p className="muted">{blurb}</p>
      </div>
    </>
  );
}
