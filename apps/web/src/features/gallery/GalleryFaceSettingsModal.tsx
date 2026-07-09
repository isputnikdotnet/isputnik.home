import { useEffect, useState } from "react";
import { ScanFace, RefreshCw, Trash2, FlaskConical, UserRound, Combine, Stethoscope } from "lucide-react";
import { api } from "../../api";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { ToggleSwitch } from "../../shared/ToggleSwitch";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import type { ClusterHealth, ClusterHealthPair, ClusterHealthPerson, GalleryFaceLibrary, GalleryFaceSettings } from "./types";

function personLabel(p: ClusterHealthPerson): string {
  const count = `${p.faceCount.toLocaleString()} photo${p.faceCount === 1 ? "" : "s"}`;
  return `${p.name.trim() || "Unnamed"} · ${count}`;
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
  return (
    <div className="gallery-face-health">
      {error && <MessageBox tone="error" title="Unable to check">{error}</MessageBox>}
      {loading && (
        <p className="management-empty">Checking every person for likely duplicates… this can take a few seconds on a big library.</p>
      )}
      {!loading && health && (health.totalPeople === 0 ? (
        <MessageBox tone="info" title="No people to analyse">
          Turn on face recognition and run a scan first — there are no groups to check yet.
        </MessageBox>
      ) : (
        <>
          <p className="gallery-health-summary">
            <strong>{health.totalPeople.toLocaleString()}</strong> people ·{" "}
            <strong>{health.peopleWithTwin.toLocaleString()}</strong> look like they have a duplicate
            {" "}(another cluster that's probably the same person).
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
                {bar(`≥ ${health.mergeLine}`, health.bands.nearCertain, "near-certain")}
                {bar(`0.52–${health.mergeLine}`, health.bands.likely, "likely same")}
                {bar("0.45–0.52", health.bands.possible, "possible")}
              </div>
            );
          })()}

          <p className="muted gallery-health-explain">
            These pairs sit just under the automatic merge line ({health.mergeLine}) — grouping is deliberately
            cautious, so one person can end up split across clusters. A big pile-up here means it's under-merging.
            Merge the suggestions below to consolidate them; your names and manual fixes are kept.
          </p>

          {health.pairs.length === 0 ? (
            <MessageBox tone="success" title="Looks well-merged">
              No likely-duplicate clusters found — grouping isn't obviously under-merging.
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
                      <span className="gallery-health-sim">{Math.round(pair.similarity * 100)}% match</span>
                    </div>
                    <Button variant="primary" compact disabled={mergingKey === key} onClick={() => onMerge(pair)}>
                      <Combine size={14} aria-hidden="true" /> {mergingKey === key ? "Merging…" : "Merge"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="gallery-health-recheck">
            <Button variant="secondary" compact disabled={loading} onClick={onRecheck}>
              <Stethoscope size={14} aria-hidden="true" /> Re-check
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
// Tasks page (Control panel → Libraries → Tasks), not here.
export function GalleryFaceSettingsModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
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
      setError(err instanceof Error ? err.message : "Unable to load face-recognition settings");
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
      setNotice("Regrouping… the first time also prepares face thumbnails, so it can take a minute. Reopen the People tab to see the result.");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to apply");
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
      setHealthError(err instanceof Error ? err.message : "Unable to check clustering");
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
      setHealthError(err instanceof Error ? err.message : "Unable to merge");
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
      if (enabled) setNotice(`Face recognition on for "${library.name}" — scanning has started. Follow progress under Control panel → Libraries → Tasks.`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update");
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
      setNotice(`Full rescan started for "${library.name}". People update as photos are reprocessed — follow progress under Control panel → Libraries → Tasks.`);
      setConfirmRescan(null);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start the rescan");
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
      setNotice(`Removed all face data for "${library.name}".`);
      setConfirmClear(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove face data");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
    <Modal variant="card" className="gallery-face-modal" title="Face recognition" icon={<ScanFace size={22} />} onClose={onClose}>
      <p className="gallery-face-experimental">
        <FlaskConical size={14} aria-hidden="true" />
        <span><strong>Experimental</strong> — face recognition is still being refined. Grouping isn't perfect, so expect to merge or rename people now and then.</span>
      </p>

      {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
      {notice && <MessageBox tone="success" title="Started">{notice}</MessageBox>}

      <div className="modal-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "libraries"} className={`modal-tab${tab === "libraries" ? " active" : ""}`} onClick={() => setTab("libraries")}>Libraries</button>
        <button type="button" role="tab" aria-selected={tab === "grouping"} className={`modal-tab${tab === "grouping" ? " active" : ""}`} onClick={() => setTab("grouping")}>Grouping</button>
        <button type="button" role="tab" aria-selected={tab === "health"} className={`modal-tab${tab === "health" ? " active" : ""}`} onClick={() => setTab("health")}>Health</button>
      </div>

      <div className="modal-tab-content">
        {tab === "libraries" ? (
          <>
            <p className="muted gallery-face-modal-intro">
              Find faces in your photos and group the same person together — entirely on this server,
              nothing is sent to the internet. Turn it on per library.
            </p>
            {loaded && libraries.length === 0 ? (
              <p className="management-empty">No gallery libraries yet.</p>
            ) : (
              <ul className="gallery-face-lib-list">
                {libraries.map((library) => (
                  <li key={library.id} className="gallery-face-lib-row">
                    <div className="gallery-face-lib-toggle">
                      <ToggleSwitch
                        checked={library.enabled}
                        disabled={busyId === library.id}
                        onChange={(enabled) => void toggle(library, enabled)}
                        ariaLabel={`Face recognition for ${library.name}`}
                      />
                      <span>
                        {library.name}
                        <small>
                          {library.enabled
                            ? `${library.scanned.toLocaleString()} of ${library.photos.toLocaleString()} photos scanned`
                            : `${library.photos.toLocaleString()} photos`}
                          {library.enabled && library.unreadable > 0 && (
                            <span title="These photos could not be read (corrupt or unsupported files) and are skipped. A rescan tries them again.">
                              {` · ${library.unreadable.toLocaleString()} unreadable`}
                            </span>
                          )}
                        </small>
                      </span>
                    </div>
                    {library.enabled && (
                      <div className="row-actions gallery-face-row-actions">
                        <Button
                          variant="icon"
                          title="Rescan all photos"
                          aria-label={`Rescan ${library.name}`}
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
                          title="Remove face data"
                          aria-label={`Remove face data for ${library.name}`}
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
                <span>Grouping strength</span>
                <strong>{strength}</strong>
              </div>
              <input type="range" min={2} max={8} step={1} value={strength} disabled={recomputing} onChange={(event) => setStrength(Number(event.target.value))} />
              <p className="muted gallery-face-strength-desc">
                Lower = stricter: fewer different people wrongly merged, but more small groups to combine.
                Higher = more consolidated (8, the default). Applies to every library.
              </p>
              <Button variant="primary" compact disabled={recomputing} onClick={() => void applyStrength(strength)}>
                {recomputing ? "Regrouping…" : "Regroup people"}
              </Button>
            </div>
          ) : (
            <MessageBox tone="info" title="No libraries enabled">
              Turn on face recognition for a library on the Libraries tab, then come back here to tune how strongly faces are grouped.
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
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </Modal>

    {confirmRescan && (
      <ConfirmDialog
        title={`Rescan "${confirmRescan.name}"?`}
        confirmLabel="Rescan"
        busyLabel="Starting…"
        busy={busyId === confirmRescan.id}
        onConfirm={() => void rescan(confirmRescan)}
        onCancel={() => { if (busyId == null) setConfirmRescan(null); }}
      >
        This rebuilds the automatic face groups for this library from scratch. Your person names,
        manual tags, and the photos you've removed from named people are kept.
      </ConfirmDialog>
    )}

    {confirmClear && (
      <ConfirmDialog
        title={`Remove face data for "${confirmClear.name}"?`}
        confirmLabel="Remove face data"
        busyLabel="Removing…"
        confirmIcon={<Trash2 size={15} />}
        danger
        rich
        busy={busyId === confirmClear.id}
        error={error}
        onConfirm={() => void clearData(confirmClear)}
        onCancel={() => { if (busyId == null) setConfirmClear(null); }}
      >
        <p>
          This permanently deletes every detected face, automatic grouping, and face tag for
          <strong> {confirmClear.name}</strong>. People made up only of this library's faces will
          disappear from the People tab.
        </p>
        <p>
          <strong>Your photos are not deleted</strong>, and named people who also appear in other
          libraries are kept. You can run face recognition again later to rebuild the groups.
        </p>
      </ConfirmDialog>
    )}
    </>
  );
}
