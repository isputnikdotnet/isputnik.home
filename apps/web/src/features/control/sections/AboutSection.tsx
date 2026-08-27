import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Compass } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { AboutDetails, type AboutInfo } from "../../../shared/AboutDetails";
import { navigate } from "../../../router";
import { ControlSectionHead } from "../ControlSectionHead";

export function AboutSection() {
  const { t } = useTranslation(["common", "control"]);
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ about: AboutInfo }>("/api/about")
      .then((payload) => setAbout(payload.about))
      .catch((err) => setError(err instanceof Error ? err.message : t("control:about.unableToLoad")));
  }, [t]);

  return (
    <>
      <ControlSectionHead section="about" description={t("control:about.description")} />

      {error && <MessageBox tone="error" title={t("control:about.errorTitle")}>{error}</MessageBox>}

      {/* The way back into the setup guide. It opens itself once, for the first
          administrator, and skipping is a real answer — so without this the only way
          back would be typing the address. */}
      <section className="library-settings-panel storage-settings-panel">
        <div>
          <h2>{t("control:about.setupGuideTitle")}</h2>
          <p>{t("control:about.setupGuideBody")}</p>
        </div>
        <div className="library-settings-actions">
          <Button variant="secondary" compact onClick={() => navigate("/welcome")}>
            <Compass size={16} aria-hidden="true" />
            <span>{t("control:about.runSetupGuide")}</span>
          </Button>
        </div>
      </section>

      {about && <AboutDetails about={about} />}
    </>
  );
}
