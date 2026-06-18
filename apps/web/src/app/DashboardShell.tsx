import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bookmark,
  BookOpen,
  ChevronDown,
  DownloadCloud,
  FileText,
  Headphones,
  Heart,
  Home,
  Image,
  Info,
  Library,
  ListMusic,
  MoreHorizontal,
  LogOut,
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

const APP_VERSION = packageInfo.version;

type DashboardActive = "home" | "audiobooks" | "ebooks" | "categories" | "tags" | "about" | "profile" | "control";

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
    { label: "Gallery", icon: Image, disabled: true },
    { label: "Documents", icon: FileText, disabled: true }
  ];
}

function userMenuLinks(): UserMenuLink[] {
  return [
    { label: "Shared with me", href: "/audiobooks/shared", icon: UsersRound },
    { label: "Favorites", href: "/favorites", icon: Heart },
    { label: "Bookmarks", href: "/audiobooks/bookmarks", icon: Bookmark },
    { label: "Collections", href: "/collections", icon: ListMusic },
    { label: "Categories", href: "/categories", icon: Shapes },
    { label: "Tags", href: "/tags", icon: Tag },
    // Offline downloads only exist in the installed app, so only surface the
    // Downloads screen there.
    ...(isStandalone() ? [{ label: "Downloads", href: "/audiobooks/downloads", icon: DownloadCloud }] : [])
  ];
}

// Four-tab bottom nav for the installed app / phones: Home, Media, Offline,
// Profile. "Media" isn't a page — it opens a drop-up sheet to pick a library
// (Audiobooks / Ebooks, with Gallery + Others reserved for later).
function MobileNav({ active, currentPath }: { active: DashboardActive; currentPath: string }) {
  const [mediaOpen, setMediaOpen] = useState(false);

  const downloadsActive = currentPath === "/audiobooks/downloads";
  const mediaActive =
    currentPath.startsWith("/ebooks") ||
    (currentPath.startsWith("/audiobooks") && !downloadsActive);

  useEffect(() => {
    if (!mediaOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMediaOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mediaOpen]);

  const close = () => setMediaOpen(false);

  return (
    <>
      {mediaOpen && <div className="mobile-media-backdrop" onClick={close} aria-hidden="true" />}
      {mediaOpen && (
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
            <button className="mobile-media-option is-future" type="button" disabled title="Gallery is coming soon">
              <Image size={26} aria-hidden="true" />
              <span>Gallery</span>
            </button>
            <button className="mobile-media-option is-future" type="button" disabled title="More media types are coming soon">
              <MoreHorizontal size={26} aria-hidden="true" />
              <span>Others</span>
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
          className={`home-mobile-nav-item${mediaActive || mediaOpen ? " is-active" : ""}`}
          onClick={() => setMediaOpen((open) => !open)}
          aria-haspopup="dialog"
          aria-expanded={mediaOpen}
        >
          <Library size={17} aria-hidden="true" />
          <span>Media</span>
        </button>
        <a
          className={`home-mobile-nav-item${downloadsActive ? " is-active" : ""}`}
          href="/audiobooks/downloads"
          onClick={(event) => { followRoute(event, "/audiobooks/downloads"); close(); }}
        >
          <DownloadCloud size={17} aria-hidden="true" />
          <span>Offline</span>
        </a>
        <a
          className={`home-mobile-nav-item${active === "profile" ? " is-active" : ""}`}
          href="/profile"
          onClick={(event) => { followRoute(event, "/profile"); close(); }}
        >
          <UserRound size={17} aria-hidden="true" />
          <span>Profile</span>
        </a>
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
  const mainClasses = `home-main app-dashboard-main scene-page ${isControlPanel ? "control-scene" : "sputnik-scene"}`;
  const settingsHref = user.role === "admin" && !isControlPanel ? "/control/status" : "/profile";
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
    <main className={`home-dashboard-shell app-dashboard-shell${isControlPanel ? " home-control-shell" : ""}`}>
      <aside className="home-sidebar" aria-label={isControlPanel ? "Control panel navigation" : "App navigation"}>
        {!isControlPanel && (
          <div className="home-user-menu-wrap" ref={userMenuRef}>
            <button
              className={`home-user-link${userMenuOpen || active === "profile" ? " is-active" : ""}`}
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
                  className={`home-user-menu-link${active === "profile" ? " is-active" : ""}`}
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
                <span className="home-user-menu-divider" aria-hidden="true"></span>
                <button
                  className="home-user-menu-link"
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
        )}

        {isControlPanel && sideNav ? (
          <div className="home-control-nav-wrap">{sideNav}</div>
        ) : (
          <nav className="home-primary-nav" aria-label="Primary">
            {mainNavItems(active).map((item) => (
              <DashboardNavLink item={item} key={item.label} />
            ))}
          </nav>
        )}

        <div className="home-sidebar-bottom">
          {!isControlPanel && (
            <>
              <a
                className={`home-nav-link${active === "profile" && settingsHref === "/profile" ? " is-active" : ""}`}
                href={settingsHref}
                onClick={(event) => followRoute(event, settingsHref)}
              >
                <Settings size={21} aria-hidden="true" />
                <span>Settings</span>
              </a>
              <a
                className={`home-nav-link${active === "about" ? " is-active" : ""}`}
                href="/about"
                onClick={(event) => followRoute(event, "/about")}
              >
                <Info size={21} aria-hidden="true" />
                <span>About</span>
              </a>
            </>
          )}
          {isControlPanel && (
            <button className="home-nav-link home-logout-link" type="button" onClick={logout}>
              <LogOut size={21} aria-hidden="true" />
              <span>Logout</span>
            </button>
          )}
        </div>

        <footer className="home-footer">
          <strong>v{APP_VERSION}</strong>
          <span>&copy; 2026 iSputnik</span>
        </footer>
      </aside>

      <section className={mainClasses}>
        <div className="dashboard-main">
          {children}
        </div>
      </section>

      {!isControlPanel && <MobileNav active={active} currentPath={currentPath} />}
    </main>
  );
}
