import React from "react";
import { Headphones, Home, Info, LogOut, Settings, UserRound } from "lucide-react";
import type { PublicUser } from "../api";
import { navigate, followRoute } from "../router";

export function DashboardShell({
  active,
  user,
  logout,
  children
}: {
  active: "home" | "audiobooks" | "about" | "profile" | "control";
  user: PublicUser;
  logout: () => Promise<void>;
  children: React.ReactNode;
}) {
  const isAdmin = user.role === "admin";
  const isControlPanel = active === "control";

  return (
    <main className={`dashboard ${isControlPanel ? "control-dashboard" : ""}`}>
      <header className="app-header">
        <a className="header-brand app-brand" href="/" onClick={(event) => followRoute(event, "/")} title="Home">
          <img src="/Assets/brand/isputnik-app-icon.svg" alt="" />
          <strong>isputnik.home</strong>
        </a>
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
          <button className={`user-button ${active === "profile" ? "active" : ""}`} onClick={() => navigate("/profile")} title="Your profile">
            <span>{user.displayName}</span>
            <span className="avatar" aria-hidden="true"><UserRound size={19} /></span>
          </button>
        </div>
      </header>
      <div className={`dashboard-body ${isControlPanel ? "control-body" : ""}`}>
        {!isControlPanel && (
          <aside className="sidebar">
            <nav className="side-nav">
              <button className={active === "home" ? "active" : ""} onClick={() => navigate("/")} title="Home">
                <Home size={22} />
                <span className="sr-only">Home</span>
              </button>
              <button className={active === "audiobooks" ? "active" : ""} onClick={() => navigate("/audiobooks")} title="Audiobooks">
                <Headphones size={22} />
                <span className="sr-only">Audiobooks</span>
              </button>
              <button className={active === "about" ? "active" : ""} onClick={() => navigate("/about")} title="About">
                <Info size={22} />
                <span className="sr-only">About</span>
              </button>
            </nav>
            <div className="rail-foot">
              <button className="logout-button" onClick={logout} title="Sign out">
                <LogOut size={21} />
                <span className="sr-only">Sign out</span>
              </button>
              <span className="version">v0.2.0</span>
            </div>
          </aside>
        )}
        <div className="dashboard-main">
          {children}
        </div>
      </div>
    </main>
  );
}
