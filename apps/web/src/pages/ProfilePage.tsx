import { useState, type FormEvent } from "react";
import { UserRound } from "lucide-react";
import { api, type PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { LibraryNavTabs } from "../features/audiobooks/LibraryNavTabs";
import { Field } from "../shared/Field";
import { MessageBox } from "../shared/MessageBox";
import { InstallCard } from "../pwa/InstallCard";

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

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("saving");
    setError("");
    try {
      // Theme lives on its own page now; keep the user's current theme unchanged.
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

        <InstallCard
          title="Install the mobile app"
          subtitle="Add iSputnik to your phone's home screen to listen offline and download books for the road."
        />
      </section>
    </DashboardShell>
  );
}
