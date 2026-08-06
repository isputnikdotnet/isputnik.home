import { useCallback, useState } from "react";
import { ChevronDown, Home, Search } from "lucide-react";
import type { PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { controlHref, followRoute } from "../../router";
import type { ControlSection } from "../../router";
import {
  CONTROL_GROUPS,
  groupForSection,
  navChildrenFor,
  sectionContext,
  type ControlTabDef
} from "./nav";
import { ControlSearch, useControlSearchShortcut } from "./ControlSearch";
import { UsersSection } from "./sections/UsersSection";
import { InvitesSection } from "./sections/InvitesSection";
import { SessionsSection } from "./sections/SessionsSection";
import { LogsSection } from "./sections/LogsSection";
import { StatusSection } from "./sections/StatusSection";
import { AboutSection } from "./sections/AboutSection";
import { StorageSection } from "./sections/StorageSection";
import { LibrariesSection } from "./sections/LibrariesSection";
import { StatisticsSection } from "./sections/StatisticsSection";
import { BackupSection } from "./sections/BackupSection";
import { CategoriesSection, CategoryEditorPage } from "./sections/CategoriesSection";
import { TagsSection } from "./sections/TagsSection";
import { GroupsSection } from "./sections/GroupsSection";
import { TasksSection } from "./sections/TasksSection";
import { ScheduledJobsSection } from "./sections/ScheduledJobsSection";
import { MissingPhotosSection } from "./sections/MissingPhotosSection";
import { DuplicateCleanupSection } from "./sections/duplicates/DuplicateCleanupSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { MailSection } from "./sections/MailSection";
import { OpdsAccessSection } from "./sections/OpdsAccessSection";
import { SecuritySection } from "./sections/SecuritySection";
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
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useControlSearchShortcut(openSearch);

  const group = groupForSection(section);
  // The category editor is a sub-page of Categories, not a tab of its own, so it
  // keeps the nav highlight but drops the tab row.
  const editingCategory = section === "categories" && categoryId !== undefined;

  return (
    <DashboardShell
      active="control"
      user={user}
      logout={logout}
      sideNav={<ControlPanelNav section={section} onSearch={openSearch} />}
    >
      <div className="control-panel control-panel-single">
        <section className={`work-area control-work${section === "backup" ? " backup-control-work" : ""}`}>
          {!editingCategory && group.tabs.length > 1 && (
            <ControlTabs tabs={group.tabs} section={section} label={`${group.label} sections`} />
          )}
          <ControlSectionBody section={section} categoryId={categoryId} currentUser={user} />
        </section>
      </div>

      {searchOpen && <ControlSearch onClose={() => setSearchOpen(false)} />}
    </DashboardShell>
  );
}

function ControlSectionBody({
  section,
  categoryId,
  currentUser
}: {
  section: ControlSection;
  categoryId?: string | null;
  currentUser: PublicUser;
}) {
  switch (section) {
    case "status":          return <StatusSection />;
    case "stats":           return <StatisticsSection />;
    case "tasks":           return <TasksSection />;
    case "logs":            return <LogsSection />;

    case "libraries":       return <LibrariesSection />;
    case "storage":         return <StorageSection />;
    case "categories":      return categoryId !== undefined ? <CategoryEditorPage categoryId={categoryId} /> : <CategoriesSection />;
    case "tags":            return <TagsSection />;

    case "users":           return <UsersSection currentUser={currentUser} />;
    case "groups":          return <GroupsSection />;
    case "invites":         return <InvitesSection />;
    case "sessions":        return <SessionsSection />;

    case "security":
    case "securityPolicies":
    case "securityTrusted":
    case "securityBlocked": return <SecuritySection section={section} />;

    case "backup":          return <BackupSection />;
    case "scheduledJobs":   return <ScheduledJobsSection />;
    case "recycleBin":      return <RecycleBinSection currentUser={currentUser} />;
    case "missingPhotos":   return <MissingPhotosSection />;
    case "duplicateCleanup": return <DuplicateCleanupSection currentUser={currentUser} />;

    case "appearance":      return <AppearanceSection />;
    case "email":           return <MailSection />;
    case "readerAccess":    return <OpdsAccessSection />;
    case "about":           return <AboutSection />;
  }
}

function ControlPanelNav({ section, onSearch }: { section: ControlSection; onSearch: () => void }) {
  const activeGroup = groupForSection(section);
  const activeContext = sectionContext(section);
  // Open on the branch you are standing in. Landing on a page whose group shows as a
  // collapsed toggle — with nothing marked current anywhere — reads as having left
  // the nav behind entirely.
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(
    () => (activeContext ? new Set([activeGroup.key]) : new Set())
  );
  const toggleBranch = useCallback((key: string) => {
    setExpandedBranches((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  return (
    <nav className="home-control-nav" aria-label="Control panel">
      {/* The way back out, first — the same position Home holds in the main nav,
          so leaving the control panel is where the hand already expects it. */}
      <a className="home-nav-link control-nav-exit" href="/" onClick={(event) => followRoute(event, "/")}>
        <Home size={21} aria-hidden="true" />
        <span>Home</span>
      </a>

      <div className="home-control-group">
        {CONTROL_GROUPS.map((group) => {
          const Icon = group.icon;
          const active = group.key === activeGroup.key;
          // Each group links to its first tab, which is its landing page.
          const href = controlHref(group.tabs[0].section);
          // Derived from the tabs' own `context`, so a second Gallery tab joins the
          // Gallery branch rather than adding a second link with the same name.
          const nestedLinks = navChildrenFor(group);
          const expanded = expandedBranches.has(group.key);
          const nestedId = `control-nav-${group.key}-nested`;
          return (
            <div className="control-nav-branch" key={group.key}>
              {nestedLinks.length > 0 ? (
                <button
                  type="button"
                  className={`home-nav-link control-nav-toggle${active ? " is-active" : ""}`}
                  aria-expanded={expanded}
                  aria-controls={nestedId}
                  onClick={() => toggleBranch(group.key)}
                >
                  <Icon size={21} aria-hidden="true" />
                  <span>{group.label}</span>
                  <ChevronDown className="control-nav-toggle-icon" size={16} aria-hidden="true" />
                </button>
              ) : (
                <a
                  className={`home-nav-link${active ? " is-active" : ""}`}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  onClick={(event) => followRoute(event, href)}
                >
                  <Icon size={21} aria-hidden="true" />
                  <span>{group.label}</span>
                </a>
              )}
              {nestedLinks.length > 0 && (
                <div
                  className="control-nav-nested"
                  id={nestedId}
                  aria-label={`${group.label} destinations`}
                  hidden={!expanded}
                >
                  {nestedLinks.map((item) => {
                    const ChildIcon = item.icon;
                    const childHref = controlHref(item.section);
                    // The branch you are actually in, not merely the group — with two
                    // branches, highlighting on the group alone would light both.
                    const childActive = active && activeContext === item.label;
                    return (
                      <a
                        className={`home-nav-link control-nav-child${childActive ? " is-active" : ""}`}
                        href={childHref}
                        aria-current={childActive ? "page" : undefined}
                        onClick={(event) => followRoute(event, childHref)}
                        key={item.label}
                      >
                        <ChildIcon size={17} aria-hidden="true" />
                        <span>{item.label}</span>
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Under the groups: search is a way into them, so it sits after the list
          it searches rather than above it. */}
      <button type="button" className="control-search-trigger" onClick={onSearch}>
        <Search size={18} aria-hidden="true" />
        <span>Search…</span>
        <kbd aria-hidden="true">Ctrl K</kbd>
      </button>
    </nav>
  );
}

// The in-page tab row for the active group. Each tab is a real link, so every
// destination in the control panel is bookmarkable and the search palette can
// jump straight to it.
function ControlTabs({
  tabs,
  section,
  label
}: {
  tabs: ControlTabDef[];
  section: ControlSection;
  label: string;
}) {
  return (
    <div className="control-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => {
        const href = controlHref(tab.section);
        const active = tab.section === section;
        return (
          <a
            key={tab.section}
            role="tab"
            aria-selected={active}
            className={active ? "active" : undefined}
            href={href}
            onClick={(event) => followRoute(event, href)}
          >
            {tab.label}
          </a>
        );
      })}
    </div>
  );
}
