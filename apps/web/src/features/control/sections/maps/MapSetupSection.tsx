import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Map as MapIcon } from "lucide-react";
import { api } from "../../../../api";
import { controlHref, navigate } from "../../../../router";
import { Button } from "../../../../shared/Button";
import { ConfirmDialog } from "../../../../shared/ConfirmDialog";
import { MessageBox } from "../../../../shared/MessageBox";
import { forgetMapConfig } from "../../../../shared/map/map-style";
import { formatBytes, formatManagedDate } from "../../../../shared/utils";
import { ControlSectionHead } from "../../ControlSectionHead";
import { MapSetupWizard } from "./MapSetupWizard";
import {
  cityDatabase,
  countryDatabase,
  loadMapSettings,
  placesProgressText,
  useFollowPlacesBuild,
  type MapSettingsDto
} from "./map-settings";

// Maps › Setup — what this server keeps for maps, one row per level
// (docs/map-approach-proposal.md, "Optional, and off by default").
//
// Nothing is on until someone turns it on, and every level says what it costs
// on disk while it is on. Turning one on goes through the wizard; turning one off
// deletes what it kept, so it is confirmed first and says how much it freed.

type Pending =
  | { kind: "cacheOff" }
  | { kind: "remove"; name: string; tier: "city" | "country" }
  | { kind: "removePlaces" };

export function MapSetupSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [status, setStatus] = useState<MapSettingsDto | null>(null);
  const [loadError, setLoadError] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [freed, setFreed] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      setStatus(await loadMapSettings());
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("controlAdmin:mapSetup.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useFollowPlacesBuild(status, reload);

  const applyPending = async () => {
    if (!pending) return;
    setBusy(true);
    setActionError("");
    try {
      if (pending.kind === "cacheOff") {
        const result = await api<{ freedBytes: number }>("/api/map/settings", { method: "PUT", body: JSON.stringify({ cache: false }) });
        forgetMapConfig();
        setFreed(result.freedBytes);
      } else if (pending.kind === "removePlaces") {
        const result = await api<{ freedBytes: number }>("/api/map/places", { method: "DELETE" });
        setFreed(result.freedBytes);
      } else {
        const result = await api<{ freedBytes: number }>(`/api/dashboard/locations/database/${encodeURIComponent(pending.name)}`, { method: "DELETE" });
        setFreed(result.freedBytes);
      }
      setPending(null);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t(pending.kind === "cacheOff" ? "controlAdmin:mapSetup.saveFailed" : "controlAdmin:mapSetup.removeFailed"));
    } finally {
      setBusy(false);
    }
  };

  const country = status ? countryDatabase(status.locations) : null;
  const city = status ? cityDatabase(status.locations) : null;

  return (
    <>
      <ControlSectionHead
        section="mapSetup"
        icon={<MapIcon size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:mapSetup.headDescription")}
      >
        <Button variant="primary" disabled={!status} onClick={() => { setFreed(null); setWizardOpen(true); }}>
          {t("controlAdmin:mapSetup.setUp")}
        </Button>
      </ControlSectionHead>

      {loadError && <MessageBox tone="error" title={t("controlAdmin:mapSetup.loadFailed")}>{loadError}</MessageBox>}
      {freed !== null && freed > 0 && (
        <MessageBox tone="success" title={t("controlAdmin:mapSetup.freedTitle")}>{t("controlAdmin:mapSetup.freed", { size: formatBytes(freed) })}</MessageBox>
      )}

      {status && (
        <section className="config-block">
          <h2>{t("controlAdmin:mapSetup.levelsTitle")}</h2>
          <p className="section-description">{t("controlAdmin:mapSetup.levelsIntro")}</p>
          <div className="datagrid-wrap">
            <table className="datagrid map-levels">
              <thead>
                <tr>
                  <th>{t("controlAdmin:mapSetup.thLevel")}</th>
                  <th>{t("controlAdmin:mapSetup.thNow")}</th>
                  <th className="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>{t("controlAdmin:mapSetup.cacheName")}</strong>
                    <small className="datagrid-muted">{t("controlAdmin:mapSetup.cacheHint")}</small>
                  </td>
                  <td className="storage-path-cell">
                    {!status.settings.cache
                      ? t("controlAdmin:mapSetup.cacheOff")
                      : status.cache.bytes > 0
                        ? t("controlAdmin:mapSetup.cacheOn", { size: formatBytes(status.cache.bytes), path: status.cache.folder })
                        : t("controlAdmin:mapSetup.cacheOnEmpty", { path: status.cache.folder })}
                  </td>
                  <td className="col-actions">
                    {status.settings.cache ? (
                      <Button variant="secondary" compact onClick={() => { setActionError(""); setPending({ kind: "cacheOff" }); }}>
                        {t("controlAdmin:mapSetup.turnOff")}
                      </Button>
                    ) : (
                      <Button variant="secondary" compact onClick={() => { setFreed(null); setWizardOpen(true); }}>
                        {t("controlAdmin:mapSetup.turnOn")}
                      </Button>
                    )}
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>{t("controlAdmin:mapSetup.placesName")}</strong>
                    <small className="datagrid-muted">{t("controlAdmin:mapSetup.placesHint")}</small>
                  </td>
                  <td>
                    {status.places.build.running
                      ? t("controlAdmin:mapSetup.placesBuilding", { progress: placesProgressText(t, status.places.build) })
                      : status.places.present
                        ? t("controlAdmin:mapSetup.placesOn", {
                            places: status.places.places.toLocaleString(),
                            size: formatBytes(status.places.sizeBytes),
                            date: formatManagedDate(status.places.builtAt ?? "")
                          })
                        : status.places.build.error
                          ? t("controlAdmin:mapSetup.placesFailed", { error: status.places.build.error })
                          : t("controlAdmin:mapSetup.off")}
                  </td>
                  <td className="col-actions">
                    {status.places.build.running ? null : status.places.present ? (
                      <Button variant="secondary" compact onClick={() => { setActionError(""); setPending({ kind: "removePlaces" }); }}>
                        {t("controlAdmin:mapSetup.remove")}
                      </Button>
                    ) : (
                      <Button variant="secondary" compact onClick={() => { setFreed(null); setWizardOpen(true); }}>
                        {t("controlAdmin:mapSetup.turnOn")}
                      </Button>
                    )}
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>{t("controlAdmin:mapSetup.countriesName")}</strong>
                    <small className="datagrid-muted">{t("controlAdmin:mapSetup.countriesHint")}</small>
                  </td>
                  <td>
                    {country
                      ? t("controlAdmin:mapSetup.countriesOn", {
                          size: formatBytes(country.sizeBytes),
                          date: formatManagedDate(country.buildDate ?? country.updatedAt)
                        })
                      : t("controlAdmin:mapSetup.off")}
                  </td>
                  <td className="col-actions">
                    {country ? (
                      <Button variant="secondary" compact onClick={() => { setActionError(""); setPending({ kind: "remove", name: country.name, tier: "country" }); }}>
                        {t("controlAdmin:mapSetup.remove")}
                      </Button>
                    ) : (
                      <Button variant="secondary" compact onClick={() => { setFreed(null); setWizardOpen(true); }}>
                        {t("controlAdmin:mapSetup.turnOn")}
                      </Button>
                    )}
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>{t("controlAdmin:mapSetup.townsName")}</strong>
                    <small className="datagrid-muted">{t("controlAdmin:mapSetup.townsHint")}</small>
                  </td>
                  <td>
                    {city
                      ? t("controlAdmin:mapSetup.townsOn", { name: city.name, size: formatBytes(city.sizeBytes) })
                      : t("controlAdmin:mapSetup.off")}
                  </td>
                  <td className="col-actions">
                    {city ? (
                      <Button variant="secondary" compact onClick={() => { setActionError(""); setPending({ kind: "remove", name: city.name, tier: "city" }); }}>
                        {t("controlAdmin:mapSetup.remove")}
                      </Button>
                    ) : (
                      <Button variant="secondary" compact onClick={() => navigate(controlHref("mapData"))}>
                        {t("controlAdmin:mapSetup.addDatabase")}
                      </Button>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {wizardOpen && status && (
        <MapSetupWizard status={status} onClose={() => setWizardOpen(false)} onFinished={() => void reload()} />
      )}

      {pending?.kind === "cacheOff" && status && (
        <ConfirmDialog
          title={t("controlAdmin:mapSetup.confirmCacheOffTitle")}
          confirmLabel={t("controlAdmin:mapSetup.confirmCacheOffLabel")}
          busyLabel={t("controlAdmin:mapSetup.turningOff")}
          danger
          busy={busy}
          error={actionError}
          onConfirm={() => void applyPending()}
          onCancel={() => setPending(null)}
        >
          {status.cache.bytes > 0
            ? t("controlAdmin:mapSetup.confirmCacheOffBody", { size: formatBytes(status.cache.bytes) })
            : t("controlAdmin:mapSetup.confirmCacheOffBodyEmpty")}
        </ConfirmDialog>
      )}

      {pending?.kind === "removePlaces" && status && (
        <ConfirmDialog
          title={t("controlAdmin:mapSetup.confirmRemovePlacesTitle")}
          confirmLabel={t("controlAdmin:mapSetup.confirmRemovePlacesLabel")}
          busyLabel={t("controlAdmin:mapSetup.removing")}
          danger
          busy={busy}
          error={actionError}
          onConfirm={() => void applyPending()}
          onCancel={() => setPending(null)}
        >
          {t("controlAdmin:mapSetup.confirmRemovePlacesBody", { size: formatBytes(status.places.sizeBytes) })}
        </ConfirmDialog>
      )}

      {pending?.kind === "remove" && (
        <ConfirmDialog
          title={t("controlAdmin:mapSetup.confirmRemoveTitle", { name: pending.name })}
          confirmLabel={t("controlAdmin:mapSetup.confirmRemoveLabel")}
          busyLabel={t("controlAdmin:mapSetup.removing")}
          danger
          busy={busy}
          error={actionError}
          onConfirm={() => void applyPending()}
          onCancel={() => setPending(null)}
        >
          {pending.tier === "city"
            ? t("controlAdmin:mapSetup.confirmRemoveCityBody")
            : t("controlAdmin:mapSetup.confirmRemoveCountryBody")}
        </ConfirmDialog>
      )}
    </>
  );
}
