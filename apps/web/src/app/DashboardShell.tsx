import React from "react";
import { Headphones, Info, LogOut, Settings, UserRound } from "lucide-react";
import type { PublicUser } from "../api";
import { navigate, followRoute } from "../router";

export function DashboardShell({
  active,
  user,
  logout,
  sideNav,
  children
}: {
  active: "home" | "audiobooks" | "about" | "profile" | "control";
  user: PublicUser;
  logout: () => Promise<void>;
  sideNav?: React.ReactNode;
  children: React.ReactNode;
}) {
  const isAdmin = user.role === "admin";
  const isControlPanel = active === "control";
  const hasSidebar = !isControlPanel && !!sideNav;

  return (
    <main className={`dashboard ${isControlPanel ? "control-dashboard" : ""}`}>
      <header className="app-header">
        <a className="header-brand app-brand" href="/" onClick={(event) => followRoute(event, "/")} title="Home">
          <img src="/Assets/brand/isputnik-logo-sputnik-earth-mark.svg" alt="" />
          <strong>isputnik.home</strong>
        </a>
        <nav className="top-nav">
          <a
            className={`top-nav-item ${active === "audiobooks" ? "active" : ""}`}
            href="/audiobooks"
            onClick={(event) => followRoute(event, "/audiobooks")}
          >
            <Headphones size={18} />
            <span>Audiobooks</span>
          </a>
          <a
            className={`top-nav-item ${active === "about" ? "active" : ""}`}
            href="/about"
            onClick={(event) => followRoute(event, "/about")}
          >
            <Info size={18} />
            <span>About</span>
          </a>
        </nav>
        <div className="header-actions">
          {isAdmin && (
            <a
              className={`header-button ${active === "control" ? "active" : ""}`}
              href="/control/status"
              onClick={(event) => followRoute(event, "/control/status")}
              title="App control panel"
              aria-label="App control panel"
            >
              <Settings size={20} />
            </a>
          )}
          <button className="header-button" onClick={logout} title="Sign out" aria-label="Sign out">
            <LogOut size={20} />
          </button>
          <button
            className={`user-button ${active === "profile" ? "active" : ""}`}
            onClick={() => navigate("/profile")}
            title="Your profile"
          >
            <span>{user.displayName}</span>
            <span className="avatar" aria-hidden="true"><UserRound size={19} /></span>
          </button>
        </div>
      </header>
      <div className={`dashboard-body${isControlPanel ? " control-body" : ""}${hasSidebar ? " has-sidebar" : ""}`}>
        {hasSidebar && (
          <aside className="sidebar">
            {sideNav}
          </aside>
        )}
        <div className="dashboard-main">
          {children}
        </div>
      </div>
    </main>
  );
}
