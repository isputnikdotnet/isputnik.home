import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Compass, Info } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { GroupedList, NavRow } from "../../../shared/GroupedList";
import { AboutDetails, type AboutInfo } from "../../../shared/AboutDetails";
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
      <ControlSectionHead section="about" icon={<Info size={30} />} description={t("control:about.description")} />

      {error && <MessageBox tone="error" title={t("control:about.errorTitle")}>{error}</MessageBox>}

      {/* The way back into the setup guide. It opens itself once, for the first
          administrator, and skipping is a real answer — so without this the only way
          back would be typing the address. */}
      <div className="grouped-page">
        <GroupedList title={t("control:about.setupGuideTitle")} note={t("control:about.setupGuideBody")}>
          <NavRow icon={<Compass size={17} />} label={t("control:about.runSetupGuide")} href="/welcome" />
        </GroupedList>
      </div>

      {about && <AboutDetails about={about} />}
    </>
  );
}
