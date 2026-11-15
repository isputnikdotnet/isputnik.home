import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Server } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { ControlSectionHead } from "../ControlSectionHead";
import { useAppsStatus } from "./AppsSection";
import { useSystemStatus } from "./dashboard/useSystemStatus";
import { ServicesDiagram } from "./dashboard/Overview";
import type { DashboardOverview } from "./dashboard/useDashboardOverview";

// Infrastructure › Services (control panel v2): how this server and each
// container beside it are connected — whether each is up, how fast it answers,
// what uses it — as one diagram, each box with its links (events, log,
// Diagnostics, access, Pairing, backups). Pairing (appsSetup) is a page under
// this one. The cards that repeated each box below it are gone (4.90); Test
// connections asks every container again.

export function ServicesSection() {
  const { t } = useTranslation(["common", "control"]);
  const { status } = useSystemStatus();
  const { apps, error, load } = useAppsStatus();
  const [testing, setTesting] = useState(false);
  // Home's own addresses and port, for the diagram (the Dashboard reads the same).
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  useEffect(() => {
    api<DashboardOverview>("/api/dashboard/overview").then(setOverview).catch(() => setOverview(null));
  }, []);

  const test = async () => {
    setTesting(true);
    try {
      await load();
    } catch {
      // The diagram says what came back, or that nothing did.
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <ControlSectionHead section="services" icon={<Server size={30} />} description={t("control:services.description")}>
        <Button variant="secondary" disabled={testing} onClick={() => void test()}>
          {testing ? t("control:services.testingAll") : t("control:services.testAll")}
        </Button>
      </ControlSectionHead>
      {error && <MessageBox tone="error" title={t("control:services.loadFailed")}>{error}</MessageBox>}
      {status && <ServicesDiagram status={status} overview={overview} apps={apps} onServicesPage />}
    </>
  );
}
