import type { PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute } from "../../router";
import type { ControlSection } from "../../router";
import {
  Activity,
  HardDrive,
  Home,
  LibraryBig,
  ScrollText,
  Settings,
  Tags,
  Trash2,
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
import { AudiobookStatsSection } from "./sections/AudiobookStatsSection";
import { BackupSection } from "./sections/BackupSection";
import { CategoriesSection, CategoryEditorPage } from "./sections/CategoriesSection";
import { TagsSection } from "./sections/TagsSection";
import { GroupsSection } from "./sections/GroupsSection";
import { JobsSection } from "./sections/JobsSection";
import { ConfigSection } from "./sections/ConfigSection";
import { RecycleBinSection } from "./sections/RecycleBinSection";

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
  return (
    <DashboardShell active="control" user={user} logout={logout} sideNav={<ControlPanelNav section={section} />}>
      <div className="control-panel control-panel-single">
        <section className={`work-area control-work${section === "backup" ? " backup-control-work" : ""}`}>
          {(section === "users" || section === "groups" || section === "invites" || section === "sessions") && <AccountsSection section={section} currentUser={user} />}
          {section === "logs"      && <LogsSection />}
          {(section === "jobs" || section === "backup") && <MaintenanceSection section={section} />}
          {(section === "status" || section === "statusStats") && <StatusControl section={section} />}
          {section === "config"    && <ConfigSection />}
          {section === "about"     && <AboutSection />}
          {section === "storage"   && <StorageSection />}
          {section === "libraries" && <LibrariesSection currentUser={user} />}
          {section === "recycleBin" && <RecycleBinSection />}
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
      <ControlNavLink icon={Home} label="Home" href="/" active={false} />

      <div className="home-control-group">
        <p>Application</p>
        <ControlNavLink icon={Activity} label="Status" href="/control/status" active={["status", "statusStats"].includes(section)} />
        <ControlNavLink icon={Settings} label="Config" href="/control/config" active={section === "config"} />
        <ControlNavLink icon={Tags} label="Labels" href="/control/categories" active={section === "categories" || section === "tags"} />
        <ControlNavLink icon={ScrollText} label="Logs" href="/control/logs" active={section === "logs"} />
        <ControlNavLink icon={Wrench} label="Maintenance" href="/control/maintenance" active={["jobs", "backup"].includes(section)} />
      </div>

      <div className="home-control-group">
        <p>Digital Library</p>
        <ControlNavLink icon={HardDrive} label="Storage" href="/control/storage" active={section === "storage"} />
        <ControlNavLink icon={LibraryBig} label="Libraries" href="/control/libraries" active={section === "libraries"} />
        <ControlNavLink icon={Trash2} label="Recycle Bin" href="/control/recycle-bin" active={section === "recycleBin"} />
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
  active
}: {
  icon: typeof Activity;
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <a
      className={`home-nav-link${active ? " is-active" : ""}`}
      href={href}
      onClick={(event) => followRoute(event, href)}
    >
      <Icon size={21} aria-hidden="true" />
      <span>{label}</span>
    </a>
  );
}

interface ControlTab {
  label: string;
  href: string;
  active: boolean;
  soon?: boolean;
}

// Shared in-page tab bar for the grouped control sections (Status, Labels,
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

function StatusControl({ section }: { section: "status" | "statusStats" }) {
  return (
    <>
      <ControlTabs tabs={[
        { label: "System", href: "/control/status", active: section === "status" },
        { label: "Audiobook stats", href: "/control/status/audiobook-stats", active: section === "statusStats" }
      ]} />
      {section === "status"      && <StatusSection />}
      {section === "statusStats" && <AudiobookStatsSection />}
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

