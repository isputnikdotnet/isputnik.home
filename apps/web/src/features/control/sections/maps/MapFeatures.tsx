import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, ExternalLink, Folder, Link as LinkIcon, Map as MapIcon, MapPin, Route, ShieldCheck, Upload } from "lucide-react";
import { api } from "../../../../api";
import { controlHref, navigate } from "../../../../router";
import { Button } from "../../../../shared/Button";
import { ConfirmDialog } from "../../../../shared/ConfirmDialog";
import { Field } from "../../../../shared/Field";
import { InfoHint } from "../../../../shared/InfoHint";
import { MessageBox } from "../../../../shared/MessageBox";
import { Modal } from "../../../../shared/Modal";
import { SelectField } from "../../../../shared/SelectField";
import { forgetMapConfig } from "../../../../shared/map/map-style";
import { formatBytes, formatManagedDate } from "../../../../shared/utils";
import { MapFeatureCard, MapFeaturePart } from "./MapFeatureCard";
import {
  CACHE_LIMITS_MB,
  cityDatabase,
  countryDatabase,
  limitLabel,
  loadMapSettings,
  placesProgressText,
  startPlacesBuild,
  useFollowPlacesBuild,
  type CacheLimitMb,
  type MapSettingsDto,
  type RoutingDto
} from "./map-settings";
// The cards' stylesheet: it loads with them, on the Maps page and in the setup guide (docs/css-map.md).
import "../../../../styles/map-features.css";

// The Maps page (docs/map-approach-proposal.md, "One Maps page of four cards"): four
// features, each a card with a switch. Turning one on says what will be downloaded,
// how big it is and where it goes, and then does it; turning one off says what it
// frees. The same cards are the setup guide's Maps step.

const LINKS = {
  openFreeMap: "https://openfreemap.org/",
  geoNames: "https://www.geonames.org/",
  dbipCountry: "https://db-ip.com/db/download/ip-to-country-lite",
  dbipCity: "https://db-ip.com/db/download/ip-to-city-lite",
  maxmind: "https://dev.maxmind.com/geoip/geolite2-free-geolocation-data",
  openRouteService: "https://openrouteservice.org/dev/#/signup"
};

type Pending =
  | { kind: "offlineOn" }
  | { kind: "offlineOff" }
  | { kind: "placesOn" }
  | { kind: "placesOff" }
  | { kind: "signInsOn" }
  | { kind: "signInsOff" }
  | { kind: "townsRemove"; name: string }
  | { kind: "routesOff" };

function SourceLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="map-feature-link" href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
}

export function MapFeatures() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [status, setStatus] = useState<MapSettingsDto | null>(null);
  const [routing, setRouting] = useState<RoutingDto["routing"] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [freed, setFreed] = useState<number | null>(null);
  const [notice, setNotice] = useState("");

  const reload = useCallback(async () => {
    try {
      const [maps, routes] = await Promise.all([loadMapSettings(), api<RoutingDto>("/api/config/routing")]);
      setStatus(maps);
      setRouting(routes.routing);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("controlAdmin:mapFeatures.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useFollowPlacesBuild(status, reload);

  /** One action at a time, its failure shown where it was asked for. */
  const act = async (key: string, run: () => Promise<number | void>, failure: string): Promise<boolean> => {
    setBusy(key);
    setActionError("");
    setNotice("");
    setFreed(null);
    try {
      const freedBytes = await run();
      if (typeof freedBytes === "number" && freedBytes > 0) setFreed(freedBytes);
      await reload();
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : failure);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveFailed = t("controlAdmin:mapFeatures.saveFailed");

  const confirmPending = async () => {
    if (!pending || !status) return;
    let ok = false;
    switch (pending.kind) {
      case "offlineOn":
        ok = await act("offline", async () => {
          await api("/api/map/settings", { method: "PUT", body: JSON.stringify({ cache: true }) });
          forgetMapConfig();
        }, saveFailed);
        break;
      case "offlineOff":
        ok = await act("offline", async () => {
          const result = await api<{ freedBytes: number }>("/api/map/settings", { method: "PUT", body: JSON.stringify({ cache: false }) });
          forgetMapConfig();
          return result.freedBytes;
        }, saveFailed);
        break;
      case "placesOn":
        ok = await act("places", async () => { await startPlacesBuild(); }, saveFailed);
        break;
      case "placesOff":
        ok = await act("places", async () => {
          const result = await api<{ freedBytes: number }>("/api/map/places", { method: "DELETE" });
          return result.freedBytes;
        }, saveFailed);
        break;
      case "signInsOn":
        ok = await act("countries", async () => { await api("/api/dashboard/locations/database", { method: "POST" }); }, saveFailed);
        break;
      case "signInsOff":
        ok = await act("countries", async () => {
          let total = 0;
          for (const database of status.locations.databases) {
            const result = await api<{ freedBytes: number }>(`/api/dashboard/locations/database/${encodeURIComponent(database.name)}`, { method: "DELETE" });
            total += result.freedBytes;
          }
          return total;
        }, saveFailed);
        break;
      case "townsRemove":
        ok = await act("towns", async () => {
          const result = await api<{ freedBytes: number }>(`/api/dashboard/locations/database/${encodeURIComponent(pending.name)}`, { method: "DELETE" });
          return result.freedBytes;
        }, saveFailed);
        break;
      case "routesOff":
        ok = await act("routes", async () => {
          await api("/api/config/routing", { method: "PUT", body: JSON.stringify({ endpoint: routing?.endpoint ?? "", clearApiKey: true }) });
          setRoutesOpen(false);
          setTestResult(null);
        }, saveFailed);
        break;
    }
    if (ok) setPending(null);
  };

  // ── Offline maps ──
  const setLimit = (mb: CacheLimitMb) => void act("limit", async () => {
    const result = await api<{ freedBytes: number }>("/api/map/settings", { method: "PUT", body: JSON.stringify({ cacheLimitMb: mb }) });
    return result.freedBytes;
  }, saveFailed);

  // ── Sign-in locations: towns ──
  const fileRef = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState("");
  const installed = (result: { installed?: { name: string } }) => {
    if (result.installed) setNotice(t("controlAdmin:mapFeatures.townsAdded", { name: result.installed.name }));
  };
  const uploadTowns = (file: File) => {
    const form = new FormData();
    form.append("file", file);
    void act("towns", async () => {
      installed(await api<{ installed?: { name: string } }>("/api/dashboard/locations/database/upload", { method: "POST", body: form }));
    }, t("controlAdmin:mapFeatures.townsAddFailed")).finally(() => {
      if (fileRef.current) fileRef.current.value = "";
    });
  };
  const addTownsFromLink = async (event: FormEvent) => {
    event.preventDefault();
    if (!link.trim()) return;
    setBusy("towns");
    setLinkError("");
    try {
      installed(await api<{ installed?: { name: string } }>("/api/dashboard/locations/database/url", { method: "POST", body: JSON.stringify({ url: link.trim() }) }));
      setLink("");
      setLinkOpen(false);
      await reload();
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : t("controlAdmin:mapFeatures.townsAddFailed"));
    } finally {
      setBusy(null);
    }
  };

  // ── Road routes ──
  const [routesOpen, setRoutesOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [endpoint, setEndpoint] = useState<string | null>(null);
  // Open by itself when a server of your own is already set: it is then part of
  // what the card is, not a detail to go looking for.
  const [ownServerChoice, setOwnServerOpen] = useState<boolean | null>(null);
  const [testResult, setTestResult] = useState<{ ok: true } | { ok: false; error: string } | null>(null);
  const routesOn = Boolean(routing?.hasApiKey);
  const endpointValue = endpoint ?? routing?.endpoint ?? "";
  const routesDirty = apiKey.trim() !== "" || endpointValue !== (routing?.endpoint ?? "");
  const ownServerOpen = ownServerChoice ?? Boolean(routing?.endpoint);

  /** Test saves first when something was typed: one button, one answer. */
  const saveAndTest = async () => {
    setBusy("routes");
    setActionError("");
    setTestResult(null);
    try {
      if (routesDirty) {
        const saved = await api<RoutingDto>("/api/config/routing", {
          method: "PUT",
          body: JSON.stringify({ endpoint: endpointValue, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
        });
        setRouting(saved.routing);
        setApiKey("");
        setEndpoint(null);
      }
      try {
        await api("/api/config/routing/test", { method: "POST" });
        setTestResult({ ok: true });
      } catch (err) {
        setTestResult({ ok: false, error: err instanceof Error ? err.message : t("controlAdmin:mapFeatures.routesNotWorking") });
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : saveFailed);
    } finally {
      setBusy(null);
    }
  };

  if (loadError) return <MessageBox tone="error" title={t("controlAdmin:mapFeatures.loadFailed")}>{loadError}</MessageBox>;
  if (!status || !routing) return <p className="muted">{t("controlAdmin:ui.loading")}</p>;

  const { settings, cache, locations, places } = status;
  const country = countryDatabase(locations);
  const city = cityDatabase(locations);
  const signInsOn = locations.databases.length > 0;
  const locationsBytes = locations.databases.reduce((sum, database) => sum + database.sizeBytes, 0);
  const folder = cache.folder;

  return (
    <div className="map-features">
      {freed !== null && (
        <MessageBox tone="success" title={t("controlAdmin:mapFeatures.freedTitle")}>{t("controlAdmin:mapFeatures.freed", { size: formatBytes(freed) })}</MessageBox>
      )}
      {notice && <MessageBox tone="success" title={t("controlAdmin:mapFeatures.addedTitle")}>{notice}</MessageBox>}
      {actionError && !pending && <MessageBox tone="error" title={saveFailed}>{actionError}</MessageBox>}

      <MapFeatureCard
        icon={<MapIcon size={22} />}
        title={t("controlAdmin:mapFeatures.offlineTitle")}
        description={t("controlAdmin:mapFeatures.offlineDescription")}
        infoLabel={t("controlAdmin:mapFeatures.aboutSource", { name: "OpenFreeMap" })}
        info={<>
          <p>{t("controlAdmin:mapFeatures.offlineInfo")}</p>
          <SourceLink href={LINKS.openFreeMap}>openfreemap.org</SourceLink>
        </>}
        checked={settings.cache}
        disabled={busy !== null}
        onToggle={(next) => { setActionError(""); setPending({ kind: next ? "offlineOn" : "offlineOff" }); }}
        facts={[
          { label: t("controlAdmin:mapFeatures.source"), value: "OpenFreeMap" },
          { label: t("controlAdmin:mapFeatures.arrives"), value: t("controlAdmin:mapFeatures.offlineArrives") },
          {
            label: t("controlAdmin:mapFeatures.space"),
            value: settings.cache
              ? t("controlAdmin:mapFeatures.usedOf", { used: formatBytes(cache.bytes), limit: limitLabel(settings.cacheLimitMb) })
              : t("controlAdmin:mapFeatures.upTo", { limit: limitLabel(settings.cacheLimitMb) })
          }
        ]}
      >
        <div className="map-feature-row">
          <SelectField
            label={t("controlAdmin:mapFeatures.limitLabel")}
            value={String(settings.cacheLimitMb) as `${CacheLimitMb}`}
            options={CACHE_LIMITS_MB.map((mb) => ({ value: String(mb) as `${CacheLimitMb}`, label: limitLabel(mb) }))}
            onChange={(value) => setLimit(Number(value) as CacheLimitMb)}
            disabled={busy !== null}
            compact
          />
        </div>
      </MapFeatureCard>

      <MapFeatureCard
        icon={<MapPin size={22} />}
        title={t("controlAdmin:mapFeatures.placesTitle")}
        description={t("controlAdmin:mapFeatures.placesDescription")}
        infoLabel={t("controlAdmin:mapFeatures.aboutSource", { name: "GeoNames" })}
        info={<>
          <p>{t("controlAdmin:mapFeatures.placesInfo")}</p>
          <SourceLink href={LINKS.geoNames}>geonames.org</SourceLink>
        </>}
        checked={places.present || places.build.running}
        disabled={busy !== null || places.build.running}
        onToggle={(next) => { setActionError(""); setPending({ kind: next ? "placesOn" : "placesOff" }); }}
        facts={[
          { label: t("controlAdmin:mapFeatures.source"), value: "GeoNames" },
          { label: t("controlAdmin:mapFeatures.arrives"), value: t("controlAdmin:mapFeatures.placesArrives") },
          { label: t("controlAdmin:mapFeatures.space"), value: places.present ? formatBytes(places.sizeBytes) : t("controlAdmin:mapFeatures.placesSpace") }
        ]}
      >
        {(places.present || places.build.running || places.build.error) && (
          <div className="map-feature-row">
            {places.build.running ? (
              <span className="map-feature-status">{t("controlAdmin:mapFeatures.placesBuilding", { progress: placesProgressText(t, places.build) })}</span>
            ) : places.present ? (
              <>
                <span className="map-feature-status is-ok">{t("controlAdmin:mapFeatures.placesBuilt", { count: places.places, number: places.places.toLocaleString(), date: formatManagedDate(places.builtAt ?? "") })}</span>
                <Button variant="secondary" compact disabled={busy !== null} onClick={() => void act("places", async () => { await startPlacesBuild(); }, saveFailed)}>
                  {t("controlAdmin:mapFeatures.update")}
                </Button>
              </>
            ) : (
              <span className="map-feature-status is-failed">{t("controlAdmin:mapFeatures.placesFailed", { error: places.build.error })}</span>
            )}
          </div>
        )}
      </MapFeatureCard>

      <MapFeatureCard
        icon={<ShieldCheck size={22} />}
        title={t("controlAdmin:mapFeatures.signInsTitle")}
        description={t("controlAdmin:mapFeatures.signInsDescription")}
        infoLabel={t("controlAdmin:mapFeatures.aboutSource", { name: "DB-IP" })}
        info={<p>{t("controlAdmin:mapFeatures.signInsInfo")}</p>}
        checked={signInsOn}
        disabled={busy !== null}
        onToggle={(next) => { setActionError(""); setPending({ kind: next ? "signInsOn" : "signInsOff" }); }}
        facts={[
          { label: t("controlAdmin:mapFeatures.source"), value: city ? t("controlAdmin:mapFeatures.signInsSourceWithTowns") : "DB-IP" },
          { label: t("controlAdmin:mapFeatures.arrives"), value: t("controlAdmin:mapFeatures.signInsArrives") },
          { label: t("controlAdmin:mapFeatures.space"), value: signInsOn ? formatBytes(locationsBytes) : t("controlAdmin:mapFeatures.signInsSpace") }
        ]}
      >
        <MapFeaturePart
          title={t("controlAdmin:mapFeatures.countries")}
          detail={t("controlAdmin:mapFeatures.countriesDetail")}
          info={
            <InfoHint label={t("controlAdmin:mapFeatures.aboutSource", { name: "DB-IP Country Lite" })}>
              <p>{t("controlAdmin:mapFeatures.countriesInfo")}</p>
              <SourceLink href={LINKS.dbipCountry}>DB-IP Country Lite</SourceLink>
            </InfoHint>
          }
          state={country
            ? <span className="map-feature-status is-ok">{t("controlAdmin:mapFeatures.installed", { size: formatBytes(country.sizeBytes), date: formatManagedDate(country.buildDate ?? country.updatedAt) })}</span>
            : <span className="map-feature-status">{t("controlAdmin:mapFeatures.notInstalled")}</span>}
        >
          <Button
            variant="secondary"
            compact
            disabled={busy !== null}
            onClick={() => void act("countries", async () => { await api("/api/dashboard/locations/database", { method: "POST" }); }, saveFailed)}
          >
            {busy === "countries" ? t("controlAdmin:mapFeatures.downloading") : country ? t("controlAdmin:mapFeatures.update") : t("controlAdmin:mapFeatures.download")}
          </Button>
        </MapFeaturePart>

        <MapFeaturePart
          title={<>{t("controlAdmin:mapFeatures.towns")} <span className="muted">{t("controlAdmin:mapFeatures.optional")}</span></>}
          detail={city ? city.name : t("controlAdmin:mapFeatures.townsDetail")}
          info={
            <InfoHint label={t("controlAdmin:mapFeatures.whereToGetTowns")}>
              <p>{t("controlAdmin:mapFeatures.townsInfo")}</p>
              <ul className="map-feature-sources">
                <li>
                  <SourceLink href={LINKS.dbipCity}>DB-IP City Lite</SourceLink>
                  <small>{t("controlAdmin:mapFeatures.dbipCityDetail")}</small>
                </li>
                <li>
                  <SourceLink href={LINKS.maxmind}>MaxMind GeoLite2 City</SourceLink>
                  <small>{t("controlAdmin:mapFeatures.maxmindDetail")}</small>
                </li>
              </ul>
            </InfoHint>
          }
          state={city
            ? <span className="map-feature-status is-ok">{t("controlAdmin:mapFeatures.installed", { size: formatBytes(city.sizeBytes), date: formatManagedDate(city.buildDate ?? city.updatedAt) })}</span>
            : <span className="map-feature-status">{t("controlAdmin:mapFeatures.notAdded")}</span>}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".mmdb,.gz"
            hidden
            onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadTowns(file); }}
          />
          <Button variant="secondary" compact disabled={busy !== null} onClick={() => fileRef.current?.click()}>
            <Upload size={14} aria-hidden="true" />
            {busy === "towns" && !linkOpen ? t("controlAdmin:mapFeatures.uploading") : t("controlAdmin:mapFeatures.upload")}
          </Button>
          <Button variant="secondary" compact disabled={busy !== null} onClick={() => { setLinkError(""); setLinkOpen(true); }}>
            <LinkIcon size={14} aria-hidden="true" />
            {t("controlAdmin:mapFeatures.link")}
          </Button>
          {city && (
            <Button variant="text" compact disabled={busy !== null} onClick={() => { setActionError(""); setPending({ kind: "townsRemove", name: city.name }); }}>
              {t("controlAdmin:mapFeatures.remove")}
            </Button>
          )}
        </MapFeaturePart>
      </MapFeatureCard>

      <MapFeatureCard
        icon={<Route size={22} />}
        title={t("controlAdmin:mapFeatures.routesTitle")}
        description={t("controlAdmin:mapFeatures.routesDescription")}
        infoLabel={t("controlAdmin:mapFeatures.aboutSource", { name: "OpenRouteService" })}
        info={<>
          <p>{t("controlAdmin:mapFeatures.routesInfo")}</p>
          <SourceLink href={LINKS.openRouteService}>{t("controlAdmin:mapFeatures.routesGetKey")}</SourceLink>
        </>}
        checked={routesOn || routesOpen}
        disabled={busy !== null}
        onToggle={(next) => {
          setActionError("");
          if (next) setRoutesOpen(true);
          else if (routesOn) setPending({ kind: "routesOff" });
          else { setRoutesOpen(false); setApiKey(""); }
        }}
        facts={[
          { label: t("controlAdmin:mapFeatures.source"), value: "OpenRouteService" },
          { label: t("controlAdmin:mapFeatures.needs"), value: t("controlAdmin:mapFeatures.routesNeeds") },
          { label: t("controlAdmin:mapFeatures.sent"), value: t("controlAdmin:mapFeatures.routesSent") }
        ]}
      >
        {(routesOn || routesOpen) && (
          <div className="map-feature-routes">
            <div className="map-feature-row">
              <Field
                label={t("controlAdmin:mapFeatures.keyLabel")}
                value={apiKey}
                onChange={(value) => { setApiKey(value); setTestResult(null); }}
                type="password"
                placeholder={routing.hasApiKey ? t("controlAdmin:mapFeatures.keyStored") : t("controlAdmin:mapFeatures.keyEmpty")}
                autoComplete="new-password"
                required={false}
              />
              <Button variant="secondary" disabled={busy !== null || (!routesDirty && !routing.hasApiKey)} onClick={() => void saveAndTest()}>
                {busy === "routes" ? t("controlAdmin:mapFeatures.testing") : routesDirty ? t("controlAdmin:mapFeatures.saveAndTest") : t("controlAdmin:mapFeatures.test")}
              </Button>
              {testResult?.ok && <span className="map-feature-status is-ok">{t("controlAdmin:mapFeatures.works")}</span>}
            </div>
            {testResult && !testResult.ok && (
              <MessageBox tone="error" title={t("controlAdmin:mapFeatures.routesNotWorking")}>{testResult.error}</MessageBox>
            )}
            <Button variant="bare" className="map-feature-disclosure" onClick={() => setOwnServerOpen(!ownServerOpen)} aria-expanded={ownServerOpen}>
              <ChevronRight size={15} className={ownServerOpen ? "rotated" : ""} aria-hidden="true" />
              {t("controlAdmin:mapFeatures.ownServer")}
            </Button>
            {ownServerOpen && (
              <div className="map-feature-own-server">
                <Field
                  label={t("controlAdmin:mapFeatures.endpointLabel")}
                  value={endpointValue}
                  onChange={(value) => { setEndpoint(value); setTestResult(null); }}
                  type="url"
                  placeholder="https://api.openrouteservice.org"
                  autoComplete="off"
                  required={false}
                />
                <small className="muted">{t("controlAdmin:mapFeatures.endpointHint")}</small>
              </div>
            )}
          </div>
        )}
      </MapFeatureCard>

      <p className="map-features-folder">
        <Folder size={15} aria-hidden="true" />
        <span>{t("controlAdmin:mapFeatures.folder", { path: folder })}</span>
        <Button variant="text" compact onClick={() => navigate(controlHref("storage"))}>{t("controlAdmin:mapFeatures.changeFolder")}</Button>
      </p>

      {linkOpen && (
        <Modal variant="card" title={t("controlAdmin:mapFeatures.linkTitle")} busy={busy === "towns"} onClose={() => setLinkOpen(false)}>
          <form onSubmit={(event) => void addTownsFromLink(event)}>
            {linkError && <MessageBox tone="error" title={t("controlAdmin:mapFeatures.townsAddFailed")}>{linkError}</MessageBox>}
            <Field
              label={t("controlAdmin:mapFeatures.linkLabel")}
              value={link}
              onChange={setLink}
              type="url"
              placeholder="https://download.db-ip.com/free/dbip-city-lite-2026-09.mmdb.gz"
            />
            <p className="muted map-feature-hint">{t("controlAdmin:mapFeatures.linkHint")}</p>
            <div className="modal-actions">
              <Button variant="secondary" disabled={busy === "towns"} onClick={() => setLinkOpen(false)}>{t("common.cancel")}</Button>
              <Button variant="primary" type="submit" disabled={busy === "towns" || !link.trim()}>
                {busy === "towns" ? t("controlAdmin:mapFeatures.adding") : t("controlAdmin:mapFeatures.linkSubmit")}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {pending && (
        <ConfirmDialog
          title={confirmText(pending, "Title")}
          confirmLabel={confirmText(pending, "Label")}
          busyLabel={t("controlAdmin:mapFeatures.working")}
          danger={pending.kind.endsWith("Off") || pending.kind === "townsRemove"}
          busy={busy !== null}
          error={actionError}
          onConfirm={() => void confirmPending()}
          onCancel={() => setPending(null)}
        >
          {confirmBody(pending)}
        </ConfirmDialog>
      )}
    </div>
  );

  function confirmText(which: Pending, part: "Title" | "Label"): string {
    const title = part === "Title";
    switch (which.kind) {
      case "offlineOn": return title ? t("controlAdmin:mapFeatures.offlineOnTitle") : t("controlAdmin:mapFeatures.offlineOnLabel");
      case "offlineOff": return title ? t("controlAdmin:mapFeatures.offlineOffTitle") : t("controlAdmin:mapFeatures.offlineOffLabel");
      case "placesOn": return title ? t("controlAdmin:mapFeatures.placesOnTitle") : t("controlAdmin:mapFeatures.placesOnLabel");
      case "placesOff": return title ? t("controlAdmin:mapFeatures.placesOffTitle") : t("controlAdmin:mapFeatures.placesOffLabel");
      case "signInsOn": return title ? t("controlAdmin:mapFeatures.signInsOnTitle") : t("controlAdmin:mapFeatures.signInsOnLabel");
      case "signInsOff": return title ? t("controlAdmin:mapFeatures.signInsOffTitle") : t("controlAdmin:mapFeatures.signInsOffLabel");
      case "townsRemove": return title ? t("controlAdmin:mapFeatures.townsRemoveTitle", { name: which.name }) : t("controlAdmin:mapFeatures.townsRemoveLabel");
      case "routesOff": return title ? t("controlAdmin:mapFeatures.routesOffTitle") : t("controlAdmin:mapFeatures.routesOffLabel");
    }
  }

  function confirmBody(which: Pending): string {
    switch (which.kind) {
      case "offlineOn": return t("controlAdmin:mapFeatures.offlineOnBody", { limit: limitLabel(settings.cacheLimitMb), path: folder });
      case "offlineOff": return cache.bytes > 0
        ? t("controlAdmin:mapFeatures.offlineOffBody", { size: formatBytes(cache.bytes) })
        : t("controlAdmin:mapFeatures.offlineOffBodyEmpty");
      case "placesOn": return t("controlAdmin:mapFeatures.placesOnBody", { path: folder });
      case "placesOff": return t("controlAdmin:mapFeatures.placesOffBody", { size: formatBytes(places.sizeBytes) });
      case "signInsOn": return t("controlAdmin:mapFeatures.signInsOnBody", { path: locations.directory });
      case "signInsOff": return city
        ? t("controlAdmin:mapFeatures.signInsOffBodyTowns", { size: formatBytes(locationsBytes), name: city.name })
        : t("controlAdmin:mapFeatures.signInsOffBody", { size: formatBytes(locationsBytes) });
      case "townsRemove": return t("controlAdmin:mapFeatures.townsRemoveBody");
      case "routesOff": return t("controlAdmin:mapFeatures.routesOffBody");
    }
  }
}

