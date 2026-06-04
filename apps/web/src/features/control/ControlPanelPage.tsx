import type { PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute } from "../../router";
import type { ControlSection } from "../../router";
import {
  Activity,
  BookOpen,
  FileStack,
  HardDrive,
  Headphones,
  Image,
  ScrollText,
  Tags,
  UsersRound,
  Wrench
} from "lucide-react";
import { UsersSection } from "./sections/UsersSection";
import { InvitesSection } from "./sections/InvitesSection";
import { SessionsSection } from "./sections/SessionsSection";
import { LogsSection } from "./sections/LogsSection";
import { StatusSection } from "./sections/StatusSection";
import { AboutSection } from "./sections/AboutSection";
import { StorageSection } from "./sections/StorageSection";
import { LibrariesSection } from "./sections/LibrariesSection";
import { EbooksSection } from "./sections/EbooksSection";
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
    ebooks: "scene-page sputnik-storage-scene library-storage-scene",
    media: "scene-page sputnik-storage-scene library-storage-scene",
    otherMedia: "scene-page sputnik-storage-scene library-storage-scene",
    storage: "scene-page sputnik-storage-scene library-storage-scene"
  };
  const sceneClass = sceneClasses[section] ?? "";

  return (
    <DashboardShell active="control" user={user} logout={logout} sideNav={<ControlPanelNav section={section} />}>
      <div className={`control-panel control-panel-single${sceneClass ? ` ${sceneClass}` : ""}`}>
        <section className={`work-area control-work${section === "backup" ? " backup-control-work" : ""}`}>
          {(section === "users" || section === "groups" || section === "invites" || section === "sessions") && <AccountsSection section={section} currentUser={user} />}
          {section === "logs"      && <LogsSection />}
          {(section === "jobs" || section === "backup") && <MaintenanceSection section={section} />}
          {section === "status"    && <StatusSection />}
          {section === "about"     && <AboutSection />}
          {section === "storage"   && <StorageSection />}
          {(section === "libraries" || section === "librariesSpecial" || section === "librariesStats") && <AudiobooksControl section={section} />}
          {section === "ebooks"    && <EbooksSection />}
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

function ControlPanelNav({ section }: { section: ControlSection }) {
  return (
    <nav className="home-control-nav" aria-label="Management">
      <div className="home-control-group">
        <p>Application</p>
        <ControlNavLink icon={Activity} label="Status" href="/control/status" active={section === "status"} />
        <ControlNavLink icon={Tags} label="Labels" href="/control/categories" active={section === "categories" || section === "tags"} />
        <ControlNavLink icon={ScrollText} label="Logs" href="/control/logs" active={section === "logs"} />
        <ControlNavLink icon={Wrench} label="Maintenance" href="/control/maintenance" active={["jobs", "backup"].includes(section)} />
      </div>

      <div className="home-control-group">
        <p>Digital Library</p>
        <ControlNavLink icon={HardDrive} label="Storage" href="/control/storage" active={section === "storage"} />
        <ControlNavLink icon={Headphones} label="Audiobooks" href="/control/libraries" active={["libraries", "librariesSpecial", "librariesStats"].includes(section)} />
        <ControlNavLink icon={BookOpen} label="Ebooks" href="/control/ebooks" active={section === "ebooks"} />
        <ControlNavLink icon={Image} label="Gallery" href="/control/media" active={section === "media"} soon />
        <ControlNavLink icon={FileStack} label="Other Media" href="/control/other-media" active={section === "otherMedia"} soon />
      </div>

      <div className="home-control-group">
        <p>User administration</p>
        <ControlNavLink icon={UsersRound} label="Accounts" href="/control/accounts" active={["users", "groups", "invites", "sessions"].includes(section)} />
      </div>
    </nav>
  );
}

function ControlNavLink({
  icon: Icon,
  label,
  href,
  active,
  soon
}: {
  icon: typeof Activity;
  label: string;
  href: string;
  active: boolean;
  soon?: boolean;
}) {
  return (
    <a
      className={`home-nav-link${active ? " is-active" : ""}${soon ? " home-control-link-soon" : ""}`}
      href={href}
      onClick={(event) => followRoute(event, href)}
    >
      <Icon size={21} aria-hidden="true" />
      <span>{label}</span>
      {soon && <span className="control-soon-badge">Soon</span>}
    </a>
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
