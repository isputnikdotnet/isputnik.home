import { ArrowRight, ChevronRight, CircleHelp, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DashboardShell } from "../app/DashboardShell";
import { followRoute } from "../router";
import { REPO_ISSUES_URL } from "../shared/links";
import { useSession } from "../app/SessionContext";
import { GUIDES_INDEX_PATH, guideHref, helpTopics, quickStart, topicHref } from "../features/help/catalog";
import { HelpSearch } from "../features/help/HelpSearch";
import { HelpFaq } from "../features/help/HelpFaq";

// Help & guides: search across every guide, a few places to start, the topics,
// common questions, and where to go when none of that answered it. What's listed
// lives in features/help/catalog.ts; the guides themselves in docs/users/.
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
          <h1>{t("help.heading")}</h1>
          <p className="section-description">{t("help.intro")}</p>
          <HelpSearch isAdmin={isAdmin} />
        </header>

        <section className="help-block" aria-labelledby="help-quick-start">
          <div className="help-block-head">
            <h2 id="help-quick-start">{t("help.quickStart")}</h2>
            <a className="help-more" href={GUIDES_INDEX_PATH} onClick={(event) => followRoute(event, GUIDES_INDEX_PATH)}>
              {t("help.viewAllGuides")}
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          </div>
          <div className="help-tiles">
            {quickStart(isAdmin).map(({ guide, icon: Icon, title, summary }) => {
              const href = guideHref(guide);
              return (
                <a className="help-tile" key={guide} href={href} onClick={(event) => followRoute(event, href)}>
                  <span className="help-tile-icon" aria-hidden="true">
                    <Icon size={26} />
                  </span>
                  <strong>{title}</strong>
                  <span>{summary}</span>
                </a>
              );
            })}
          </div>
        </section>

        <section className="help-block help-block-ruled" aria-labelledby="help-topics">
          <h2 id="help-topics">{t("help.browseByTopic")}</h2>
          <div className="help-topics">
            {helpTopics(isAdmin).map((topic) => {
              const Icon = topic.icon;
              const href = topicHref(topic);
              return (
                <a className="help-topic" key={topic.id} href={href} onClick={(event) => followRoute(event, href)}>
                  <span className="help-card-icon" aria-hidden="true">
                    <Icon size={22} />
                  </span>
                  <span className="help-card-copy">
                    <strong>
                      {topic.title}
                      {topic.adminOnly && <span className="help-admin-badge">{t("help.adminBadge")}</span>}
                    </strong>
                    <span>{topic.summary}</span>
                  </span>
                  <ChevronRight className="help-card-arrow" size={18} aria-hidden="true" />
                </a>
              );
            })}
          </div>
        </section>

        <HelpFaq isAdmin={isAdmin} />

        <aside className="help-contact">
          <span className="help-card-icon" aria-hidden="true">
            <CircleHelp size={24} />
          </span>
          <span className="help-card-copy">
            <strong>{t("help.stillNeedHelp")}</strong>
            <span>{t("help.stillNeedHelpBody")}</span>
          </span>
          <a className="secondary-button help-contact-button" href={REPO_ISSUES_URL} target="_blank" rel="noreferrer">
            {t("help.reportBug")}
            <ExternalLink size={16} aria-hidden="true" />
          </a>
        </aside>
      </section>
    </DashboardShell>
  );
}
