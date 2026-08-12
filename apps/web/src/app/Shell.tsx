import React from "react";
import packageInfo from "../../../../package.json";

// Same source as the Dashboard footer and the setup guide: the root package.json,
// which is the version the running server reports too.
const APP_VERSION = packageInfo.version;

// A holding screen for someone who is already signed in. Shell below is the
// sign-in scene — hero, orbits, brand panel — so using it to say "loading" tells
// a signed-in user they have been signed out. This says nothing at all instead,
// on the app's own background, which is what a page that is about to appear
// should look like.
export function AppLoading({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-loading">
      {children}
    </main>
  );
}

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
          <img src="/Assets/brand/isputnik-logo-sputnik-earth-mark.svg" alt="" />
          <div>
            <strong>isputnik.home</strong>
            <span>our world revolves around you.</span>
          </div>
        </div>
        {children}
        {/* Which build this is, before anyone has signed in — the first thing to ask
            when a device misbehaves is whether it is running what you think it is.
            Here rather than on the sign-in form so install, invite and the 2FA step
            answer it too. */}
        <p className="auth-version">isputnik.home v{APP_VERSION}</p>
      </section>
    </main>
  );
}
