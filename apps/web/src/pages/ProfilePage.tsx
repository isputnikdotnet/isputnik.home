import { useState, type FormEvent } from "react";
import { UserRound } from "lucide-react";
import { api, type PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { LibraryNavTabs } from "../features/library/LibraryNavTabs";
import { Field } from "../shared/Field";
import { MessageBox } from "../shared/MessageBox";
import { ThemePicker, type Theme } from "../shared/ThemePicker";
import { InstallCard } from "../pwa/InstallCard";
import { ChangePasswordSection } from "../features/profile/ChangePasswordSection";

export function ProfilePage({
  user,
  logout,
  onUpdated
}: {
  user: PublicUser;
  logout: () => Promise<void>;
  onUpdated: (user: PublicUser) => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");
  const [themeSaving, setThemeSaving] = useState(false);
  const [themeError, setThemeError] = useState("");

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("saving");
    setError("");
    try {
      // Theme is saved on its own below; keep the user's current theme unchanged here.
      const payload = await api<{ user: PublicUser }>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName, theme: user.theme })
      });
      onUpdated(payload.user);
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save profile");
      setStatus("idle");
    }
  };

  // Theme saves immediately on selection (optimistic): apply the look right away,
  // then persist, reverting if the request fails. Display name is left untouched.
  const chooseTheme = async (theme: Theme) => {
    if (themeSaving || theme === user.theme) return;
    setThemeError("");
    setThemeSaving(true);
    const previous = user;
    onUpdated({ ...user, theme });
    try {
      const payload = await api<{ user: PublicUser }>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName: user.displayName, theme })
      });
      onUpdated(payload.user);
    } catch (err) {
      onUpdated(previous);
      setThemeError(err instanceof Error ? err.message : "Unable to save theme");
    } finally {
      setThemeSaving(false);
    }
  };

  return (
    <DashboardShell active="profile" user={user} logout={logout}>
      <section className="work-area profile-area">
        <LibraryNavTabs active="profile" />
        <p className="eyebrow">Profile</p>
        <h1>Your account</h1>
        <form className="profile-form" onSubmit={saveProfile}>
          <div className="profile-heading">
            <span className="avatar large" aria-hidden="true"><UserRound size={28} /></span>
            <div>
              <strong>{user.displayName}</strong>
              <span>{user.email}</span>
            </div>
          </div>
          <Field label="Display name" value={displayName} onChange={setDisplayName} autoComplete="name" />
          {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
          {status === "saved" && <MessageBox tone="success" title="Profile updated">Your settings have been saved.</MessageBox>}
          <button className="primary-button" disabled={status === "saving"}>
            {status === "saving" ? "Saving..." : "Save changes"}
          </button>
        </form>

        <ChangePasswordSection />

        <section className="appearance-section" aria-labelledby="appearance-heading">
          <h2 id="appearance-heading">Appearance</h2>
          <p className="appearance-intro">Choose how iSputnik looks. Your choice is saved to your account and applies right away.</p>
          <ThemePicker value={user.theme} onChange={chooseTheme} disabled={themeSaving} />
          {themeError && <MessageBox tone="error" title="Unable to save">{themeError}</MessageBox>}
        </section>

        <InstallCard
          title="Install the mobile app"
          subtitle="Add iSputnik to your phone's home screen to listen offline and download books for the road."
        />
      </section>
    </DashboardShell>
  );
}
