import type { PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";

export function HomePage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  return (
    <DashboardShell active="home" user={user} logout={logout}>
      <section className="work-area">
        <p className="eyebrow">Home</p>
        <h1>Welcome, {user.displayName}</h1>
        <div className="empty-state">
          <img src="/Assets/brand/isputnik-app-icon.svg" alt="" />
          <h2>isputnik.home</h2>
          <p className="muted">Your private family space is ready.</p>
        </div>
      </section>
    </DashboardShell>
  );
}
