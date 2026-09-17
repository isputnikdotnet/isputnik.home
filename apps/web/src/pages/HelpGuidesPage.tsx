import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DashboardShell } from "../app/DashboardShell";
import { followBack, followRoute } from "../router";
import { useSession } from "../app/SessionContext";
import { GUIDES, guideHref, helpTopics } from "../features/help/catalog";

// Every guide this person can open, under the same topics as the Help page. A
// topic row there that covers several guides opens its section here
// (/help/guides#gallery).
export function HelpGuidesPage() {
  const { user } = useSession();
  const { t } = useTranslation();
  const topics = helpTopics(user.role === "admin");

  // The sections render with the page, but an in-app navigation doesn't jump to
  // a hash the way a page load does.
  const hash = window.location.hash;
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [hash]);

  return (
    <DashboardShell active="help">
      <section className="work-area help-area">
        <a className="audiobook-back-button" href="/help" onClick={(event) => followBack(event, "/help")}>
          <ArrowLeft size={18} aria-hidden="true" />
          <span>{t("help.heading")}</span>
        </a>

        <header className="help-header">
          <p className="eyebrow">{t("help.eyebrow")}</p>
          <h1>{t("help.guidesHeading")}</h1>
          <p className="section-description">{t("help.guidesIntro")}</p>
        </header>

        {topics.map((topic) => {
          const TopicIcon = topic.icon;
          return (
            <section className="help-section" id={topic.id} key={topic.id} aria-labelledby={`help-guides-${topic.id}`}>
              <h2 className="help-section-title" id={`help-guides-${topic.id}`}>
                <TopicIcon size={20} aria-hidden="true" />
                {topic.title}
                {topic.adminOnly && <span className="help-admin-badge">{t("help.adminBadge")}</span>}
              </h2>
              <div className="help-card-list">
                {topic.guides.map((key) => {
                  const { icon: Icon, title, description } = GUIDES[key];
                  const href = guideHref(key);
                  return (
                    <a className="help-card" key={key} href={href} onClick={(event) => followRoute(event, href)}>
                      <span className="help-card-icon" aria-hidden="true">
                        <Icon size={22} />
                      </span>
                      <span className="help-card-copy">
                        <strong>{title}</strong>
                        <span>{description}</span>
                      </span>
                    </a>
                  );
                })}
              </div>
            </section>
          );
        })}
      </section>
    </DashboardShell>
  );
}
