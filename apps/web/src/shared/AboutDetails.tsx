import { useState } from "react";
import { Info, Heart, Scale } from "lucide-react";
import { api } from "../api";
import { Button } from "./Button";
import { MessageBox } from "./MessageBox";
import { AboutCredits } from "./AboutCredits";

// The AGPL asks that everyone using the app over a network be told where to get
// its source, so this sits on the shared About panel — reachable from /about by
// any signed-in user, not just admins in the control panel.
const SOURCE_URL = "https://github.com/isputnikdotnet/isputnik.home";
const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";

export interface VersionUpdate {
  version: string;
  label: string;
  changes: string[];
}

export interface AboutInfo {
  name: string;
  version: string;
  description: string;
  runtime: string;
  database: string;
  server: string;
  frontend: string;
  /** The newest releases only — see versionUpdatesTotal and /api/about/changelog. */
  versionUpdates: VersionUpdate[];
  versionUpdatesTotal: number;
}

/** Releases fetched per press of "Show earlier versions". Must not exceed the
 *  server's per-request cap (core/status.ts). */
const CHANGELOG_PAGE = 25;

type AboutTab = "about" | "credits";

const ABOUT_TABS: { key: AboutTab; label: string; icon: typeof Info }[] = [
  { key: "about", label: "About", icon: Info },
  { key: "credits", label: "Credits", icon: Heart }
];

export function AboutDetails({ about }: { about: AboutInfo }) {
  const [tab, setTab] = useState<AboutTab>("about");
  // The release history runs to hundreds of entries, so /api/about sends only
  // the newest few and the rest arrive a page at a time from here.
  const [earlier, setEarlier] = useState<VersionUpdate[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState("");
  const updates = [...about.versionUpdates, ...earlier];
  const remaining = about.versionUpdatesTotal - updates.length;

  const loadEarlier = async () => {
    setLoadingEarlier(true);
    setEarlierError("");
    try {
      const payload = await api<{ versionUpdates: VersionUpdate[] }>(
        `/api/about/changelog?offset=${updates.length}&limit=${CHANGELOG_PAGE}`
      );
      setEarlier((current) => [...current, ...payload.versionUpdates]);
    } catch {
      setEarlierError("Could not load earlier versions. Check your connection and try again.");
    } finally {
      setLoadingEarlier(false);
    }
  };

  const stack = [
    { label: "Runtime", value: about.runtime },
    { label: "Database", value: about.database },
    { label: "Server", value: about.server },
    { label: "Frontend", value: about.frontend },
  ];

  return (
    <section className="about-panel">
      <div className="about-heading">
        <div className="about-icon-wrap">
          <img src="/Assets/brand/isputnik-logo-sputnik-earth-mark.svg" alt="" />
        </div>
        <div className="about-heading-text">
          <h2>{about.name}</h2>
          <p className="about-code-name">Спутник Один</p>
          <span className="about-version-badge">v{about.version}</span>
        </div>
      </div>

      <div className="control-tabs about-tabs" role="tablist" aria-label="About sections">
        {ABOUT_TABS.map(({ key, label, icon: Icon }) => {
          const selected = tab === key;
          return (
            <Button
              key={key}
              variant="text"
              className={`config-tab${selected ? " active" : ""}`}
              role="tab"
              aria-selected={selected}
              aria-controls={`about-panel-${key}`}
              id={`about-tab-${key}`}
              onClick={() => setTab(key)}
            >
              <Icon className="config-tab-icon" size={18} aria-hidden="true" />
              <span>{label}</span>
            </Button>
          );
        })}
      </div>

      <div className="config-tab-panel" role="tabpanel" id="about-panel-about" aria-labelledby="about-tab-about" hidden={tab !== "about"}>
        <p className="about-description">{about.description}</p>

        <div className="about-stack">
          {stack.map(({ label, value }) => (
            <div className="about-stack-item" key={label}>
              <span className="about-stack-label">{label}</span>
              <span className="about-stack-value">{value}</span>
            </div>
          ))}
        </div>

        <div className="about-license">
          <Scale className="about-license-icon" size={18} aria-hidden="true" />
          <p className="about-license-text">
            Free software under the{" "}
            <a className="about-license-link" href={LICENSE_URL} target="_blank" rel="noreferrer">GNU AGPL v3</a>
            {" — "}you are entitled to the source code for the version you are running.{" "}
            <a className="about-license-link" href={SOURCE_URL} target="_blank" rel="noreferrer">Get the source</a>
          </p>
        </div>

        <section className="version-updates" aria-label="Version updates">
          <p className="version-updates-eyebrow">What's new</p>
          <div className="version-timeline-frame">
            <div className="version-timeline">
              {updates.map((update, index) => (
                <article
                  className={`version-update${index === 0 ? " version-update-current" : ""}`}
                  key={update.version}
                >
                  <div className="version-update-dot" aria-hidden="true" />
                  <div className="version-update-body">
                    <div className="version-update-head">
                      <strong className="version-update-num">v{update.version}</strong>
                      <span className="version-update-label">{update.label}</span>
                    </div>
                    <ul className="version-update-list">
                      {update.changes.map((change) => <li key={change}>{change}</li>)}
                    </ul>
                  </div>
                </article>
              ))}
            </div>
            {/* Inside the scroll frame, so it meets the reader at the end of the
                list rather than sitting below a box that still looks scrollable. */}
            {earlierError && <MessageBox tone="error" title="Unable to load">{earlierError}</MessageBox>}
            {remaining > 0 && (
              <div className="version-updates-more">
                <Button variant="secondary" onClick={loadEarlier} disabled={loadingEarlier}>
                  {loadingEarlier ? "Loading earlier versions…" : `Show earlier versions (${remaining})`}
                </Button>
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="config-tab-panel" role="tabpanel" id="about-panel-credits" aria-labelledby="about-tab-credits" hidden={tab !== "credits"}>
        <AboutCredits />
      </div>
    </section>
  );
}
