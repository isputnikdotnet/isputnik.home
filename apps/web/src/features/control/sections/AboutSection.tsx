import { useState, useEffect } from "react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { AboutDetails, type AboutInfo } from "../../../shared/AboutDetails";
import { ControlSectionHead } from "../ControlSectionHead";

export function AboutSection() {
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ about: AboutInfo }>("/api/about")
      .then((payload) => setAbout(payload.about))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load application information"));
  }, []);

  return (
    <>
      <ControlSectionHead section="about" description="Version, credits and what changed in each release." />

      {error && <MessageBox tone="error" title="About error">{error}</MessageBox>}
      {about && <AboutDetails about={about} />}
    </>
  );
}
