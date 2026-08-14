import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Bookmark,
  BookOpen,
  Bug,
  ChevronDown,
  DownloadCloud,
  Headphones,
  Heart,
  HelpCircle,
  Home,
  Image,
  Info,
  Library,
  ListMusic,
  LogOut,
  Network,
  Quote,
  Settings,
  Tag,
  UsersRound,
  UserRound
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import packageInfo from "../../../../package.json";
import { isAdminSession, type PublicUser } from "../api";
import { isStandalone } from "../pwa/platform";
import { controlHref, followRoute } from "../router";
import { REPO_ISSUES_URL } from "../shared/links";

const APP_VERSION = packageInfo.version;

// The control panel's landing page — Overview › System.
const CONTROL_HOME = controlHref("status");

export type DashboardActive = "home" | "audiobooks" | "ebooks" | "gallery" | "family" | "authors" | "categories" | "tags" | "about" | "help" | "control" | "user";

interface AboutMenuLink {
  href: string;
  icon: LucideIcon;
  label: string;
  external?: boolean;
  activeKey?: DashboardActive;
}

// Info / Help / Bugs — reached from the "About" item at the end of the primary
// nav, rather than as their own icon row in the footer.
const ABOUT_MENU_LINKS: AboutMenuLink[] = [
  { href: "/about", icon: Info, label: "Info", activeKey: "about" },
  { href: "/help", icon: HelpCircle, label: "Help", activeKey: "help" },
  { href: REPO_ISSUES_URL, icon: Bug, label: "Bugs", external: true }
];

interface MainNavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  active?: boolean;
}

interface UserMenuLink {
  label: string;
  href: string;
  icon: LucideIcon;
}

function DashboardNavLink({ item }: { item: MainNavItem }) {
  const Icon = item.icon;

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

// Authors and Categories are reached from the Audiobooks/Ebooks pages (their
// tab rows and mobile Browse menus) rather than the primary nav — they only
// describe book-like libraries, so they don't belong beside the media types.
function mainNavItems(active: DashboardActive): MainNavItem[] {
  return [
    { label: "Home", href: "/", icon: Home, active: active === "home" },
    { label: "Audiobooks", href: "/audiobooks", icon: Headphones, active: active === "audiobooks" },
    { label: "Ebooks", href: "/ebooks", icon: BookOpen, active: active === "ebooks" },
    { label: "Gallery", href: "/gallery", icon: Image, active: active === "gallery" },
    { label: "Family Tree", href: "/family", icon: Network, active: active === "family" },
    { label: "Tags", href: "/tags", icon: Tag, active: active === "tags" }
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
    currentPath.startsWith("/family") ||
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
            <a className="mobile-media-option" href="/gallery" onClick={(event) => { followRoute(event, "/gallery"); close(); }}>
              <Image size={26} aria-hidden="true" />
              <span>Gallery</span>
            </a>
            <a className="mobile-media-option" href="/family" onClick={(event) => { followRoute(event, "/family"); close(); }}>
              <Network size={26} aria-hidden="true" />
              <span>Family Tree</span>
            </a>
            <a className="mobile-media-option" href="/tags" onClick={(event) => { followRoute(event, "/tags"); close(); }}>
              <Tag size={26} aria-hidden="true" />
              <span>Tags</span>
            </a>
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
            {isAdminSession(user) && (
              <a className="mobile-media-option" href={CONTROL_HOME} onClick={(event) => { followRoute(event, CONTROL_HOME); close(); }}>
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
  // Media sections (Gallery, Ebooks, Audiobooks, Family Tree, …) opt into a
  // contextual nav the same way Control/Profile do: by handing in `sideNav`.
  const hasSectionNav = isControlPanel || isUserArea || sideNav != null;
  // User-area pages (Profile, Favorites, Downloads, …) and section-nav media
  // pages drop their top section nav on phones and rely on the bottom tab bar
  // instead — its Media/Profile sheets expose every destination either way.
  // The control panel is the one exception: dense enough that it keeps its own
  // horizontal top nav on phones instead.
  const mobileTabBar = isUserArea || (hasSectionNav && !isControlPanel);
  const mainClasses = `home-main app-dashboard-main scene-page ${isControlPanel ? "control-scene" : "sputnik-scene"}`;
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  // The About menu is portaled to <body> (see the render below) rather than
  // absolutely positioned in place — .home-primary-nav scrolls once it's long
  // enough to need it (overflow-y: auto), which would clip an in-place dropdown.
  const [aboutMenuOpen, setAboutMenuOpen] = useState(false);
  const [aboutMenuPos, setAboutMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const aboutTriggerRef = useRef<HTMLButtonElement>(null);
  const aboutMenuRef = useRef<HTMLDivElement>(null);
  const currentPath = window.location.pathname;

  const toggleAboutMenu = () => {
    setAboutMenuOpen((open) => {
      if (!open && aboutTriggerRef.current) {
        const rect = aboutTriggerRef.current.getBoundingClientRect();
        setAboutMenuPos({ top: rect.bottom + 7, left: rect.left, width: rect.width });
      }
      return !open;
    });
  };

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

  useEffect(() => {
    if (!aboutMenuOpen) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (aboutTriggerRef.current?.contains(target)) return;
      if (aboutMenuRef.current?.contains(target)) return;
      setAboutMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAboutMenuOpen(false);
      }
    };
    // The menu's fixed position is computed once, on open — if the sidebar
    // scrolls or the window resizes it would drift from its trigger, so close
    // it instead (same as the library/sort menus elsewhere in the app).
    const dismiss = () => setAboutMenuOpen(false);

    document.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [aboutMenuOpen]);

  return (
    <main className={`home-dashboard-shell app-dashboard-shell${isControlPanel ? " home-control-shell" : ""}${isUserArea ? " home-user-shell" : ""}${mobileTabBar ? " home-mobile-tabbar-shell" : ""}`}>
      <aside className="home-sidebar" aria-label={isControlPanel ? "Control panel navigation" : isUserArea ? "User navigation" : "App navigation"}>
        {hasSectionNav && sideNav ? (
          <div className="home-control-nav-wrap">{sideNav}</div>
        ) : (
          <nav className="home-primary-nav" aria-label="Primary">
            {mainNavItems(active).map((item) => (
              <DashboardNavLink item={item} key={item.label} />
            ))}

            <button
              ref={aboutTriggerRef}
              className={`home-nav-link${aboutMenuOpen || active === "about" || active === "help" ? " is-active" : ""}`}
              type="button"
              onClick={toggleAboutMenu}
              aria-haspopup="menu"
              aria-expanded={aboutMenuOpen}
            >
              <Info size={21} aria-hidden="true" />
              <span>About</span>
              <ChevronDown className="home-user-chevron" size={16} aria-hidden="true" />
            </button>
          </nav>
        )}

        {aboutMenuOpen && aboutMenuPos && createPortal(
          <div
            ref={aboutMenuRef}
            className="home-primary-menu"
            role="menu"
            aria-label="About menu"
            style={{ position: "fixed", top: aboutMenuPos.top, left: aboutMenuPos.left, minWidth: aboutMenuPos.width }}
          >
            {ABOUT_MENU_LINKS.map((item) => {
              const Icon = item.icon;
              const isActiveLink = item.activeKey !== undefined && active === item.activeKey;
              return item.external ? (
                <a
                  className="home-user-menu-link"
                  href={item.href}
                  key={item.label}
                  role="menuitem"
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setAboutMenuOpen(false)}
                >
                  <Icon size={19} aria-hidden="true" />
                  <span>{item.label}</span>
                </a>
              ) : (
                <a
                  className={`home-user-menu-link${isActiveLink ? " is-active" : ""}`}
                  href={item.href}
                  key={item.label}
                  role="menuitem"
                  onClick={(event) => {
                    setAboutMenuOpen(false);
                    followRoute(event, item.href);
                  }}
                >
                  <Icon size={19} aria-hidden="true" />
                  <span>{item.label}</span>
                </a>
              );
            })}
            <div className="home-primary-menu-meta">
              <strong>v{APP_VERSION}</strong>
              <span aria-hidden="true">&middot;</span>
              <span>iSputnik.com</span>
            </div>
          </div>,
          document.body
        )}

        {/* The standard footer every page shares: Settings (admins only), then a
            Profile menu bundling the account's own pages and Logout — same two
            destinations regardless of which nav (primary, control, user-area, or a
            media section) sits above it. The menu opens upward: its trigger sits at
            the bottom of the sidebar, so there's no room to drop down. */}
        <div className="home-sidebar-bottom">
          {isAdminSession(user) && (
            <a
              className={`home-nav-link${currentPath === CONTROL_HOME || currentPath.startsWith("/control") ? " is-active" : ""}`}
              href={CONTROL_HOME}
              onClick={(event) => followRoute(event, CONTROL_HOME)}
            >
              <Settings size={21} aria-hidden="true" />
              <span>Settings</span>
            </a>
          )}

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
              </span>
              <ChevronDown className="home-user-chevron" size={17} aria-hidden="true" />
            </button>

            {userMenuOpen && (
              <div className="home-user-menu" role="menu" aria-label="Profile menu">
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
                <button
                  className="home-user-menu-link home-logout-link"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setUserMenuOpen(false);
                    void logout();
                  }}
                >
                  <LogOut size={19} aria-hidden="true" />
                  <span>Logout</span>
                </button>
              </div>
            )}
          </div>
        </div>
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
