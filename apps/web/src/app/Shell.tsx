import React from "react";

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-shell">
      <div className="auth-scene" aria-hidden="true">
        <span className="auth-orbit auth-orbit-a"></span>
        <span className="auth-orbit auth-orbit-b"></span>
        <span className="auth-orbit auth-orbit-c"></span>
        <span className="auth-node auth-node-a"></span>
        <span className="auth-node auth-node-b"></span>
        <span className="auth-node auth-node-c"></span>
      </div>
      <div className="auth-hero">
        <p className="eyebrow">Open source software for a small trusted orbit</p>
        <h1>isputnik</h1>
      </div>
      <section className="auth-panel">
        <div className="brand-row">
          <img src="/Assets/brand/isputnik-app-icon.svg" alt="" />
          <div>
            <strong>isputnik.home</strong>
            <span>our world revolves around you.</span>
          </div>
        </div>
        {children}
      </section>
    </main>
  );
}
