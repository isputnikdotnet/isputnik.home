import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  ChevronDown,
  DownloadCloud,
  FileText,
  Headphones,
  Heart,
  Home,
  Image,
  Info,
  ListMusic,
  LogOut,
  Palette,
  Settings,
  UsersRound,
  UserRound
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PublicUser } from "../api";
import { isStandalone } from "../pwa/platform";
import { followRoute } from "../router";

type DashboardActive = "home" | "audiobooks" | "ebooks" | "about" | "profile" | "control";

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
    { label: "Favorites", href: "/audiobooks/saved", icon: Heart },
    { label: "Collections", href: "/collections", icon: ListMusic },
    // Offline downloads only exist in the installed app, so only surface the
    // Downloads screen there.
    ...(isStandalone() ? [{ label: "Downloads", href: "/audiobooks/downloads", icon: DownloadCloud }] : [])
  ];
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
                  className="home-user-menu-link"
                  href="/theme"
                  role="menuitem"
                  onClick={(event) => {
                    setUserMenuOpen(false);
                    followRoute(event, "/theme");
                  }}
                >
                  <Palette size={19} aria-hidden="true" />
                  <span>Theme</span>
                </a>
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
            <strong>v0.9.0</strong>
          <span>&copy; 2026 iSputnik</span>
        </footer>
      </aside>

      <section className={mainClasses}>
        <div className="dashboard-main">
          {children}
        </div>
      </section>
    </main>
  );
}
