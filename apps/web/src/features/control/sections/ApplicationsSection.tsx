import { useTranslation } from "react-i18next";
import { ArrowRight, LayoutGrid } from "lucide-react";
import { controlHref, followRoute } from "../../../router";
import { ControlSectionHead } from "../ControlSectionHead";
import { appPageHref } from "../links";
import { APPLICATIONS, DIRECTORY_EXTRAS, appDescription, appLabel, rowLabel } from "../nav";

// Applications (control panel v2, docs/control-panel-v2-plan.md): the directory.
// One card per application with what it is and the way into each tab of its
// workspace, so everything about Gallery is found by choosing Gallery rather than
// by knowing which group a setting was filed under. Status and Setup arrive with
// phase 2; an application without a workspace yet (Games) links to the page that
// serves it today.
export function ApplicationsSection() {
  const { t } = useTranslation(["common", "control"]);

  return (
    <>
      <ControlSectionHead section="applications" icon={<LayoutGrid size={30} />} description={t("control:applications.description")} />
      <div className="organization-grid">
        {APPLICATIONS.map((app) => {
          const Icon = app.icon;
          const first = controlHref(app.tabs[0].section);
          return (
            <section key={app.key} className="organization-card">
              <div className="organization-card-top">
                <span className="organization-card-icon" aria-hidden="true"><Icon size={20} /></span>
                <div>
                  <h2>
                    <a href={first} onClick={(event) => followRoute(event, first)}>{appLabel(app.key)}</a>
                  </h2>
                  <p>{appDescription(app.key)}</p>
                </div>
              </div>
              {/* The workspace's own tabs, by their row's words — or one way in. */}
              <div className="organization-actions">
                {app.tabs.length > 1 ? app.tabs.map((tab) => {
                  const href = controlHref(tab.section);
                  return (
                    <a key={tab.section} className="secondary-button compact-button" href={href} onClick={(event) => followRoute(event, href)}>
                      {rowLabel(tab)}
                    </a>
                  );
                }) : (
                  <a className="secondary-button compact-button" href={first} onClick={(event) => followRoute(event, first)}>
                    {t("control:applications.open", { app: appLabel(app.key) })}
                    <ArrowRight size={15} aria-hidden="true" />
                  </a>
                )}
              </div>
            </section>
          );
        })}
        {DIRECTORY_EXTRAS.map((extra) => {
          const Icon = extra.icon;
          const href = appPageHref("appsSetup", extra.key);
          return (
            <section key={extra.key} className="organization-card">
              <div className="organization-card-top">
                <span className="organization-card-icon" aria-hidden="true"><Icon size={20} /></span>
                <div>
                  <h2>
                    <a href={href} onClick={(event) => followRoute(event, href)}>{appLabel(extra.key)}</a>
                  </h2>
                  <p>{appDescription(extra.key)}</p>
                </div>
              </div>
              <div className="organization-actions">
                <a className="secondary-button compact-button" href={href} onClick={(event) => followRoute(event, href)}>
                  {t("control:applications.connection")}
                  <ArrowRight size={15} aria-hidden="true" />
                </a>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
