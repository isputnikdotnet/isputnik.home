import type { ReactNode } from "react";
import {
  BookOpen,
  Bookmark,
  FileText,
  FolderOpen,
  Headphones,
  Home,
  Image,
  LogOut,
  Rocket,
  Settings
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PublicUser } from "../api";
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
    { label: "Documents", icon: FolderOpen, disabled: true },
    { label: "Notes", icon: FileText, disabled: true },
    { label: "Bookmarks", href: "/audiobooks/saved", icon: Bookmark }
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
  const settingsHref = user.role === "admin" && !isControlPanel ? "/control/status" : "/profile";

  return (
    <main className={`home-dashboard-shell app-dashboard-shell${isControlPanel ? " home-control-shell" : ""}`}>
      <aside className="home-sidebar" aria-label={isControlPanel ? "Control panel navigation" : "App navigation"}>
        <a className="home-brand" href="/" onClick={(event) => followRoute(event, "/")}>
          <span className="home-brand-icon" aria-hidden="true">
            <Rocket size={23} fill="currentColor" />
          </span>
          <strong>iSputnik home</strong>
        </a>

        {isControlPanel && sideNav ? (
          <div className="home-control-nav-wrap">{sideNav}</div>
        ) : (
          <>
            <nav className="home-primary-nav" aria-label="Primary">
              {mainNavItems(active).map((item) => (
                <DashboardNavLink item={item} key={item.label} />
              ))}
            </nav>
            {sideNav && (
              <div className="home-secondary-nav" aria-label="Section navigation">
                {sideNav}
              </div>
            )}
          </>
        )}

        <div className="home-sidebar-bottom">
          {!isControlPanel && (
            <a className="home-nav-link" href={settingsHref} onClick={(event) => followRoute(event, settingsHref)}>
              <Settings size={21} aria-hidden="true" />
              <span>Settings</span>
            </a>
          )}
          <button className="home-nav-link" type="button" onClick={logout}>
            <LogOut size={21} aria-hidden="true" />
            <span>Logout</span>
          </button>
        </div>

        <footer className="home-footer">
          <strong>iSputnik home v0.5.3</strong>
          <span>&copy; 2026 iSputnik</span>
        </footer>
      </aside>

      <section className="home-main app-dashboard-main">
        <div className="dashboard-main">
          {children}
        </div>
      </section>
    </main>
  );
}
