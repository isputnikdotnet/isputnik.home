import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ScanFace, RefreshCw, Trash2, FlaskConical, UserRound, Combine, Stethoscope } from "lucide-react";
import i18n from "../../i18n";
import { api } from "../../api";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { ToggleSwitch } from "../../shared/ToggleSwitch";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import type { ClusterHealth, ClusterHealthPair, ClusterHealthPerson, GalleryFaceLibrary, GalleryFaceSettings } from "./types";

// Module-level helper (not a component) — imports i18n directly since it can't call a hook.
function personLabel(p: ClusterHealthPerson): string {
  const count = i18n.t("galleryModals:common.photoCount", { count: p.faceCount });
  return `${p.name.trim() || i18n.t("galleryModals:faceSettings.unnamed")} · ${count}`;
}

// One person's avatar in a suggestion, with the same graceful fallback the People grid
// uses (a placeholder icon if the crop can't load) instead of a broken-image glyph.
function HealthAvatar({ person }: { person: ClusterHealthPerson }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="gallery-health-avatar">
      {person.coverUrl && !failed
        ? <img src={person.coverUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
        : <UserRound size={26} aria-hidden="true" />}
    </span>
  );
}

// The "Health" tab: a read-out of how many people are probably the same person split
// across clusters (an under-merging signal), plus one-click merge suggestions.
function ClusterHealthPanel({ health, loading, error, mergingKey, onMerge, onRecheck }: {
  health: ClusterHealth | null;
  loading: boolean;
  error: string;
  mergingKey: string | null;
  onMerge: (pair: ClusterHealthPair) => void;
  onRecheck: () => void;
}) {
  const { t } = useTranslation(["common", "galleryModals"]);
  return (
    <div className="gallery-face-health">
      {error && <MessageBox tone="error" title={t("galleryModals:faceSettings.unableToCheckTitle")}>{error}</MessageBox>}
      {loading && (
        <p className="management-empty">{t("galleryModals:faceSettings.checkingBody")}</p>
      )}
      {!loading && health && (health.totalPeople === 0 ? (
        <MessageBox tone="info" title={t("galleryModals:faceSettings.noPeopleTitle")}>
          {t("galleryModals:faceSettings.noPeopleBody")}
        </MessageBox>
      ) : (
        <>
          <p className="gallery-health-summary">
            <strong>{t("galleryModals:faceSettings.summaryTotal", { count: health.totalPeople })}</strong> ·{" "}
            <strong>{t("galleryModals:faceSettings.summaryTwin", { count: health.peopleWithTwin })}</strong>
            {" "}{t("galleryModals:faceSettings.summaryTwinHint")}
          </p>

          {(() => {
            const max = Math.max(1, health.bands.nearCertain, health.bands.likely, health.bands.possible);
            const bar = (label: string, count: number, hint: string) => (
              <div className="gallery-health-bar-row" key={label}>
                <span className="gallery-health-bar-label">{label}</span>
                <span className="gallery-health-bar-track">
                  <span className="gallery-health-bar-fill" style={{ width: `${Math.round((count / max) * 100)}%` }} />
                </span>
                <span className="gallery-health-bar-count">{count.toLocaleString()}</span>
                <span className="gallery-health-bar-hint muted">{hint}</span>
              </div>
            );
            return (
              <div className="gallery-health-bars">
                {bar(`≥ ${health.mergeLine}`, health.bands.nearCertain, t("galleryModals:faceSettings.bandNearCertain"))}
                {bar(`0.52–${health.mergeLine}`, health.bands.likely, t("galleryModals:faceSettings.bandLikely"))}
                {bar("0.45–0.52", health.bands.possible, t("galleryModals:faceSettings.bandPossible"))}
              </div>
            );
          })()}

          <p className="muted gallery-health-explain">
            {t("galleryModals:faceSettings.explain", { mergeLine: health.mergeLine })}
          </p>

          {health.pairs.length === 0 ? (
            <MessageBox tone="success" title={t("galleryModals:faceSettings.wellMergedTitle")}>
              {t("galleryModals:faceSettings.wellMergedBody")}
            </MessageBox>
          ) : (
            <ul className="gallery-health-pairs">
              {health.pairs.map((pair) => {
                const key = `${pair.a.id}:${pair.b.id}`;
                return (
                  <li key={key} className="gallery-health-pair">
                    <div className="gallery-health-avatars">
                      <HealthAvatar person={pair.a} />
                      <HealthAvatar person={pair.b} />
                    </div>
                    <div className="gallery-health-pair-info">
                      <span>{personLabel(pair.a)}</span>
                      <span className="muted">{personLabel(pair.b)}</span>
                      <span className="gallery-health-sim">{t("galleryModals:faceSettings.matchPercent", { percent: Math.round(pair.similarity * 100) })}</span>
                    </div>
                    <Button variant="primary" compact disabled={mergingKey === key} onClick={() => onMerge(pair)}>
                      <Combine size={14} aria-hidden="true" /> {mergingKey === key ? t("galleryModals:faceSettings.merging") : t("galleryModals:faceSettings.merge")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="gallery-health-recheck">
            <Button variant="secondary" compact disabled={loading} onClick={onRecheck}>
              <Stethoscope size={14} aria-hidden="true" /> {t("galleryModals:faceSettings.recheck")}
            </Button>
          </div>
        </>
      ))}
    </div>
  );
}

// Admin popup: turn face recognition on/off per gallery library and trigger a full
// rescan. Enabling a library kicks off an initial scan automatically (server side);
// "Rescan" reprocesses every photo from scratch. Live scan progress is shown on the
// Tasks page (Control panel → Overview → Tasks), not here.
export function GalleryFaceSettingsModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation(["common", "galleryModals"]);
  const [libraries, setLibraries] = useState<GalleryFaceLibrary[]>([]);
  const [strength, setStrength] = useState(8); // matches server DEFAULT_FACE_K until the real value loads
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmRescan, setConfirmRescan] = useState<GalleryFaceLibrary | null>(null);
  const [confirmClear, setConfirmClear] = useState<GalleryFaceLibrary | null>(null);
  const [tab, setTab] = useState<"libraries" | "grouping" | "health">("libraries");
  // Clustering-health diagnostic (loaded lazily — it's an O(people²) pass).
  const [health, setHealth] = useState<ClusterHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState("");
  const [mergingKey, setMergingKey] = useState<string | null>(null);

  const load = async () => {
    try {
      const payload = await api<GalleryFaceSettings>("/api/library/gallery/faces/settings");
      setLibraries(payload.libraries);
      setStrength(payload.groupingStrength);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:faceSettings.unableToLoad"));
    }
  };

  const anyEnabled = libraries.some((l) => l.enabled);

  // Save the grouping strength then re-cluster existing faces (no re-detection).
  const applyStrength = async (value: number) => {
    setRecomputing(true);
    setError("");
    setNotice("");
    try {
      await api("/api/library/gallery/faces/settings", { method: "PATCH", body: JSON.stringify({ groupingStrength: value }) });
      await api("/api/library/gallery/faces/recompute", { method: "POST" });
      setNotice(t("galleryModals:faceSettings.regroupingNotice"));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:faceSettings.unableToApply"));
    } finally {
      setRecomputing(false);
    }
  };

  const loadHealth = async () => {
    setHealthLoading(true);
    setHealthError("");
    try {
      setHealth(await api<ClusterHealth>("/api/library/gallery/faces/cluster-health"));
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : t("galleryModals:faceSettings.unableToCheckClustering"));
    } finally {
      setHealthLoading(false);
    }
  };

  // Fold one suggested pair together (source b → survivor a), then drop it from the list.
  const mergePair = async (pair: ClusterHealthPair) => {
    const key = `${pair.a.id}:${pair.b.id}`;
    setMergingKey(key);
    setHealthError("");
    try {
      await api(`/api/library/gallery/people/${pair.b.id}/merge`, { method: "POST", body: JSON.stringify({ intoId: pair.a.id }) });
      setHealth((h) => (h ? { ...h, pairs: h.pairs.filter((p) => `${p.a.id}:${p.b.id}` !== key), peopleWithTwin: Math.max(0, h.peopleWithTwin - 2) } : h));
      onChanged();
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : t("galleryModals:faceSettings.unableToMerge"));
    } finally {
      setMergingKey(null);
    }
  };

  useEffect(() => { void load(); }, []);

  // Run the health check the first time the tab is opened (it's too heavy for eager load).
  useEffect(() => {
    if (tab === "health" && !health && !healthLoading && !healthError) void loadHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const toggle = async (library: GalleryFaceLibrary, enabled: boolean) => {
    setBusyId(library.id);
    setError("");
    setNotice("");
    try {
      const payload = await api<GalleryFaceSettings>("/api/library/gallery/faces/settings", {
        method: "PATCH",
        body: JSON.stringify({ libraryId: library.id, enabled })
      });
      setLibraries(payload.libraries);
      if (enabled) setNotice(t("galleryModals:faceSettings.enabledNotice", { name: library.name }));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:faceSettings.unableToUpdate"));
    } finally {
      setBusyId(null);
    }
  };

  const rescan = async (library: GalleryFaceLibrary) => {
    setBusyId(library.id);
    setError("");
    setNotice("");
    try {
      await api("/api/library/gallery/faces/scan", { method: "POST", body: JSON.stringify({ libraryId: library.id, force: true }) });
      setNotice(t("galleryModals:faceSettings.rescanNotice", { name: library.name }));
      setConfirmRescan(null);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:faceSettings.unableToRescan"));
    } finally {
      setBusyId(null);
    }
  };

  const clearData = async (library: GalleryFaceLibrary) => {
    setBusyId(library.id);
    setError("");
    setNotice("");
    try {
      const payload = await api<GalleryFaceSettings>("/api/library/gallery/faces/data", {
        method: "DELETE",
        body: JSON.stringify({ libraryId: library.id })
      });
      setLibraries(payload.libraries);
      setNotice(t("galleryModals:faceSettings.clearedNotice", { name: library.name }));
      setConfirmClear(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:faceSettings.unableToClear"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
    <Modal variant="card" className="gallery-face-modal" title={t("galleryModals:faceSettings.title")} icon={<ScanFace size={22} />} onClose={onClose}>
      <p className="gallery-face-experimental">
        <FlaskConical size={14} aria-hidden="true" />
        <span><Trans i18nKey="faceSettings.experimental" ns="galleryModals" components={{ bold: <strong /> }} /></span>
      </p>

      {error && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>}
      {notice && <MessageBox tone="success" title={t("galleryModals:faceSettings.startedTitle")}>{notice}</MessageBox>}

      <div className="modal-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "libraries"} className={`modal-tab${tab === "libraries" ? " active" : ""}`} onClick={() => setTab("libraries")}>{t("galleryModals:faceSettings.tabLibraries")}</button>
        <button type="button" role="tab" aria-selected={tab === "grouping"} className={`modal-tab${tab === "grouping" ? " active" : ""}`} onClick={() => setTab("grouping")}>{t("galleryModals:faceSettings.tabGrouping")}</button>
        <button type="button" role="tab" aria-selected={tab === "health"} className={`modal-tab${tab === "health" ? " active" : ""}`} onClick={() => setTab("health")}>{t("galleryModals:faceSettings.tabHealth")}</button>
      </div>

      <div className="modal-tab-content">
        {tab === "libraries" ? (
          <>
            <p className="muted gallery-face-modal-intro">
              {t("galleryModals:faceSettings.intro")}
            </p>
            {loaded && libraries.length === 0 ? (
              <p className="management-empty">{t("galleryModals:faceSettings.noLibraries")}</p>
            ) : (
              <ul className="gallery-face-lib-list">
                {libraries.map((library) => (
                  <li key={library.id} className="gallery-face-lib-row">
                    <div className="gallery-face-lib-toggle">
                      <ToggleSwitch
                        checked={library.enabled}
                        disabled={busyId === library.id}
                        onChange={(enabled) => void toggle(library, enabled)}
                        ariaLabel={t("galleryModals:faceSettings.toggleAria", { name: library.name })}
                      />
                      <span>
                        {library.name}
                        <small>
                          {library.enabled
                            ? t("galleryModals:faceSettings.scannedOf", { scanned: library.scanned.toLocaleString(), count: library.photos })
                            : t("galleryModals:common.photoCount", { count: library.photos })}
                          {library.enabled && library.unreadable > 0 && (
                            <span title={t("galleryModals:faceSettings.unreadableHint")}>
                              {t("galleryModals:faceSettings.unreadableCount", { count: library.unreadable })}
                            </span>
                          )}
                        </small>
                      </span>
                    </div>
                    {library.enabled && (
                      <div className="row-actions gallery-face-row-actions">
                        <Button
                          variant="icon"
                          title={t("galleryModals:faceSettings.rescanTitle")}
                          aria-label={t("galleryModals:faceSettings.rescanAria", { name: library.name })}
                          disabled={busyId === library.id}
                          onClick={() => setConfirmRescan(library)}
                        >
                          {busyId === library.id ? (
                            <span className="icon-spin" aria-hidden="true"><RefreshCw size={15} /></span>
                          ) : (
                            <RefreshCw size={15} />
                          )}
                        </Button>
                        <Button
                          variant="icon"
                          danger
                          title={t("galleryModals:faceSettings.removeDataTitle")}
                          aria-label={t("galleryModals:faceSettings.removeDataAria", { name: library.name })}
                          disabled={busyId === library.id}
                          onClick={() => { setError(""); setConfirmClear(library); }}
                        >
                          <Trash2 size={15} />
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : tab === "grouping" ? (
          anyEnabled ? (
            <div className="gallery-face-grouping">
              <div className="gallery-face-strength-head">
                <span>{t("galleryModals:faceSettings.strengthLabel")}</span>
                <strong>{strength}</strong>
              </div>
              <input type="range" min={2} max={8} step={1} value={strength} disabled={recomputing} onChange={(event) => setStrength(Number(event.target.value))} />
              <p className="muted gallery-face-strength-desc">
                {t("galleryModals:faceSettings.strengthDesc")}
              </p>
              <Button variant="primary" compact disabled={recomputing} onClick={() => void applyStrength(strength)}>
                {recomputing ? t("galleryModals:faceSettings.regrouping") : t("galleryModals:faceSettings.regroup")}
              </Button>
            </div>
          ) : (
            <MessageBox tone="info" title={t("galleryModals:faceSettings.noLibrariesEnabledTitle")}>
              {t("galleryModals:faceSettings.noLibrariesEnabledBody")}
            </MessageBox>
          )
        ) : (
          <ClusterHealthPanel
            health={health}
            loading={healthLoading}
            error={healthError}
            mergingKey={mergingKey}
            onMerge={mergePair}
            onRecheck={() => void loadHealth()}
          />
        )}
      </div>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose}>{t("common:common.close")}</Button>
      </div>
    </Modal>

    {confirmRescan && (
      <ConfirmDialog
        title={t("galleryModals:faceSettings.rescanConfirmTitle", { name: confirmRescan.name })}
        confirmLabel={t("galleryModals:faceSettings.rescanConfirmLabel")}
        busyLabel={t("galleryModals:faceSettings.starting")}
        busy={busyId === confirmRescan.id}
        onConfirm={() => void rescan(confirmRescan)}
        onCancel={() => { if (busyId == null) setConfirmRescan(null); }}
      >
        {t("galleryModals:faceSettings.rescanConfirmBody")}
      </ConfirmDialog>
    )}

    {confirmClear && (
      <ConfirmDialog
        title={t("galleryModals:faceSettings.clearConfirmTitle", { name: confirmClear.name })}
        confirmLabel={t("galleryModals:faceSettings.clearConfirmLabel")}
        busyLabel={t("galleryModals:faceSettings.removing")}
        confirmIcon={<Trash2 size={15} />}
        danger
        rich
        busy={busyId === confirmClear.id}
        error={error}
        onConfirm={() => void clearData(confirmClear)}
        onCancel={() => { if (busyId == null) setConfirmClear(null); }}
      >
        <p>
          <Trans i18nKey="faceSettings.clearConfirmBody1" ns="galleryModals" values={{ name: confirmClear.name }} components={{ bold: <strong /> }} />
        </p>
        <p>
          <Trans i18nKey="faceSettings.clearConfirmBody2" ns="galleryModals" components={{ bold: <strong /> }} />
        </p>
      </ConfirmDialog>
    )}
    </>
  );
}
