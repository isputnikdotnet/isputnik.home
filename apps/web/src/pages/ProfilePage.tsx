import { useState, type FormEvent } from "react";
import { Monitor, Moon, Orbit, Sparkles, Sun, UserRound } from "lucide-react";
import { api, type PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { Field } from "../shared/Field";
import { MessageBox } from "../shared/MessageBox";
import { InstallCard } from "../pwa/InstallCard";

function ThemeOption({
  icon,
  label,
  selected,
  onClick
}: {
  icon: React.ReactNode;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button className={selected ? "selected" : ""} type="button" role="radio" aria-checked={selected} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

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
  const [theme, setTheme] = useState(user.theme);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("saving");
    setError("");
    try {
      const payload = await api<{ user: PublicUser }>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName, theme })
      });
      onUpdated(payload.user);
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save profile");
      setStatus("idle");
    }
  };

  return (
    <DashboardShell active="profile" user={user} logout={logout}>
      <section className="work-area profile-area">
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
          <label className="field" id="profile-theme">
            <span>Appearance</span>
            <span className="theme-switcher" role="radiogroup" aria-label="Theme preference">
              <ThemeOption icon={<Monitor size={17} />} label="System" selected={theme === "system"} onClick={() => setTheme("system")} />
              <ThemeOption icon={<Sun size={17} />} label="Plain Light" selected={theme === "plain-light"} onClick={() => setTheme("plain-light")} />
              <ThemeOption icon={<Moon size={17} />} label="Plain Dark" selected={theme === "plain-dark"} onClick={() => setTheme("plain-dark")} />
              <ThemeOption icon={<Sparkles size={17} />} label="iSputnik Light" selected={theme === "light"} onClick={() => setTheme("light")} />
              <ThemeOption icon={<Orbit size={17} />} label="iSputnik Night" selected={theme === "dark"} onClick={() => setTheme("dark")} />
            </span>
          </label>
          {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
          {status === "saved" && <MessageBox tone="success" title="Profile updated">Your settings have been saved.</MessageBox>}
          <button className="primary-button" disabled={status === "saving"}>
            {status === "saving" ? "Saving..." : "Save changes"}
          </button>
        </form>

        <InstallCard
          title="Install the mobile app"
          subtitle="Add iSputnik to your phone's home screen to listen offline and download books for the road."
        />
      </section>
    </DashboardShell>
  );
}
