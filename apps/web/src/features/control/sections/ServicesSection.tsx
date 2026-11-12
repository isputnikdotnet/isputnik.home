import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Server } from "lucide-react";
import { controlHref, followRoute } from "../../../router";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { formatUptime } from "../../../shared/utils";
import { ControlSectionHead } from "../ControlSectionHead";
import { appPageHref, logsHref } from "../links";
import { isRunning, useAppName, useAppsStatus, type AppStatus } from "./AppsSection";
import { useSystemStatus } from "./dashboard/useSystemStatus";

// Infrastructure › Services (control panel v2): one card per service — this server
// and each container beside it — saying whether it is up, how fast it answers and
// what uses it, with Test connection, its logs, and its Pairing (address and
// secret: appsSetup, a page under this one). Pairing used to be the first thing
// the page showed; it is one click away now, on the card it belongs to.

type ServiceState = "running" | "down" | "secret" | "unset";

function stateOf(app: AppStatus): ServiceState {
  if (!app.configured) return "unset";
  if (!app.server?.ok) return "down";
  if (app.secretAccepted === false) return "secret";
  return "running";
}

const STATE_TONE: Record<ServiceState, string> = { running: "app-setup-ok", down: "app-setup-warn", secret: "app-setup-warn", unset: "muted" };

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="secondary-button compact-button" href={href} onClick={(event) => followRoute(event, href)}>
      {children}
      <ArrowRight size={15} aria-hidden="true" />
    </a>
  );
}

function Facts({ rows }: { rows: [string, string, string?][] }) {
  return (
    <dl className="service-facts">
      {rows.map(([label, value, tone]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={tone}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ServicesSection() {
  const { t } = useTranslation(["common", "control"]);
  const appName = useAppName();
  const { status } = useSystemStatus();
  const { apps, error, load } = useAppsStatus();
  // Which cards have been tested since the page opened: the result shows on them.
  const [tested, setTested] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const test = async (id: string) => {
    setTesting(id);
    try {
      await load();
    } catch {
      // The card says what came back, or that nothing did.
    } finally {
      setTested((current) => ({ ...current, [id]: true }));
      setTesting(null);
    }
  };

  // What each container is for, in the words of the applications that use it.
  const usedBy = (id: string) => t(`control:services.usedBy.${id === "video" || id === "faces" || id === "games" ? id : "other"}`);

  return (
    <>
      <ControlSectionHead section="services" icon={<Server size={30} />} description={t("control:services.description")} />
      {error && <MessageBox tone="error" title={t("control:services.loadFailed")}>{error}</MessageBox>}

      <div className="organization-grid">
        <section className="organization-card app-setup-card">
          <div className="service-card-head">
            <h2>{t("control:services.home")}</h2>
            <span className="app-status-pill is-ready">{t("control:services.state.running")}</span>
          </div>
          <Facts
            rows={[
              [t("control:services.version"), status ? status.version : "…"],
              [t("control:services.upFor"), status ? formatUptime(status.uptimeSeconds) : "…"],
              [t("control:services.usedByLabel"), t("control:services.usedBy.home")]
            ]}
          />
          <div className="organization-actions">
            <Link href={controlHref("logs")}>{t("control:services.logs")}</Link>
            <Link href={controlHref("about")}>{t("control:services.about")}</Link>
          </div>
        </section>

        {(apps ?? []).map((app) => {
          const state = stateOf(app);
          const ms = app.server?.roundTripMs;
          const rows: [string, string, string?][] = [
            [t("control:services.status"), t(`control:services.state.${state}`), STATE_TONE[state]],
            [t("control:services.version"), app.server?.version ?? "—"]
          ];
          if (state === "running" && typeof ms === "number") rows.push([t("control:services.answersIn"), `${ms} ms`]);
          rows.push([t("control:services.usedByLabel"), usedBy(app.id)]);
          if (tested[app.id]) {
            rows.push([
              t("control:services.lastTest"),
              isRunning(app) ? t("control:services.testOk") : t("control:services.testFailed"),
              isRunning(app) ? "app-setup-ok" : "app-setup-warn"
            ]);
          }
          const pairingHref = appPageHref("appsSetup", app.id);
          return (
            <section key={app.id} className="organization-card app-setup-card">
              <div className="service-card-head">
                <h2>{appName(app.id)}</h2>
                <span className={`app-status-pill ${state === "running" ? "is-ready" : state === "unset" ? "is-off" : "is-needsSetup"}`}>
                  {t(`control:services.state.${state}`)}
                </span>
              </div>
              <Facts rows={rows} />
              <div className="organization-actions">
                {app.configured && (
                  <Button variant="secondary" compact disabled={testing === app.id} onClick={() => void test(app.id)}>
                    {testing === app.id ? t("control:services.testing") : t("control:services.test")}
                  </Button>
                )}
                <Link href={pairingHref}>{state === "unset" ? t("control:services.pair") : t("control:services.pairing")}</Link>
                {app.configured && <Link href={logsHref({ app: app.id })}>{t("control:services.logs")}</Link>}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
