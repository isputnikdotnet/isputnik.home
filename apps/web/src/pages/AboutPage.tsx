import { useState, useEffect } from "react";
import { api, type PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { MessageBox } from "../shared/MessageBox";
import { AboutDetails, type AboutInfo } from "../shared/AboutDetails";

export function AboutPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ about: AboutInfo }>("/api/about")
      .then((payload) => setAbout(payload.about))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load application information"));
  }, []);

  return (
    <DashboardShell active="about" user={user} logout={logout}>
      <section className="work-area scene-page sputnik-scene about-scene about-area">
        <p className="eyebrow">Application</p>
        <h1>About</h1>
        {error && <MessageBox tone="error" title="About error">{error}</MessageBox>}
        {about && <AboutDetails about={about} />}
      </section>
    </DashboardShell>
  );
}
