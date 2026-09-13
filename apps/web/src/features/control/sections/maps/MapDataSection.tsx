import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Database } from "lucide-react";
import { api } from "../../../../api";
import { Button } from "../../../../shared/Button";
import { ConfirmDialog } from "../../../../shared/ConfirmDialog";
import { MessageBox } from "../../../../shared/MessageBox";
import { formatBytes, formatManagedDate } from "../../../../shared/utils";
import { ControlSectionHead } from "../../ControlSectionHead";
import { GeoipDatabaseModal } from "./GeoipDatabaseModal";
import { loadMapSettings, placesProgressText, startPlacesBuild, useFollowPlacesBuild, type MapSettingsDto } from "./map-settings";

// Maps › Data — the databases maps draw on: the named places built from GeoNames
// (phase 2), and the sign-in location databases, which used to be installed from
// the Dashboard's Locations view. Setup turns them on and off; this is where one
// is looked at, updated or removed on its own.

type DatabaseRow = MapSettingsDto["locations"]["databases"][number];

export function MapDataSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [status, setStatus] = useState<MapSettingsDto | null>(null);
  const [loadError, setLoadError] = useState("");
  const [installOpen, setInstallOpen] = useState(false);
  const [pending, setPending] = useState<DatabaseRow | "places" | null>(null);
  const [placesError, setPlacesError] = useState("");
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [freed, setFreed] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      setStatus(await loadMapSettings());
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("controlAdmin:mapData.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useFollowPlacesBuild(status, reload);

  const updatePlaces = async () => {
    setPlacesError("");
    setFreed(null);
    try {
      await startPlacesBuild();
      await reload();
    } catch (err) {
      setPlacesError(err instanceof Error ? err.message : t("controlAdmin:mapSetup.saveFailed"));
    }
  };

  const remove = async () => {
    if (!pending) return;
    setBusy(true);
    setRemoveError("");
    try {
      const result = await api<{ freedBytes: number }>(
        pending === "places" ? "/api/map/places" : `/api/dashboard/locations/database/${encodeURIComponent(pending.name)}`,
        { method: "DELETE" }
      );
      setFreed(result.freedBytes);
      setPending(null);
      await reload();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : t("controlAdmin:mapSetup.removeFailed"));
    } finally {
      setBusy(false);
    }
  };

  const databases = status?.locations.databases ?? [];

  return (
    <>
      <ControlSectionHead
        section="mapData"
        icon={<Database size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:mapData.headDescription")}
      >
        <Button variant="primary" disabled={!status} onClick={() => { setFreed(null); setInstallOpen(true); }}>
          {t("controlAdmin:mapData.add")}
        </Button>
      </ControlSectionHead>

      {loadError && <MessageBox tone="error" title={t("controlAdmin:mapData.loadFailed")}>{loadError}</MessageBox>}
      {freed !== null && freed > 0 && (
        <MessageBox tone="success" title={t("controlAdmin:mapSetup.freedTitle")}>{t("controlAdmin:mapSetup.freed", { size: formatBytes(freed) })}</MessageBox>
      )}

      {status && (
        <section className="config-block map-data-block">
          <h2>{t("controlAdmin:mapData.placesTitle")}</h2>
          <p className="section-description">{t("controlAdmin:mapData.placesIntro")}</p>
          <p className="datagrid-muted storage-path-cell">{t("controlAdmin:mapData.folder", { path: status.cache.folder })}</p>
          {placesError && <MessageBox tone="error" title={t("controlAdmin:mapSetup.saveFailed")}>{placesError}</MessageBox>}
          {status.places.build.running ? (
            <p className="status-empty">{t("controlAdmin:mapSetup.placesBuilding", { progress: placesProgressText(t, status.places.build) })}</p>
          ) : !status.places.present ? (
            <p className="status-empty">
              {status.places.build.error
                ? t("controlAdmin:mapSetup.placesFailed", { error: status.places.build.error })
                : t("controlAdmin:mapData.placesEmpty")}
            </p>
          ) : (
            <div className="datagrid-wrap">
              <table className="datagrid map-databases">
                <thead>
                  <tr>
                    <th>{t("controlAdmin:mapData.thName")}</th>
                    <th>{t("controlAdmin:mapData.thKind")}</th>
                    <th>{t("controlAdmin:mapData.thBuilt")}</th>
                    <th className="col-num">{t("controlAdmin:mapData.thSize")}</th>
                    <th className="col-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <strong>{t("controlAdmin:mapData.placesRowName")}</strong>
                      <small className="datagrid-muted">
                        {t("controlAdmin:mapData.placesRowDetail", {
                          places: status.places.places.toLocaleString(),
                          date: formatManagedDate(status.places.sourceDate ?? status.places.builtAt ?? "")
                        })}
                      </small>
                    </td>
                    <td>{t("controlAdmin:mapData.kindPlaces")}</td>
                    <td>{formatManagedDate(status.places.builtAt ?? "")}</td>
                    <td className="col-num">{formatBytes(status.places.sizeBytes)}</td>
                    <td className="col-actions">
                      <Button variant="secondary" compact onClick={() => void updatePlaces()}>
                        {t("controlAdmin:mapData.update")}
                      </Button>
                      <Button variant="secondary" compact onClick={() => { setRemoveError(""); setPending("places"); }}>
                        {t("controlAdmin:mapSetup.remove")}
                      </Button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {status && (
        <section className="config-block map-data-block">
          <h2>{t("controlAdmin:mapData.locationsTitle")}</h2>
          <p className="section-description">{t("controlAdmin:mapData.locationsIntro")}</p>
          <p className="datagrid-muted storage-path-cell">{t("controlAdmin:mapData.folder", { path: status.locations.directory })}</p>
          {databases.length === 0 ? (
            <p className="status-empty">{t("controlAdmin:mapData.empty")}</p>
          ) : (
            <div className="datagrid-wrap">
              <table className="datagrid map-databases">
                <thead>
                  <tr>
                    <th>{t("controlAdmin:mapData.thName")}</th>
                    <th>{t("controlAdmin:mapData.thKind")}</th>
                    <th>{t("controlAdmin:mapData.thBuilt")}</th>
                    <th className="col-num">{t("controlAdmin:mapData.thSize")}</th>
                    <th className="col-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {databases.map((database, index) => (
                    <tr key={database.name}>
                      <td>
                        <strong>{database.name}</strong>
                        {/* The scan puts the database in use first: city before country, newest first. */}
                        {index === 0 && <span className="count-badge">{t("controlAdmin:mapData.inUse")}</span>}
                        <small className="datagrid-muted">{database.databaseType}</small>
                      </td>
                      <td>{database.tier === "city" ? t("controlAdmin:mapData.kindCity") : t("controlAdmin:mapData.kindCountry")}</td>
                      <td>{formatManagedDate(database.buildDate ?? database.updatedAt)}</td>
                      <td className="col-num">{formatBytes(database.sizeBytes)}</td>
                      <td className="col-actions">
                        <Button variant="secondary" compact onClick={() => { setRemoveError(""); setPending(database); }}>
                          {t("controlAdmin:mapSetup.remove")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {installOpen && status && (
        <GeoipDatabaseModal geoip={status.locations} onClose={() => setInstallOpen(false)} onChanged={reload} />
      )}

      {pending === "places" && status && (
        <ConfirmDialog
          title={t("controlAdmin:mapSetup.confirmRemovePlacesTitle")}
          confirmLabel={t("controlAdmin:mapSetup.confirmRemovePlacesLabel")}
          busyLabel={t("controlAdmin:mapSetup.removing")}
          danger
          busy={busy}
          error={removeError}
          onConfirm={() => void remove()}
          onCancel={() => setPending(null)}
        >
          {t("controlAdmin:mapSetup.confirmRemovePlacesBody", { size: formatBytes(status.places.sizeBytes) })}
        </ConfirmDialog>
      )}

      {pending && pending !== "places" && (
        <ConfirmDialog
          title={t("controlAdmin:mapSetup.confirmRemoveTitle", { name: pending.name })}
          confirmLabel={t("controlAdmin:mapSetup.confirmRemoveLabel")}
          busyLabel={t("controlAdmin:mapSetup.removing")}
          danger
          busy={busy}
          error={removeError}
          onConfirm={() => void remove()}
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
