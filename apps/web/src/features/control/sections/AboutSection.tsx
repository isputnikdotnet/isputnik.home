import { useState, useEffect } from "react";
import { Compass } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { AboutDetails, type AboutInfo } from "../../../shared/AboutDetails";
import { navigate } from "../../../router";
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

      {/* The way back into the setup guide. It opens itself once, for the first
          administrator, and skipping is a real answer — so without this the only way
          back would be typing the address. */}
      <section className="library-settings-panel storage-settings-panel">
        <div>
          <h2>Setup guide</h2>
          <p>Walks through storage, the Recycle Bin, email, sign-in alerts and the default theme.</p>
        </div>
        <div className="library-settings-actions">
          <Button variant="secondary" compact onClick={() => navigate("/welcome")}>
            <Compass size={16} aria-hidden="true" />
            <span>Run the setup guide</span>
          </Button>
        </div>
      </section>

      {about && <AboutDetails about={about} />}
    </>
  );
}
