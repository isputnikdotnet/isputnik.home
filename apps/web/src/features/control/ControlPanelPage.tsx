import { Suspense, lazy, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Home, Search } from "lucide-react";
import type { PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { controlHref, followRoute } from "../../router";
import type { ControlSection } from "../../router";
import {
  CONTROL_GROUPS,
  contextLabel,
  groupForSection,
  groupLabel,
  navChildrenFor,
  sectionContext,
  sectionEyebrow,
  tabLabel,
  tabsInScope,
  type ControlTabDef
} from "./nav";
import { ControlSearch, useControlSearchShortcut } from "./ControlSearch";
import { LoadErrorBoundary } from "../../shared/LoadErrorBoundary";
import { useSession } from "../../app/SessionContext";
// The control panel's own stylesheet: it loads with this page, not on every route (docs/css-map.md).
import "../../styles/admin.css";
import { Button } from "../../shared/Button";

// Each section is its own chunk, loaded when its tab is first opened. Imported
// statically they made this page one ~700 KB file — the dashboard's charts, the
// backup and security screens, the duplicate cleanup — downloaded whole to show
// any one tab. The page itself is now just the nav and the tab row.
const UsersSection = lazy(() => import("./sections/UsersSection").then((m) => ({ default: m.UsersSection })));
const InvitesSection = lazy(() => import("./sections/InvitesSection").then((m) => ({ default: m.InvitesSection })));
const LogsSection = lazy(() => import("./sections/LogsSection").then((m) => ({ default: m.LogsSection })));
const AboutSection = lazy(() => import("./sections/AboutSection").then((m) => ({ default: m.AboutSection })));
const StorageSection = lazy(() => import("./sections/StorageSection").then((m) => ({ default: m.StorageSection })));
const StorageContentsSection = lazy(() => import("./sections/StorageContentsSection").then((m) => ({ default: m.StorageContentsSection })));
const LibrariesSection = lazy(() => import("./sections/LibrariesSection").then((m) => ({ default: m.LibrariesSection })));
const DashboardSection = lazy(() => import("./sections/DashboardSection").then((m) => ({ default: m.DashboardSection })));
const BackupSection = lazy(() => import("./sections/BackupSection").then((m) => ({ default: m.BackupSection })));
const CategoriesSection = lazy(() => import("./sections/CategoriesSection").then((m) => ({ default: m.CategoriesSection })));
const CategoryEditorPage = lazy(() => import("./sections/CategoriesSection").then((m) => ({ default: m.CategoryEditorPage })));
const TagsSection = lazy(() => import("./sections/TagsSection").then((m) => ({ default: m.TagsSection })));
const GroupsSection = lazy(() => import("./sections/GroupsSection").then((m) => ({ default: m.GroupsSection })));
const ScheduledJobsSection = lazy(() => import("./sections/ScheduledJobsSection").then((m) => ({ default: m.ScheduledJobsSection })));
const QuotesSection = lazy(() => import("./sections/QuotesSection").then((m) => ({ default: m.QuotesSection })));
const MissingPhotosSection = lazy(() => import("./sections/MissingPhotosSection").then((m) => ({ default: m.MissingPhotosSection })));
const DuplicateCleanupSection = lazy(() => import("./sections/duplicates/DuplicateCleanupSection").then((m) => ({ default: m.DuplicateCleanupSection })));
const AppearanceSection = lazy(() => import("./sections/AppearanceSection").then((m) => ({ default: m.AppearanceSection })));
const MailSection = lazy(() => import("./sections/MailSection").then((m) => ({ default: m.MailSection })));
const NotificationsSection = lazy(() => import("./sections/NotificationsSection").then((m) => ({ default: m.NotificationsSection })));
const StorySettingsSection = lazy(() => import("./sections/StorySettingsSection").then((m) => ({ default: m.StorySettingsSection })));
const MapsSection = lazy(() => import("./sections/MapsSection").then((m) => ({ default: m.MapsSection })));
const OpdsAccessSection = lazy(() => import("./sections/OpdsAccessSection").then((m) => ({ default: m.OpdsAccessSection })));
const SecuritySection = lazy(() => import("./sections/SecuritySection").then((m) => ({ default: m.SecuritySection })));
const RecycleBinSection = lazy(() => import("./sections/RecycleBinSection").then((m) => ({ default: m.RecycleBinSection })));

export function ControlPanelPage({
  section,
  categoryId
}: {
  section: ControlSection;
  categoryId?: string | null;
}) {
  const { user } = useSession();
  const { t } = useTranslation(["common", "control"]);
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useControlSearchShortcut(openSearch);

  // The category editor is a sub-page of Categories, not a tab of its own, so it
  // keeps the nav highlight but drops the tab row.
  const editingCategory = section === "categories" && categoryId !== undefined;

  return (
    <DashboardShell
      active="control"
      sideNav={<ControlPanelNav section={section} onSearch={openSearch} />}
    >
      <div className="control-panel control-panel-single">
        <section className={`work-area control-work${section === "backup" ? " backup-control-work" : ""}`}>
          {/* The row shows the branch you are in, not the whole group — and
              disappears when that branch holds a single page. */}
          {!editingCategory && tabsInScope(section).length > 1 && (
            <ControlTabs
              tabs={tabsInScope(section)}
              section={section}
              label={t("control:nav.tabsAria", { group: sectionEyebrow(section) })}
            />
          )}
          {/* Inside the page, so the nav and tab row stay up while a section's
              chunk is on its way — or, offline, fails to arrive. */}
          <LoadErrorBoundary resetKey={`${section}:${categoryId ?? ""}`}>
            <Suspense fallback={<p className="muted">{t("control:ui.loading")}</p>}>
              <ControlSectionBody section={section} categoryId={categoryId} currentUser={user} />
            </Suspense>
          </LoadErrorBoundary>
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
    case "dashboard":       return <DashboardSection />;
    case "logs":            return <LogsSection />;

    case "libraries":       return <LibrariesSection />;
    case "storage":         return <StorageSection />;
    case "storageContents": return <StorageContentsSection />;
    case "categories":      return categoryId !== undefined ? <CategoryEditorPage categoryId={categoryId} /> : <CategoriesSection />;
    case "tags":            return <TagsSection />;

    case "users":           return <UsersSection currentUser={currentUser} />;
    case "groups":          return <GroupsSection />;
    case "invites":         return <InvitesSection />;

    case "security":
    case "securityPolicies":
    case "securityTrusted":
    case "securityBlocked": return <SecuritySection section={section} />;

    case "backup":          return <BackupSection />;
    case "scheduledJobs":   return <ScheduledJobsSection />;
    case "recycleBin":      return <RecycleBinSection currentUser={currentUser} />;
    case "missingPhotos":   return <MissingPhotosSection />;
    case "duplicateCleanup": return <DuplicateCleanupSection currentUser={currentUser} />;
    case "quotes":          return <QuotesSection />;

    case "appearance":      return <AppearanceSection />;
    case "email":           return <MailSection />;
    case "notifications":   return <NotificationsSection />;
    case "storySettings":   return <StorySettingsSection />;
    case "maps":            return <MapsSection />;
    case "readerAccess":    return <OpdsAccessSection />;
    case "about":           return <AboutSection />;
  }
}

function ControlPanelNav({ section, onSearch }: { section: ControlSection; onSearch: () => void }) {
  const { t } = useTranslation(["common", "control"]);
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
    <nav className="home-control-nav" aria-label={t("control:nav.aria")}>
      {/* The way back out, first — the same position Home holds in the main nav,
          so leaving the control panel is where the hand already expects it. */}
      <a className="home-nav-link control-nav-exit" href="/" onClick={(event) => followRoute(event, "/")}>
        <Home size={21} aria-hidden="true" />
        <span>{t("control:nav.exit")}</span>
      </a>

      <div className="home-control-group">
        {CONTROL_GROUPS.map((group) => {
          const Icon = group.icon;
          const active = group.key === activeGroup.key;
          const label = groupLabel(group.key);
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
                <Button
                  variant="bare"
                  className={`home-nav-link control-nav-toggle${active ? " is-active" : ""}`}
                  aria-expanded={expanded}
                  aria-controls={nestedId}
                  onClick={() => toggleBranch(group.key)}
                >
                  <Icon size={21} aria-hidden="true" />
                  <span>{label}</span>
                  <ChevronDown className="control-nav-toggle-icon" size={16} aria-hidden="true" />
                </Button>
              ) : (
                <a
                  className={`home-nav-link${active ? " is-active" : ""}`}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  onClick={(event) => followRoute(event, href)}
                >
                  <Icon size={21} aria-hidden="true" />
                  <span>{label}</span>
                </a>
              )}
              {nestedLinks.length > 0 && (
                <div
                  className="control-nav-nested"
                  id={nestedId}
                  aria-label={t("control:nav.nestedAria", { group: label })}
                  hidden={!expanded}
                >
                  {nestedLinks.map((item) => {
                    const ChildIcon = item.icon;
                    const childHref = controlHref(item.section);
                    const childLabel = contextLabel(item.context);
                    // The branch you are actually in, not merely the group — with two
                    // branches, highlighting on the group alone would light both.
                    const childActive = active && activeContext === item.context;
                    return (
                      <a
                        className={`home-nav-link control-nav-child${childActive ? " is-active" : ""}`}
                        href={childHref}
                        aria-current={childActive ? "page" : undefined}
                        onClick={(event) => followRoute(event, childHref)}
                        key={item.context}
                      >
                        <ChildIcon size={17} aria-hidden="true" />
                        <span>{childLabel}</span>
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
      <Button variant="bare" className="control-search-trigger" onClick={onSearch}>
        <Search size={18} aria-hidden="true" />
        <span>{t("control:nav.searchTrigger")}</span>
        <kbd aria-hidden="true">Ctrl K</kbd>
      </Button>
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
            {tabLabel(tab.section)}
          </a>
        );
      })}
    </div>
  );
}
