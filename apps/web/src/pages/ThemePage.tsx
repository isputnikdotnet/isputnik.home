import { useState } from "react";
import { api, type PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { LibraryNavTabs } from "../features/audiobooks/LibraryNavTabs";
import { MessageBox } from "../shared/MessageBox";
import { ThemePicker, type Theme } from "../shared/ThemePicker";

export function ThemePage({
  user,
  logout,
  onUpdated
}: {
  user: PublicUser;
  logout: () => Promise<void>;
  onUpdated: (user: PublicUser) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const choose = async (theme: Theme) => {
    if (saving || theme === user.theme) return;
    setError("");
    setSaving(true);
    const previous = user;
    onUpdated({ ...user, theme }); // optimistic — applies the look immediately
    try {
      // The profile endpoint expects both fields; keep the display name unchanged.
      const payload = await api<{ user: PublicUser }>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName: user.displayName, theme })
      });
      onUpdated(payload.user);
    } catch (err) {
      onUpdated(previous); // revert on failure
      setError(err instanceof Error ? err.message : "Unable to save theme");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DashboardShell active="profile" user={user} logout={logout}>
      <section className="work-area profile-area">
        <LibraryNavTabs active="theme" />
        <p className="eyebrow">Settings</p>
        <h1>Appearance</h1>
        <p className="muted">Choose how iSputnik looks. Your choice is saved to your account and applies right away.</p>
        <ThemePicker value={user.theme} onChange={choose} disabled={saving} />
        {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
      </section>
    </DashboardShell>
  );
}
