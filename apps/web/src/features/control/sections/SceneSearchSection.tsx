import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Images, ScanSearch } from "lucide-react";
import { api } from "../../../api";
import { formatNumber } from "../../../shared/dates";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { ActionRow, GroupedList, InfoRow, NavRow, ToggleRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SettingsCard } from "../../../shared/SettingsCard";
import { ControlSectionHead } from "../ControlSectionHead";
import { appPageHref, tasksHref } from "../links";

// Search by what a photo shows (server: modules/library/gallery/scene, the plan
// is docs/scene-search-plan.md). One switch for the whole install; under it, how
// far the photos have been described, library by library. The work itself is done
// by the isputnik.faces container, so the page also says whether that is there.

interface SceneLibrary {
  id: string;
  name: string;
  photos: number;
  described: number;
  unreadable: number;
}

interface SceneSettings {
  enabled: boolean;
  model: string;
  engine: { available: boolean; version: string | null; reason: string | null };
  libraries: SceneLibrary[];
  scan: { libraryId: string | null; status: "pending" | "running"; processed: number; total: number; queued: number } | null;
}

const URL = "/api/library/gallery/scene";
/** While a scan runs the counts move: ask again this often. */
const POLL_MS = 3000;

export function SceneSearchSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [settings, setSettings] = useState<SceneSettings | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState<"switch" | "scan" | "rescan" | "delete" | null>(null);
  const [confirm, setConfirm] = useState<"rescan" | "delete" | null>(null);

  const load = useCallback(async () => {
    setSettings(await api<SceneSettings>(`${URL}/settings`));
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:sceneSearch.loadFailed")));
  }, [load, t]);

  const scanning = Boolean(settings?.scan);
  useEffect(() => {
    if (!scanning) return;
    const timer = setInterval(() => { load().catch(() => undefined); }, POLL_MS);
    return () => clearInterval(timer);
  }, [scanning, load]);

  const act = async (what: NonNullable<typeof busy>, request: () => Promise<SceneSettings>) => {
    setActionError("");
    setBusy(what);
    try {
      setSettings(await request());
      setConfirm(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("errors.actionFailed"));
      setConfirm(null);
    } finally {
      setBusy(null);
    }
  };

  const photos = settings?.libraries.reduce((sum, library) => sum + library.photos, 0) ?? 0;
  const described = settings?.libraries.reduce((sum, library) => sum + library.described, 0) ?? 0;
  const scanLibrary = settings?.scan ? settings.libraries.find((library) => library.id === settings.scan!.libraryId) : undefined;

  return (
    <>
      <ControlSectionHead
        section="sceneSearch"
        className="control-head-compact"
        icon={<ScanSearch size={30} />}
        description={t("controlAdmin:sceneSearch.headDescription")}
      >
        <div className="row-actions control-head-actions">
          <RefreshButton
            onRefresh={async () => {
              setError("");
              try {
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : t("controlAdmin:sceneSearch.loadFailed"));
                throw err;
              }
            }}
          />
        </div>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlAdmin:sceneSearch.loadFailed")}>{error}</MessageBox>}
      {actionError && <MessageBox tone="error" title={t("errors.actionFailed")}>{actionError}</MessageBox>}
      {settings && !settings.engine.available && (
        <MessageBox tone="warning" title={t("controlAdmin:sceneSearch.engineMissingTitle")}>
          {settings.engine.reason}
        </MessageBox>
      )}

      {settings && (
        <div className="settings-card-grid">
          <SettingsCard
            id="scene-search-switch"
            icon={<ScanSearch size={18} />}
            title={t("controlAdmin:sceneSearch.switchCardTitle")}
            description={t("controlAdmin:sceneSearch.switchCardDescription")}
            note={t("controlAdmin:sceneSearch.switchCardNote")}
          >
            <GroupedList>
              <ToggleRow
                label={t("controlAdmin:sceneSearch.switchLabel")}
                sub={t("controlAdmin:sceneSearch.switchSub")}
                checked={settings.enabled}
                disabled={busy !== null}
                onChange={(next) => void act("switch", () => api<SceneSettings>(`${URL}/settings`, { method: "PATCH", body: JSON.stringify({ enabled: next }) }))}
              />
              <NavRow
                label={t("controlAdmin:sceneSearch.engineLabel")}
                sub={t("controlAdmin:sceneSearch.engineSub")}
                value={settings.engine.available
                  ? (settings.engine.version ? t("controlAdmin:sceneSearch.engineReadyVersion", { version: settings.engine.version }) : t("controlAdmin:sceneSearch.engineReady"))
                  : t("controlAdmin:sceneSearch.engineNotReady")}
                valueTone={settings.engine.available ? "ok" : "warn"}
                href={appPageHref("appsSetup", "faces")}
              />
            </GroupedList>
          </SettingsCard>

          <SettingsCard
            id="scene-search-progress"
            icon={<Images size={18} />}
            title={t("controlAdmin:sceneSearch.progressCardTitle")}
            description={settings.libraries.length === 0
              ? t("controlAdmin:sceneSearch.noLibraries")
              : t("controlAdmin:sceneSearch.progressSummary", { described: formatNumber(described), count: photos, total: formatNumber(photos) })}
            note={t("controlAdmin:sceneSearch.progressCardNote")}
          >
            <GroupedList>
              {settings.scan && (
                <NavRow
                  label={settings.scan.status === "running" ? t("controlAdmin:sceneSearch.scanRunning") : t("controlAdmin:sceneSearch.scanWaiting")}
                  sub={scanLibrary?.name}
                  value={settings.scan.total > 0
                    ? t("controlAdmin:sceneSearch.scanProgress", { processed: formatNumber(settings.scan.processed), total: formatNumber(settings.scan.total) })
                    : undefined}
                  href={tasksHref({ application: "gallery" })}
                />
              )}
              {settings.libraries.map((library) => (
                <InfoRow
                  key={library.id}
                  label={library.name}
                  sub={library.unreadable > 0 ? t("controlAdmin:sceneSearch.unreadable", { count: library.unreadable }) : undefined}
                  value={t("controlAdmin:sceneSearch.libraryProgress", { described: formatNumber(library.described), total: formatNumber(library.photos) })}
                  valueTone={library.photos > 0 && library.described + library.unreadable >= library.photos ? "ok" : undefined}
                />
              ))}
              {settings.enabled && (
                <ActionRow
                  label={busy === "scan" ? t("controlAdmin:sceneSearch.scanning") : t("controlAdmin:sceneSearch.scanNew")}
                  disabled={busy !== null || scanning || !settings.engine.available}
                  onClick={() => void act("scan", () => api<SceneSettings>(`${URL}/scan`, { method: "POST", body: JSON.stringify({}) }))}
                />
              )}
              {settings.enabled && described > 0 && (
                <ActionRow
                  label={t("controlAdmin:sceneSearch.rescanAll")}
                  disabled={busy !== null || scanning || !settings.engine.available}
                  onClick={() => { setActionError(""); setConfirm("rescan"); }}
                />
              )}
              {!settings.enabled && described > 0 && (
                <ActionRow
                  tone="danger"
                  label={t("controlAdmin:sceneSearch.deleteData")}
                  disabled={busy !== null || scanning}
                  onClick={() => { setActionError(""); setConfirm("delete"); }}
                />
              )}
            </GroupedList>
          </SettingsCard>
        </div>
      )}

      {confirm === "rescan" && (
        <ConfirmDialog
          title={t("controlAdmin:sceneSearch.confirmRescanTitle")}
          confirmLabel={t("controlAdmin:sceneSearch.confirmRescanLabel")}
          busyLabel={t("controlAdmin:sceneSearch.scanning")}
          busy={busy === "rescan"}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void act("rescan", () => api<SceneSettings>(`${URL}/scan`, { method: "POST", body: JSON.stringify({ force: true }) }))}
        >
          {t("controlAdmin:sceneSearch.confirmRescanBody", { count: photos, total: formatNumber(photos) })}
        </ConfirmDialog>
      )}

      {confirm === "delete" && (
        <ConfirmDialog
          danger
          title={t("controlAdmin:sceneSearch.confirmDeleteTitle")}
          confirmLabel={t("controlAdmin:sceneSearch.confirmDeleteLabel")}
          busyLabel={t("controlAdmin:sceneSearch.deleting")}
          busy={busy === "delete"}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void act("delete", () => api<SceneSettings>(`${URL}/data`, { method: "DELETE" }))}
        >
          {t("controlAdmin:sceneSearch.confirmDeleteBody")}
        </ConfirmDialog>
      )}
    </>
  );
}
