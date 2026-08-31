import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api, type PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { MessageBox } from "../shared/MessageBox";
import { AboutDetails, type AboutInfo } from "../shared/AboutDetails";

export function AboutPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const { t } = useTranslation(["common", "misc"]);
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ about: AboutInfo }>("/api/about")
      .then((payload) => setAbout(payload.about))
      .catch((err) => setError(err instanceof Error ? err.message : t("misc:about.unableToLoad")));
  }, [t]);

  return (
    <DashboardShell active="about" user={user} logout={logout}>
      <section className="work-area about-area">
        <p className="eyebrow">{t("misc:about.eyebrow")}</p>
        <h1>{t("misc:about.heading")}</h1>
        {error && <MessageBox tone="error" title={t("misc:about.errorTitle")}>{error}</MessageBox>}
        {about && <AboutDetails about={about} />}
      </section>
    </DashboardShell>
  );
}
