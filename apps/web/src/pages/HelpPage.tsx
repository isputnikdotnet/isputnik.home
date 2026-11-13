import { ArrowRight, CircleHelp, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DashboardShell } from "../app/DashboardShell";
import { followRoute } from "../router";
import { bugReportUrl } from "../shared/links";
import { APP_VERSION } from "../shared/appVersion";
import { useSession } from "../app/SessionContext";
import { FEATURED_GUIDE, GUIDES, guideHref, guideVisible, helpShelves, type GuideEntry } from "../features/help/catalog";
import { useDiagram } from "../features/help/diagrams";
import { HelpSearch } from "../features/help/HelpSearch";
import { HelpFaq } from "../features/help/HelpFaq";

// Help: the handbook. Search across every guide, the newest guide worth setting
// up, the common questions, and every guide on shelves grouped like the app.
// What's listed lives in features/help/catalog.ts; the guides themselves in
// docs/users/.
export function HelpPage() {
  const { user } = useSession();
  const { t } = useTranslation();
  // Setup guides describe the control panel, which members can't open — listing
  // them would only point at doors that aren't there.
  const isAdmin = user.role === "admin";

  return (
    <DashboardShell active="help">
      <section className="work-area help-area">
        <header className="help-header">
          <p className="eyebrow">{t("help.eyebrow")}</p>
          <h1>{t("help.handbookTitle")}</h1>
          <p className="section-description">{t("help.intro")}</p>
          <HelpSearch isAdmin={isAdmin} />
        </header>

        {guideVisible(FEATURED_GUIDE.guide, isAdmin) && <FeaturedGuide />}

        <HelpFaq isAdmin={isAdmin} />

        <section className="help-block" aria-labelledby="help-shelves">
          <h2 id="help-shelves">{t("help.allGuides")}</h2>
          <div className="help-shelves">
            {helpShelves(isAdmin).map((shelf) => {
              const Icon = shelf.icon;
              return (
                <section className="help-shelf" key={shelf.id} aria-labelledby={`help-shelf-${shelf.id}`}>
                  <h3 id={`help-shelf-${shelf.id}`}>
                    <Icon size={18} aria-hidden="true" />
                    {shelf.title}
                    {shelf.adminOnly && <span className="help-admin-badge">{t("help.adminBadge")}</span>}
                  </h3>
                  <ul>
                    {shelf.guides.map((key) => {
                      const href = guideHref(key);
                      return (
                        <li key={key}>
                          <a href={href} title={GUIDES[key].description} onClick={(event) => followRoute(event, href)}>
                            <span>{GUIDES[key].title}</span>
                            {isNew(key) && <span className="help-new">{t("help.newBadge")}</span>}
                            {!shelf.adminOnly && (GUIDES[key] as GuideEntry).adminOnly && (
                              <span className="help-admin-badge">{t("help.adminBadge")}</span>
                            )}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </section>

        <aside className="help-contact">
          <span className="help-card-icon" aria-hidden="true">
            <CircleHelp size={24} />
          </span>
          <span className="help-card-copy">
            <strong>{t("help.stillNeedHelp")}</strong>
            <span>{t("help.stillNeedHelpBody")}</span>
          </span>
          <a className="secondary-button help-contact-button" href={bugReportUrl(APP_VERSION)} target="_blank" rel="noreferrer">
            {t("help.reportBug")}
            <ExternalLink size={16} aria-hidden="true" />
          </a>
        </aside>
      </section>
    </DashboardShell>
  );
}

// The guides that arrived with the featured one are marked New on the shelves.
const NEW_GUIDES = new Set(["phoneBackup", "phoneBackupLinking", "phoneSyncSetup"]);
const isNew = (key: string) => NEW_GUIDES.has(key);

function FeaturedGuide() {
  const { t } = useTranslation();
  const entry: GuideEntry = GUIDES[FEATURED_GUIDE.guide];
  const diagram = useDiagram(entry.diagram);
  const href = guideHref(FEATURED_GUIDE.guide);

  return (
    <section className="help-featured" aria-labelledby="help-featured-title">
      <div className="help-featured-copy">
        <span className="help-featured-badge">{FEATURED_GUIDE.badge}</span>
        <h2 id="help-featured-title">{entry.title}</h2>
        <p>{entry.description}</p>
        {entry.steps && (
          <ol>
            {entry.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
        <a className="primary-button help-featured-open" href={href} onClick={(event) => followRoute(event, href)}>
          {t("help.openGuide")}
          <ArrowRight size={16} aria-hidden="true" />
        </a>
      </div>
      {diagram && (
        // Our own file, shipped inside the image and sanitised by loadDiagram.
        <figure className="guide-diagram help-featured-diagram" aria-hidden="true" dangerouslySetInnerHTML={{ __html: diagram }} />
      )}
    </section>
  );
}
