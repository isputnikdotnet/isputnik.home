import { useState } from "react";
import { Info, Heart } from "lucide-react";
import { Button } from "./Button";
import { AboutCredits } from "./AboutCredits";

export interface AboutInfo {
  name: string;
  version: string;
  description: string;
  runtime: string;
  database: string;
  server: string;
  frontend: string;
  versionUpdates: {
    version: string;
    label: string;
    changes: string[];
  }[];
}

type AboutTab = "about" | "credits";

const ABOUT_TABS: { key: AboutTab; label: string; icon: typeof Info }[] = [
  { key: "about", label: "About", icon: Info },
  { key: "credits", label: "Credits", icon: Heart }
];

export function AboutDetails({ about }: { about: AboutInfo }) {
  const [tab, setTab] = useState<AboutTab>("about");
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

        <section className="version-updates" aria-label="Version updates">
          <p className="version-updates-eyebrow">What's new</p>
          <div className="version-timeline-frame">
            <div className="version-timeline">
              {about.versionUpdates.map((update, index) => (
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
          </div>
        </section>
      </div>

      <div className="config-tab-panel" role="tabpanel" id="about-panel-credits" aria-labelledby="about-tab-credits" hidden={tab !== "credits"}>
        <AboutCredits />
      </div>
    </section>
  );
}
