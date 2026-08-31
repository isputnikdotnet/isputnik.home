import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
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

const ABOUT_TABS: { key: AboutTab; labelKey: "tabAbout" | "tabCredits"; icon: typeof Info }[] = [
  { key: "about", labelKey: "tabAbout", icon: Info },
  { key: "credits", labelKey: "tabCredits", icon: Heart }
];

export function AboutDetails({ about }: { about: AboutInfo }) {
  const { t } = useTranslation(["common", "misc"]);
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
      setEarlierError(t("misc:about.unableToLoadEarlier"));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const stack = [
    { label: t("misc:about.stackRuntime"), value: about.runtime },
    { label: t("misc:about.stackDatabase"), value: about.database },
    { label: t("misc:about.stackServer"), value: about.server },
    { label: t("misc:about.stackFrontend"), value: about.frontend },
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

      <div className="control-tabs about-tabs" role="tablist" aria-label={t("misc:about.sectionsAria")}>
        {ABOUT_TABS.map(({ key, labelKey, icon: Icon }) => {
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
              <span>{t(`misc:about.${labelKey}`)}</span>
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
            <Trans
              i18nKey="about.licenseText"
              ns="misc"
              components={{
                agpl: <a className="about-license-link" href={LICENSE_URL} target="_blank" rel="noreferrer" />,
                source: <a className="about-license-link" href={SOURCE_URL} target="_blank" rel="noreferrer" />
              }}
            />
          </p>
        </div>

        <section className="version-updates" aria-label={t("misc:about.versionUpdatesAria")}>
          <p className="version-updates-eyebrow">{t("misc:about.whatsNew")}</p>
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
            {earlierError && <MessageBox tone="error" title={t("misc:common.unableToLoad")}>{earlierError}</MessageBox>}
            {remaining > 0 && (
              <div className="version-updates-more">
                <Button variant="secondary" onClick={loadEarlier} disabled={loadingEarlier}>
                  {loadingEarlier ? t("misc:about.loadingEarlierVersions") : t("misc:about.showEarlierVersions", { count: remaining })}
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
