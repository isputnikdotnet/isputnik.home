import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Home, Search } from "lucide-react";
import type { PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { controlHref, followRoute } from "../../router";
import type { ControlSection, MemberPageTab } from "../../router";
import {
  CONTROL_GROUPS,
  groupForSection,
  groupLabel,
  sectionEyebrow,
  tabLabel,
  type ControlTabDef
} from "./nav";
import { ControlSearch, useControlSearchShortcut } from "./ControlSearch";
import { useAnchorScroll } from "./useAnchorScroll";
import { LoadErrorBoundary } from "../../shared/LoadErrorBoundary";
import { useSession } from "../../app/SessionContext";
// The control panel's own stylesheet: it loads with this page, not on every route (docs/css-map.md).
import "../../styles/admin.css";
import { Button } from "../../shared/Button";
import { Modal } from "../../shared/Modal";
import { useIsMobile } from "../../shared/useIsMobile";

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
const ActivitySection = lazy(() => import("./sections/ActivitySection").then((m) => ({ default: m.ActivitySection })));
const LibraryStatsSection = lazy(() => import("./sections/LibraryStatsSection").then((m) => ({ default: m.LibraryStatsSection })));
const TasksSection = lazy(() => import("./sections/TasksSection").then((m) => ({ default: m.TasksSection })));
const SignInsSection = lazy(() => import("./sections/SignInsSection").then((m) => ({ default: m.SignInsSection })));
const SignInLocationsSection = lazy(() => import("./sections/SignInsSection").then((m) => ({ default: m.SignInLocationsSection })));
const BackupSection = lazy(() => import("./sections/BackupSection").then((m) => ({ default: m.BackupSection })));
const CategoriesSection = lazy(() => import("./sections/CategoriesSection").then((m) => ({ default: m.CategoriesSection })));
const CategoryEditorPage = lazy(() => import("./sections/CategoriesSection").then((m) => ({ default: m.CategoryEditorPage })));
const MemberPage = lazy(() => import("./members/MemberPage").then((m) => ({ default: m.MemberPage })));
const TagsSection = lazy(() => import("./sections/TagsSection").then((m) => ({ default: m.TagsSection })));
const GroupsSection = lazy(() => import("./sections/GroupsSection").then((m) => ({ default: m.GroupsSection })));
const ScheduledJobsSection = lazy(() => import("./sections/ScheduledJobsSection").then((m) => ({ default: m.ScheduledJobsSection })));
const QuotesSection = lazy(() => import("./sections/QuotesSection").then((m) => ({ default: m.QuotesSection })));
const MissingPhotosSection = lazy(() => import("./sections/MissingPhotosSection").then((m) => ({ default: m.MissingPhotosSection })));
const VideoStreamingSection = lazy(() => import("./sections/VideoStreamingSection").then((m) => ({ default: m.VideoStreamingSection })));
const DuplicateCleanupSection = lazy(() => import("./sections/duplicates/DuplicateCleanupSection").then((m) => ({ default: m.DuplicateCleanupSection })));
const AppearanceSection = lazy(() => import("./sections/AppearanceSection").then((m) => ({ default: m.AppearanceSection })));
const MailSection = lazy(() => import("./sections/MailSection").then((m) => ({ default: m.MailSection })));
const NotificationsSection = lazy(() => import("./sections/NotificationsSection").then((m) => ({ default: m.NotificationsSection })));
const StorySettingsSection = lazy(() => import("./sections/StorySettingsSection").then((m) => ({ default: m.StorySettingsSection })));
const MapSetupSection = lazy(() => import("./sections/maps/MapSetupSection").then((m) => ({ default: m.MapSetupSection })));
const SecuritySection = lazy(() => import("./sections/SecuritySection").then((m) => ({ default: m.SecuritySection })));
const RecycleBinSection = lazy(() => import("./sections/RecycleBinSection").then((m) => ({ default: m.RecycleBinSection })));

/** One account's page (members/MemberPage), a sub-page of Users the way the
 *  category editor is one of Categories. */
export interface MemberPageTarget {
  userId: string;
  tab: MemberPageTab;
}

export function ControlPanelPage({
  section,
  categoryId,
  member
}: {
  section: ControlSection;
  categoryId?: string | null;
  member?: MemberPageTarget;
}) {
  const { user } = useSession();
  const { t } = useTranslation(["common", "control"]);
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useControlSearchShortcut(openSearch);
  useAnchorScroll(section);

  // The category editor is a sub-page of Categories, not a tab of its own, so it
  // keeps the nav highlight but drops the tab row.
  const editingCategory = section === "categories" && categoryId !== undefined;
  // So is a member's page of Users: its tabs are its own, drawn by the page.
  const subPage = editingCategory || member !== undefined;

  // An old address — an alias, or the Dashboard with a retired ?view= — shows the
  // page it meant; the address bar is then tidied to that page's own. replaceState,
  // so Back never returns to the dead address, and the rest of the query and the
  // hash ride along, because a Sign-ins link carrying ?ip=… is a dive, not a page.
  useEffect(() => {
    if (categoryId !== undefined || member !== undefined) return;
    const canonical = controlHref(section);
    const params = new URLSearchParams(window.location.search);
    if (window.location.pathname === canonical && !params.has("view")) return;
    params.delete("view");
    const query = params.toString();
    window.history.replaceState(window.history.state, "", `${canonical}${query ? `?${query}` : ""}${window.location.hash}`);
  }, [section, categoryId, member]);

  const tabs = groupForSection(section).tabs;
  // On a phone the menu lists every page, and its button names the one you are on,
  // so the tab row would be a third copy squeezed into 375px.
  const isMobile = useIsMobile();

  return (
    <DashboardShell
      active="control"
      sideNav={<ControlPanelNav section={section} onSearch={openSearch} />}
    >
      <div className="control-panel control-panel-single">
        <section className={`work-area control-work${section === "backup" ? " backup-control-work" : ""}`}>
          {/* A group of one page draws no row. */}
          {!subPage && !isMobile && tabs.length > 1 && (
            <ControlTabs
              tabs={tabs}
              section={section}
              label={t("control:nav.tabsAria", { group: sectionEyebrow(section) })}
            />
          )}
          {/* Inside the page, so the nav and tab row stay up while a section's
              chunk is on its way — or, offline, fails to arrive. */}
          <LoadErrorBoundary resetKey={`${section}:${categoryId ?? ""}:${member?.userId ?? ""}`}>
            <Suspense fallback={<p className="muted">{t("control:ui.loading")}</p>}>
              <ControlSectionBody section={section} categoryId={categoryId} member={member} currentUser={user} />
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
  member,
  currentUser
}: {
  section: ControlSection;
  categoryId?: string | null;
  member?: MemberPageTarget;
  currentUser: PublicUser;
}) {
  switch (section) {
    case "dashboard":       return <DashboardSection />;
    case "activity":        return <ActivitySection />;
    case "libraryStats":    return <LibraryStatsSection />;
    case "logs":            return <LogsSection />;

    case "libraries":       return <LibrariesSection />;
    case "storage":         return <StorageSection />;
    case "storageContents": return <StorageContentsSection />;
    case "categories":      return categoryId !== undefined ? <CategoryEditorPage categoryId={categoryId} /> : <CategoriesSection />;
    case "tags":            return <TagsSection />;

    case "users":           return member
      ? <MemberPage userId={member.userId} tab={member.tab} currentUser={currentUser} />
      : <UsersSection currentUser={currentUser} />;
    case "groups":          return <GroupsSection />;
    case "invites":         return <InvitesSection />;

    case "signIns":         return <SignInsSection />;
    case "signInLocations": return <SignInLocationsSection />;
    case "security":
    case "securityPolicies":
    case "securityTrusted":
    case "securityBlocked": return <SecuritySection section={section} />;

    case "tasks":           return <TasksSection />;
    case "scheduledJobs":   return <ScheduledJobsSection />;
    case "backup":          return <BackupSection />;
    case "recycleBin":      return <RecycleBinSection currentUser={currentUser} />;
    case "duplicateCleanup": return <DuplicateCleanupSection currentUser={currentUser} />;
    case "missingPhotos":   return <MissingPhotosSection />;
    case "videoStreaming":  return <VideoStreamingSection />;

    case "appearance":      return <AppearanceSection />;
    case "quotes":          return <QuotesSection />;
    case "mapSetup":        return <MapSetupSection />;
    case "storySettings":   return <StorySettingsSection />;
    case "email":           return <MailSection />;
    case "notifications":   return <NotificationsSection />;
    case "about":           return <AboutSection />;
  }
}

function ControlPanelNav({ section, onSearch }: { section: ControlSection; onSearch: () => void }) {
  const { t } = useTranslation(["common", "control"]);
  const activeGroup = groupForSection(section);
  const isMobile = useIsMobile();

  if (isMobile) return <ControlPanelPhoneNav section={section} onSearch={onSearch} />;

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
          // Each group links to its first tab, which is its landing page.
          const href = controlHref(group.tabs[0].section);
          return (
            <a
              key={group.key}
              className={`home-nav-link${active ? " is-active" : ""}`}
              href={href}
              aria-current={active ? "page" : undefined}
              onClick={(event) => followRoute(event, href)}
            >
              <Icon size={21} aria-hidden="true" />
              <span>{groupLabel(group.key)}</span>
            </a>
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

// The panel on a phone: Home, one button that says where you are and opens every
// group and page, and search — always the same three, never a strip that scrolls
// sideways past most of its own links. The menu is the desktop nav and tab rows in
// one list, from the same nav.ts, so the two can never disagree.
function ControlPanelPhoneNav({ section, onSearch }: { section: ControlSection; onSearch: () => void }) {
  const { t } = useTranslation(["common", "control"]);
  const [menuOpen, setMenuOpen] = useState(false);
  const activeGroup = groupForSection(section);
  const ActiveIcon = activeGroup.icon;

  // A page change — from the menu, search or a link on the page — closes the menu.
  useEffect(() => setMenuOpen(false), [section]);

  // Thirty-odd pages is taller than a phone: open on the one you are on.
  useEffect(() => {
    if (!menuOpen) return;
    document.querySelector(".control-phone-menu [aria-current='page']")?.scrollIntoView({ block: "center" });
  }, [menuOpen]);

  return (
    <nav className="home-control-nav control-phone-nav" aria-label={t("control:nav.aria")}>
      <a
        className="home-nav-link control-nav-exit control-phone-icon"
        href="/"
        aria-label={t("control:nav.exit")}
        title={t("control:nav.exit")}
        onClick={(event) => followRoute(event, "/")}
      >
        <Home size={20} aria-hidden="true" />
      </a>

      <Button
        variant="bare"
        className="control-phone-menu-trigger"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        aria-label={t("control:nav.menuOpen", { page: `${groupLabel(activeGroup.key)} › ${tabLabel(section)}` })}
        onClick={() => setMenuOpen(true)}
      >
        <ActiveIcon size={18} aria-hidden="true" />
        <span className="control-phone-menu-label">
          <small>{groupLabel(activeGroup.key)}</small>
          <strong>{tabLabel(section)}</strong>
        </span>
        <ChevronDown size={18} aria-hidden="true" />
      </Button>

      <Button
        variant="icon"
        className="control-phone-icon"
        aria-label={t("control:nav.searchAria")}
        title={t("control:nav.searchAria")}
        onClick={onSearch}
      >
        <Search size={20} aria-hidden="true" />
      </Button>

      {menuOpen && (
        <Modal
          variant="panel"
          className="control-phone-menu"
          title={t("control:nav.aria")}
          onClose={() => setMenuOpen(false)}
        >
          <div className="control-phone-menu-groups">
            {CONTROL_GROUPS.map((group) => {
              const Icon = group.icon;
              const headingId = `control-phone-menu-${group.key}`;
              return (
                <section key={group.key} className="control-phone-menu-group" aria-labelledby={headingId}>
                  <h2 id={headingId}>
                    <Icon size={17} aria-hidden="true" />
                    {groupLabel(group.key)}
                  </h2>
                  <ul>
                    {group.tabs.map((tab) => {
                      const href = controlHref(tab.section);
                      const current = tab.section === section;
                      return (
                        <li key={tab.section}>
                          <a
                            href={href}
                            className={current ? "is-active" : undefined}
                            aria-current={current ? "page" : undefined}
                            onClick={(event) => {
                              if (current) {
                                event.preventDefault();
                                setMenuOpen(false);
                                return;
                              }
                              followRoute(event, href);
                            }}
                          >
                            {tabLabel(tab.section)}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </Modal>
      )}
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
