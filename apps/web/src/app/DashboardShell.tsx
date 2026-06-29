import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bookmark,
  BookOpen,
  Bug,
  ChevronDown,
  DownloadCloud,
  FileText,
  Headphones,
  Heart,
  HelpCircle,
  Home,
  Image,
  Info,
  Library,
  ListMusic,
  LogOut,
  Quote,
  Settings,
  Shapes,
  Tag,
  UsersRound,
  UserRound
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import packageInfo from "../../../../package.json";
import type { PublicUser } from "../api";
import { isStandalone } from "../pwa/platform";
import { followRoute } from "../router";
import { REPO_ISSUES_URL } from "../shared/links";

const APP_VERSION = packageInfo.version;

type DashboardActive = "home" | "audiobooks" | "ebooks" | "gallery" | "authors" | "categories" | "tags" | "about" | "help" | "control" | "user";

interface FooterAction {
  href: string;
  icon: LucideIcon;
  title: string;
  aria: string;
  external?: boolean;
  activeKey?: DashboardActive;
}

// About / Report-a-bug / Help — the icon row shared by every nav footer.
const FOOTER_ACTIONS: FooterAction[] = [
  { href: "/about", icon: Info, title: "About", aria: "About this app", activeKey: "about" },
  { href: REPO_ISSUES_URL, icon: Bug, title: "Report a bug", aria: "Report a bug on GitHub", external: true },
  { href: "/help", icon: HelpCircle, title: "Help", aria: "Help and guides", activeKey: "help" }
];

interface MainNavLink {
  label: string;
  href: string;
  icon: LucideIcon;
  active?: boolean;
  disabled?: false;
}

interface DisabledMainNavLink {
  label: string;
  icon: LucideIcon;
  disabled: true;
}

type MainNavItem = MainNavLink | DisabledMainNavLink;

interface UserMenuLink {
  label: string;
  href: string;
  icon: LucideIcon;
}

function DashboardNavLink({ item }: { item: MainNavItem }) {
  const Icon = item.icon;

  if (item.disabled) {
    return (
      <button className="home-nav-link is-disabled" type="button" disabled title={`${item.label} is coming soon`}>
        <Icon size={21} aria-hidden="true" />
        <span>{item.label}</span>
      </button>
    );
  }

  return (
    <a
      className={`home-nav-link${item.active ? " is-active" : ""}`}
      href={item.href}
      onClick={(event) => followRoute(event, item.href)}
    >
      <Icon size={21} aria-hidden="true" />
      <span>{item.label}</span>
    </a>
  );
}

function mainNavItems(active: DashboardActive): MainNavItem[] {
  return [
    { label: "Home", href: "/", icon: Home, active: active === "home" },
    { label: "Audiobooks", href: "/audiobooks", icon: Headphones, active: active === "audiobooks" },
    { label: "Ebooks", href: "/ebooks", icon: BookOpen, active: active === "ebooks" },
    { label: "Authors", href: "/authors", icon: UserRound, active: active === "authors" },
    { label: "Categories", href: "/categories", icon: Shapes, active: active === "categories" },
    { label: "Tags", href: "/tags", icon: Tag, active: active === "tags" },
    { label: "Gallery", href: "/gallery", icon: Image, active: active === "gallery" },
    { label: "Documents", icon: FileText, disabled: true }
  ];
}

function userMenuLinks(): UserMenuLink[] {
  return [
    { label: "Shared with me", href: "/shared", icon: UsersRound },
    { label: "Favorites", href: "/favorites", icon: Heart },
    { label: "Bookmarks", href: "/bookmarks", icon: Bookmark },
    { label: "Quotes", href: "/quotes", icon: Quote },
    { label: "Collections", href: "/collections", icon: ListMusic },
    // Offline downloads only exist in the installed app, so only surface the
    // Downloads screen there.
    ...(isStandalone() ? [{ label: "Downloads", href: "/downloads", icon: DownloadCloud }] : [])
  ];
}

// The user-area routes reachable from the Profile drop-up sheet. The Profile
// tab highlights for any of them (not just /profile itself).
const PROFILE_ROUTES = ["/profile", "/favorites", "/bookmarks", "/quotes", "/collections", "/shared"];

// Four-tab bottom nav for the installed app / phones: Home, Media, Offline,
// Profile. "Media" and "Profile" aren't pages — each opens a drop-up sheet:
// Media to pick a library / browse view, Profile for account & library options.
function MobileNav({
  active,
  currentPath,
  user,
  logout
}: {
  active: DashboardActive;
  currentPath: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [openSheet, setOpenSheet] = useState<"media" | "profile" | null>(null);

  const downloadsActive = currentPath === "/downloads" || currentPath === "/audiobooks/downloads";
  const mediaActive =
    currentPath.startsWith("/ebooks") ||
    currentPath.startsWith("/authors") ||
    currentPath.startsWith("/people") ||
    currentPath.startsWith("/categories") ||
    currentPath.startsWith("/tags") ||
    currentPath.startsWith("/gallery") ||
    (currentPath.startsWith("/audiobooks") && !downloadsActive);
  const profileActive = PROFILE_ROUTES.some((route) => currentPath === route || currentPath.startsWith(`${route}/`));

  useEffect(() => {
    if (!openSheet) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpenSheet(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSheet]);

  const close = () => setOpenSheet(null);

  return (
    <>
      {openSheet && <div className="mobile-media-backdrop" onClick={close} aria-hidden="true" />}
      {openSheet === "media" && (
        <div className="mobile-media-menu" role="dialog" aria-label="Choose library">
          <div className="mobile-media-menu-grid">
            <a className="mobile-media-option" href="/audiobooks" onClick={(event) => { followRoute(event, "/audiobooks"); close(); }}>
              <Headphones size={26} aria-hidden="true" />
              <span>Audiobooks</span>
            </a>
            <a className="mobile-media-option" href="/ebooks" onClick={(event) => { followRoute(event, "/ebooks"); close(); }}>
              <BookOpen size={26} aria-hidden="true" />
              <span>Ebooks</span>
            </a>
            <a className="mobile-media-option" href="/authors" onClick={(event) => { followRoute(event, "/authors"); close(); }}>
              <UserRound size={26} aria-hidden="true" />
              <span>Authors</span>
            </a>
            <a className="mobile-media-option" href="/categories" onClick={(event) => { followRoute(event, "/categories"); close(); }}>
              <Shapes size={26} aria-hidden="true" />
              <span>Categories</span>
            </a>
            <a className="mobile-media-option" href="/tags" onClick={(event) => { followRoute(event, "/tags"); close(); }}>
              <Tag size={26} aria-hidden="true" />
              <span>Tags</span>
            </a>
            <a className="mobile-media-option" href="/gallery" onClick={(event) => { followRoute(event, "/gallery"); close(); }}>
              <Image size={26} aria-hidden="true" />
              <span>Gallery</span>
            </a>
            <button className="mobile-media-option is-future" type="button" disabled title="Documents are coming soon">
              <FileText size={26} aria-hidden="true" />
              <span>Documents</span>
            </button>
          </div>
        </div>
      )}
      {openSheet === "profile" && (
        <div className="mobile-media-menu" role="dialog" aria-label="Account & library">
          <div className="mobile-media-menu-grid">
            <a className="mobile-media-option" href="/profile" onClick={(event) => { followRoute(event, "/profile"); close(); }}>
              <UserRound size={26} aria-hidden="true" />
              <span>Profile</span>
            </a>
            <a className="mobile-media-option" href="/favorites" onClick={(event) => { followRoute(event, "/favorites"); close(); }}>
              <Heart size={26} aria-hidden="true" />
              <span>Favorites</span>
            </a>
            <a className="mobile-media-option" href="/bookmarks" onClick={(event) => { followRoute(event, "/bookmarks"); close(); }}>
              <Bookmark size={26} aria-hidden="true" />
              <span>Bookmarks</span>
            </a>
            <a className="mobile-media-option" href="/quotes" onClick={(event) => { followRoute(event, "/quotes"); close(); }}>
              <Quote size={26} aria-hidden="true" />
              <span>Quotes</span>
            </a>
            <a className="mobile-media-option" href="/collections" onClick={(event) => { followRoute(event, "/collections"); close(); }}>
              <ListMusic size={26} aria-hidden="true" />
              <span>Collections</span>
            </a>
            <a className="mobile-media-option" href="/shared" onClick={(event) => { followRoute(event, "/shared"); close(); }}>
              <UsersRound size={26} aria-hidden="true" />
              <span>Shared</span>
            </a>
            {user.role === "admin" && (
              <a className="mobile-media-option" href="/control/status" onClick={(event) => { followRoute(event, "/control/status"); close(); }}>
                <Settings size={26} aria-hidden="true" />
                <span>Settings</span>
              </a>
            )}
            <button className="mobile-media-option" type="button" onClick={() => { close(); void logout(); }}>
              <LogOut size={26} aria-hidden="true" />
              <span>Logout</span>
            </button>
          </div>
        </div>
      )}
      <nav className="home-mobile-nav" aria-label="Primary app tabs">
        <a
          className={`home-mobile-nav-item${active === "home" && currentPath === "/" ? " is-active" : ""}`}
          href="/"
          onClick={(event) => { followRoute(event, "/"); close(); }}
        >
          <Home size={17} aria-hidden="true" />
          <span>Home</span>
        </a>
        <button
          type="button"
          className={`home-mobile-nav-item${mediaActive || openSheet === "media" ? " is-active" : ""}`}
          onClick={() => setOpenSheet((current) => (current === "media" ? null : "media"))}
          aria-haspopup="dialog"
          aria-expanded={openSheet === "media"}
        >
          <Library size={17} aria-hidden="true" />
          <span>Media</span>
        </button>
        <a
          className={`home-mobile-nav-item${downloadsActive ? " is-active" : ""}`}
          href="/downloads"
          onClick={(event) => { followRoute(event, "/downloads"); close(); }}
        >
          <DownloadCloud size={17} aria-hidden="true" />
          <span>Offline</span>
        </a>
        <button
          type="button"
          className={`home-mobile-nav-item${profileActive || openSheet === "profile" ? " is-active" : ""}`}
          onClick={() => setOpenSheet((current) => (current === "profile" ? null : "profile"))}
          aria-haspopup="dialog"
          aria-expanded={openSheet === "profile"}
        >
          <UserRound size={17} aria-hidden="true" />
          <span>Profile</span>
        </button>
      </nav>
    </>
  );
}

export function DashboardShell({
  active,
  user,
  logout,
  sideNav,
  children
}: {
  active: DashboardActive;
  user: PublicUser;
  logout: () => Promise<void>;
  sideNav?: ReactNode;
  children: ReactNode;
}) {
  const isControlPanel = active === "control";
  const isUserArea = active === "user";
  const hasSectionNav = isControlPanel || isUserArea;
  // User-area pages (Profile, Favorites, Downloads, …) drop their top section
  // nav on phones and rely on the bottom tab bar instead — its Profile sheet
  // exposes every user-area destination. The control panel keeps its top nav.
  const mobileTabBar = isUserArea;
  const mainClasses = `home-main app-dashboard-main scene-page ${isControlPanel ? "control-scene" : "sputnik-scene"}`;
  const settingsHref = user.role === "admin" && !hasSectionNav ? "/control/status" : "/profile";
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const currentPath = window.location.pathname;

  useEffect(() => {
    if (!userMenuOpen) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!userMenuRef.current?.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [userMenuOpen]);

  return (
    <main className={`home-dashboard-shell app-dashboard-shell${isControlPanel ? " home-control-shell" : ""}${isUserArea ? " home-user-shell" : ""}${mobileTabBar ? " home-mobile-tabbar-shell" : ""}`}>
      <aside className="home-sidebar" aria-label={isControlPanel ? "Control panel navigation" : isUserArea ? "User navigation" : "App navigation"}>
        {!hasSectionNav && (
          <div className="home-user-menu-wrap" ref={userMenuRef}>
            <button
              className={`home-user-link${userMenuOpen || currentPath === "/profile" ? " is-active" : ""}`}
              type="button"
              onClick={() => setUserMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
            >
              <span className="home-user-icon" aria-hidden="true">
                <UserRound size={21} />
              </span>
              <span className="home-user-copy">
                <strong>{user.displayName}</strong>
                <small>{user.email}</small>
              </span>
              <ChevronDown className="home-user-chevron" size={17} aria-hidden="true" />
            </button>

            {userMenuOpen && (
              <div className="home-user-menu" role="menu" aria-label="User menu">
                {userMenuLinks().map((item) => {
                  const Icon = item.icon;
                  return (
                    <a
                      className="home-user-menu-link"
                      href={item.href}
                      key={item.label}
                      role="menuitem"
                      onClick={(event) => {
                        setUserMenuOpen(false);
                        followRoute(event, item.href);
                      }}
                    >
                      <Icon size={19} aria-hidden="true" />
                      <span>{item.label}</span>
                    </a>
                  );
                })}
                <a
                  className={`home-user-menu-link${currentPath === "/profile" ? " is-active" : ""}`}
                  href="/profile"
                  role="menuitem"
                  onClick={(event) => {
                    setUserMenuOpen(false);
                    followRoute(event, "/profile");
                  }}
                >
                  <UserRound size={19} aria-hidden="true" />
                  <span>Profile</span>
                </a>
              </div>
            )}
          </div>
        )}

        {hasSectionNav && sideNav ? (
          <div className="home-control-nav-wrap">{sideNav}</div>
        ) : (
          <nav className="home-primary-nav" aria-label="Primary">
            {mainNavItems(active).map((item) => (
              <DashboardNavLink item={item} key={item.label} />
            ))}
          </nav>
        )}

        <div className="home-sidebar-bottom">
          {!hasSectionNav && (
            <a
              className={`home-nav-link${currentPath === settingsHref ? " is-active" : ""}`}
              href={settingsHref}
              onClick={(event) => followRoute(event, settingsHref)}
            >
              <Settings size={21} aria-hidden="true" />
              <span>Settings</span>
            </a>
          )}
          <button className="home-nav-link home-logout-link" type="button" onClick={logout}>
            <LogOut size={21} aria-hidden="true" />
            <span>Logout</span>
          </button>
        </div>

        <footer className="home-footer">
          <div className="home-footer-actions">
            {FOOTER_ACTIONS.map(({ href, icon: Icon, title, aria, external, activeKey }) => {
              const className = `home-footer-action${activeKey && active === activeKey ? " is-active" : ""}`;
              return external ? (
                <a className={className} key={title} href={href} target="_blank" rel="noreferrer" title={title} aria-label={aria}>
                  <Icon size={18} aria-hidden="true" />
                </a>
              ) : (
                <a className={className} key={title} href={href} onClick={(event) => followRoute(event, href)} title={title} aria-label={aria}>
                  <Icon size={18} aria-hidden="true" />
                </a>
              );
            })}
          </div>
          <div className="home-footer-meta">
            <strong>v{APP_VERSION}</strong>
            <span aria-hidden="true">&middot;</span>
            <span>iSputnik.com</span>
          </div>
        </footer>
      </aside>

      <section className={mainClasses}>
        <div className="dashboard-main">
          {children}
        </div>
      </section>

      {(!hasSectionNav || mobileTabBar) && <MobileNav active={active} currentPath={currentPath} user={user} logout={logout} />}
    </main>
  );
}
