import { useState, type FormEvent } from "react";
import { UserRound } from "lucide-react";
import { api, type PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { LibraryNavTabs } from "../features/library/LibraryNavTabs";
import { Field } from "../shared/Field";
import { Button } from "../shared/Button";
import { MessageBox } from "../shared/MessageBox";
import { ThemePicker, type Theme } from "../shared/ThemePicker";
import { InstallCard } from "../pwa/InstallCard";
import { ChangeEmailSection } from "../features/profile/ChangeEmailSection";
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
  const [ereaderEmail, setEreaderEmail] = useState(user.ereaderEmail ?? "");
  const [ereaderStatus, setEreaderStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [ereaderError, setEreaderError] = useState("");

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

  // Saved on its own (a blank value clears it). Other fields are passed through
  // unchanged so this never disturbs the display name or theme.
  const saveEreader = async (event: FormEvent) => {
    event.preventDefault();
    setEreaderStatus("saving");
    setEreaderError("");
    try {
      const payload = await api<{ user: PublicUser }>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName: user.displayName, theme: user.theme, ereaderEmail: ereaderEmail.trim() })
      });
      onUpdated(payload.user);
      setEreaderStatus("saved");
    } catch (err) {
      setEreaderError(err instanceof Error ? err.message : "Unable to save e-reader email");
      setEreaderStatus("idle");
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

        <ChangeEmailSection email={user.email} onChanged={onUpdated} />

        <ChangePasswordSection />

        <section className="appearance-section" aria-labelledby="appearance-heading">
          <h2 id="appearance-heading">Appearance</h2>
          <p className="appearance-intro">Choose how iSputnik looks. Your choice is saved to your account and applies right away.</p>
          <ThemePicker value={user.theme} onChange={chooseTheme} disabled={themeSaving} />
          {themeError && <MessageBox tone="error" title="Unable to save">{themeError}</MessageBox>}
        </section>

        <section className="ereader-section" aria-labelledby="ereader-heading">
          <h2 id="ereader-heading">Send to e-reader</h2>
          <p className="ereader-intro">
            The address your Kindle or Kobo receives documents at (e.g. <code>you@kindle.com</code>). From any
            ebook's page you can then send its EPUB or PDF straight to your device. Add the server's sender
            address to your device's approved-senders list first — and an admin must set up email delivery.
          </p>
          <form className="ereader-form" onSubmit={saveEreader}>
            <Field
              label="E-reader email"
              value={ereaderEmail}
              onChange={setEreaderEmail}
              type="email"
              autoComplete="email"
              placeholder="you@kindle.com"
              required={false}
            />
            {ereaderError && <MessageBox tone="error" title="Unable to save">{ereaderError}</MessageBox>}
            {ereaderStatus === "saved" && <MessageBox tone="success" title="Saved">Your e-reader email has been updated.</MessageBox>}
            <div className="ereader-actions">
              <Button variant="primary" type="submit" disabled={ereaderStatus === "saving"}>
                {ereaderStatus === "saving" ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </section>

        <InstallCard
          title="Install the mobile app"
          subtitle="Add iSputnik to your phone's home screen to listen offline and download books for the road."
        />
      </section>
    </DashboardShell>
  );
}
