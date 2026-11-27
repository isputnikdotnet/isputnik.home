import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Container, Images, ListChecks, ScanFace, ScanSearch, SlidersHorizontal, Stethoscope } from "lucide-react";
import { api } from "../../../api";
import { controlHref } from "../../../router";
import { formatNumber } from "../../../shared/dates";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { ActionRow, CheckRow, CommandRow, GroupedList, InfoRow, NavRow, ToggleRow } from "../../../shared/GroupedList";
import { Modal } from "../../../shared/Modal";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { StatTiles, type StatTile } from "../../../shared/StatTiles";
import { ControlSectionHead } from "../ControlSectionHead";
import { appPageHref, tasksHref } from "../links";
import { FaceHealth } from "../recognition/FaceHealth";
import type { GalleryFaceEngineStatus, GalleryFaceLibrary, GalleryFaceSettings } from "../../gallery/types";

// Recognition: everything the app works out from photos by looking at them, on
// one page laid out like Gallery's Settings: at a glance, then a section for face
// recognition (who is in a photo) and one for search by content (what a photo
// shows), each with its switches and its settings. Beside them, what the two
// share: the engine (the isputnik.faces container) and the nightly schedule.
//
// Nothing on the page is a list of libraries: a household can have many. Which
// libraries are scanned for faces, how strongly faces are grouped, the people
// check and each library's search progress each open in a popup from one row.
// Scanning one library's faces again or removing its face data is on that
// library's own page (LibraryFacesDialog). Server: modules/library/gallery/faces
// and /scene; the plan for the second is docs/scene-search-plan.md.

interface SceneLibrary {
  id: string;
  name: string;
  /** A member's personal library: counted together, not listed one by one. */
  personal: boolean;
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

interface ScheduledJob {
  key: string;
  label: string;
  enabled: boolean;
  time: string;
}

/** The two nightly jobs, in the order they run. */
const JOB_KEYS = ["scan_new_faces", "scan_new_scenes"];
const SCENE = "/api/library/gallery/scene";
const FACES = "/api/library/gallery/faces";
/** While a scan runs the counts move: ask again this often. */
const POLL_MS = 3000;

export function RecognitionSection() {
  const { t } = useTranslation(["common", "control", "controlAdmin", "galleryModals"]);
  const [scene, setScene] = useState<SceneSettings | null>(null);
  const [faces, setFaces] = useState<GalleryFaceSettings | null>(null);
  const [engine, setEngine] = useState<GalleryFaceEngineStatus | null>(null);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [strength, setStrength] = useState(8);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"delete" | null>(null);
  // The two popups: how strongly faces are grouped, and what a search scan covers.
  const [groupingOpen, setGroupingOpen] = useState(false);
  const [draftStrength, setDraftStrength] = useState(8);
  const [scanOpen, setScanOpen] = useState(false);
  // A household can have many libraries, so they are never listed on the page:
  // which are scanned for faces, how far search has got in each, and the people
  // check each open from a row.
  const [librariesOpen, setLibrariesOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [scanAll, setScanAll] = useState(false);

  const loadScene = useCallback(async () => { setScene(await api<SceneSettings>(`${SCENE}/settings`)); }, []);

  const load = useCallback(async () => {
    // Two features side by side: one that does not answer must not hide the
    // other, so each part is asked for on its own.
    const [sceneAnswer, facesAnswer, engineAnswer, jobsAnswer] = await Promise.allSettled([
      api<SceneSettings>(`${SCENE}/settings`),
      api<GalleryFaceSettings>(`${FACES}/settings`),
      api<GalleryFaceEngineStatus>(`${FACES}/engine`),
      api<{ jobs: ScheduledJob[] }>("/api/scheduled-jobs")
    ]);
    if (sceneAnswer.status === "fulfilled") setScene(sceneAnswer.value);
    if (facesAnswer.status === "fulfilled") { setFaces(facesAnswer.value); setStrength(facesAnswer.value.groupingStrength); }
    if (engineAnswer.status === "fulfilled") setEngine(engineAnswer.value);
    if (jobsAnswer.status === "fulfilled") setJobs(JOB_KEYS.flatMap((key) => jobsAnswer.value.jobs.filter((job) => job.key === key)));
    const failed = [sceneAnswer, facesAnswer].find((answer) => answer.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) throw failed.reason instanceof Error ? failed.reason : new Error(t("controlAdmin:recognition.loadFailed"));
  }, [t]);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:recognition.loadFailed")));
  }, [load, t]);

  const scanning = Boolean(scene?.scan);
  useEffect(() => {
    if (!scanning) return;
    const timer = setInterval(() => { loadScene().catch(() => undefined); }, POLL_MS);
    return () => clearInterval(timer);
  }, [scanning, loadScene]);

  const act = async (what: string, work: () => Promise<void>) => {
    setActionError("");
    setNotice("");
    setBusy(what);
    try {
      await work();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("errors.actionFailed"));
    } finally {
      setConfirm(null);
      setGroupingOpen(false);
      setScanOpen(false);
      setBusy(null);
    }
  };
  const sceneAct = (what: string, request: () => Promise<SceneSettings>) => act(what, async () => { setScene(await request()); });

  // A library's face recognition on or off. On starts a scan of its photos.
  const toggleFaces = (library: GalleryFaceLibrary, enabled: boolean) => act(`faces:${library.id}`, async () => {
    setFaces(await api<GalleryFaceSettings>(`${FACES}/settings`, { method: "PATCH", body: JSON.stringify({ libraryId: library.id, enabled }) }));
    if (enabled) setNotice(t("galleryModals:faceSettings.enabledNotice", { name: library.name }));
  });

  // Save the grouping strength, then group the faces already found again.
  const regroup = () => act("regroup", async () => {
    await api(`${FACES}/settings`, { method: "PATCH", body: JSON.stringify({ groupingStrength: draftStrength }) });
    await api(`${FACES}/recompute`, { method: "POST" });
    setStrength(draftStrength);
    setNotice(t("galleryModals:faceSettings.regroupingNotice"));
  });

  const sceneLibraries = scene?.libraries ?? [];
  // The app's own two libraries (Photo Inbox, App files) are never scanned for
  // faces, whatever a switch says: they are left off the list. Search's list is
  // the household's libraries, so it is the one to go by once it has loaded.
  const faceLibraries = (faces?.libraries ?? []).filter((library) => !scene || sceneLibraries.some((entry) => entry.id === library.id));
  const facesOn = faceLibraries.filter((library) => library.enabled).length;
  const photos = sceneLibraries.reduce((sum, library) => sum + library.photos, 0);
  const described = sceneLibraries.reduce((sum, library) => sum + library.described, 0);
  // Photos no scan has got to yet (the ones given up on are not waiting).
  const waiting = Math.max(0, photos - described - sceneLibraries.reduce((sum, library) => sum + library.unreadable, 0));
  const scanLibrary = scene?.scan ? sceneLibraries.find((library) => library.id === scene.scan!.libraryId) : undefined;
  // Members' personal libraries (one per person, more with every phone) are
  // one row, counted together; each is its owner's to look at.
  const shared = sceneLibraries.filter((library) => !library.personal);
  const personal = sceneLibraries.filter((library) => library.personal);

  const facesReady = engine ? engine.where !== "none" : null;
  const scenesReady = scene ? scene.engine.available : null;
  const engineVersion = engine?.version ?? scene?.engine.version ?? null;
  // One warning, whichever half is missing: no engine at all, or one that finds
  // faces but is too old to describe photos.
  const engineProblem = engine?.where === "none" ? engine.reason : scene && !scene.engine.available ? scene.engine.reason : null;
  const ready = t("controlAdmin:sceneSearch.engineReady");
  const notReady = t("controlAdmin:sceneSearch.engineNotReady");
  const on = t("control:appSetup.overview.on");
  const off = t("control:appSetup.overview.off");
  const dash = "—";
  const of = (done: number, total: number) => t("controlAdmin:recognition.countOf", { done: formatNumber(done), total: formatNumber(total) });

  const tiles: StatTile[] = [
    {
      icon: <Container size={19} />, iconTone: facesReady === false ? "warn" : facesReady ? "ok" : "blue",
      tone: facesReady === false ? "warn" : undefined,
      label: t("controlAdmin:sceneSearch.engineLabel"),
      value: facesReady === null ? dash : facesReady ? ready : notReady,
      sub: engineVersion ? t("controlAdmin:recognition.engineVersion", { version: engineVersion }) : undefined,
      href: appPageHref("appsSetup", "faces")
    },
    {
      icon: <ScanFace size={19} />, iconTone: facesOn > 0 ? "ok" : "blue",
      label: t("controlAdmin:recognition.facesTitle"),
      value: faces ? (facesOn > 0 ? on : off) : dash,
      sub: faces ? t("controlAdmin:recognition.facesTileSub", { on: formatNumber(facesOn), total: formatNumber(faceLibraries.length) }) : undefined
    },
    {
      icon: <ScanSearch size={19} />, iconTone: scene?.enabled ? "ok" : "blue",
      label: t("control:appSetup.overview.sceneSearchTitle"),
      value: scene ? (scene.enabled ? on : off) : dash,
      sub: scene ? t("controlAdmin:recognition.searchTileSub", { described: formatNumber(described), total: formatNumber(photos) }) : undefined
    }
  ];

  return (
    <>
      <ControlSectionHead
        section="recognition"
        icon={<ScanFace size={30} />}
        description={t("controlAdmin:recognition.headDescription")}
      >
        <div className="row-actions control-head-actions">
          <RefreshButton
            onRefresh={async () => {
              setError("");
              try {
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : t("controlAdmin:recognition.loadFailed"));
                throw err;
              }
            }}
          />
        </div>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlAdmin:recognition.loadFailed")}>{error}</MessageBox>}
      {actionError && !librariesOpen && <MessageBox tone="error" title={t("errors.actionFailed")}>{actionError}</MessageBox>}
      {notice && !librariesOpen && <MessageBox tone="success" title={t("galleryModals:faceSettings.startedTitle")}>{notice}</MessageBox>}
      {engineProblem && <MessageBox tone="warning" title={t("controlAdmin:sceneSearch.engineMissingTitle")}>{engineProblem}</MessageBox>}

      <div className="diag-video app-overview-v3">
        <div className="diag-video-main">
          <section className="diag-tiles" aria-labelledby="recognition-tiles-title">
            <header className="diag-tiles-head">
              <h3 id="recognition-tiles-title">{t("control:appSetup.overview.tilesTitle")}</h3>
            </header>
            <StatTiles tiles={tiles} label={t("control:appSetup.overview.tilesTitle")} />
          </section>

          {/* Who is in a photo. A switch per library, then what is the same for all. */}
          <GroupedList id="recognition-faces" title={t("controlAdmin:recognition.facesTitle")}>
            <CommandRow
              icon={<Images size={17} />}
              label={t("controlAdmin:recognition.librariesRow")}
              sub={t("controlAdmin:recognition.librariesRowSub")}
              value={faces ? of(facesOn, faceLibraries.length) : undefined}
              disabled={!faces}
              onClick={() => { setActionError(""); setNotice(""); setLibrariesOpen(true); }}
            />
            <CommandRow
              icon={<SlidersHorizontal size={17} />}
              label={t("galleryModals:faceSettings.strengthLabel")}
              sub={t("controlAdmin:recognition.groupingRowSub")}
              value={faces ? String(strength) : undefined}
              disabled={busy !== null || facesOn === 0}
              onClick={() => { setActionError(""); setDraftStrength(strength); setGroupingOpen(true); }}
            />
            <CommandRow
              icon={<Stethoscope size={17} />}
              label={t("controlAdmin:recognition.healthCardTitle")}
              sub={t("controlAdmin:recognition.healthRowSub")}
              disabled={facesOn === 0}
              onClick={() => setHealthOpen(true)}
            />
          </GroupedList>

          {/* What a photo shows. One switch for every library, then how far each has got. */}
          <GroupedList id="recognition-search" title={t("control:appSetup.overview.sceneSearchTitle")} note={t("controlAdmin:sceneSearch.switchCardNote")}>
            {scene && (
              <ToggleRow
                label={t("controlAdmin:sceneSearch.switchLabel")}
                sub={t("controlAdmin:sceneSearch.switchSub")}
                checked={scene.enabled}
                disabled={busy !== null}
                onChange={(next) => void sceneAct("switch", () => api<SceneSettings>(`${SCENE}/settings`, { method: "PATCH", body: JSON.stringify({ enabled: next }) }))}
              />
            )}
            {scene?.scan && (
              <NavRow
                label={scene.scan.status === "running" ? t("controlAdmin:sceneSearch.scanRunning") : t("controlAdmin:sceneSearch.scanWaiting")}
                sub={scanLibrary?.name}
                value={scene.scan.total > 0 ? of(scene.scan.processed, scene.scan.total) : undefined}
                href={tasksHref({ application: "gallery" })}
              />
            )}
            {scene && (
              <CommandRow
                icon={<ListChecks size={17} />}
                label={t("controlAdmin:recognition.progressRow")}
                sub={t("controlAdmin:recognition.progressRowSub")}
                value={of(described, photos)}
                onClick={() => setProgressOpen(true)}
              />
            )}
            {scene?.enabled && (
              <CommandRow
                icon={<ScanSearch size={17} />}
                label={t("controlAdmin:recognition.scanRow")}
                sub={waiting > 0 ? t("controlAdmin:recognition.scanRowWaiting", { count: formatNumber(waiting) }) : t("controlAdmin:recognition.scanRowDone")}
                disabled={busy !== null || scanning || !scene.engine.available}
                onClick={() => { setActionError(""); setScanAll(waiting === 0); setScanOpen(true); }}
              />
            )}
            {scene && !scene.enabled && described > 0 && (
              <ActionRow
                tone="danger"
                label={t("controlAdmin:sceneSearch.deleteData")}
                disabled={busy !== null || scanning}
                onClick={() => { setActionError(""); setConfirm("delete"); }}
              />
            )}
          </GroupedList>
        </div>

        <aside className="diag-video-side">
          {/* What the two share. */}
          <GroupedList id="recognition-engine" title={t("controlAdmin:sceneSearch.engineLabel")} note={t("controlAdmin:sceneSearch.engineSub")}>
            <NavRow
              label={t("controlAdmin:recognition.engineConnection")}
              value={engineVersion ? t("controlAdmin:recognition.engineVersion", { version: engineVersion }) : undefined}
              href={appPageHref("appsSetup", "faces")}
            />
            <InfoRow label={t("controlAdmin:recognition.engineFaces")} value={facesReady === null ? undefined : facesReady ? ready : notReady} valueTone={facesReady === null ? undefined : facesReady ? "ok" : "warn"} />
            <InfoRow label={t("controlAdmin:recognition.engineScenes")} value={scenesReady === null ? undefined : scenesReady ? ready : notReady} valueTone={scenesReady === null ? undefined : scenesReady ? "ok" : "warn"} />
          </GroupedList>
          <GroupedList id="recognition-schedule" title={t("controlAdmin:recognition.scheduleCardTitle")} note={t("controlAdmin:recognition.scheduleCardNote")}>
            {jobs.map((job) => (
              <NavRow
                key={job.key}
                label={job.label}
                sub={job.enabled ? job.time : t("controlAdmin:recognition.scheduleOff")}
                href={controlHref("scheduledJobs")}
              />
            ))}
          </GroupedList>
        </aside>
      </div>

      {librariesOpen && (
        <Modal
          variant="card"
          title={t("controlAdmin:recognition.librariesDialogTitle")}
          icon={<Images size={22} />}
          busy={busy !== null}
          onClose={() => setLibrariesOpen(false)}
        >
          {actionError && <MessageBox tone="error" title={t("errors.actionFailed")}>{actionError}</MessageBox>}
          {notice && <MessageBox tone="success" title={t("galleryModals:faceSettings.startedTitle")}>{notice}</MessageBox>}
          {faceLibraries.length === 0 ? (
            <p className="management-empty">{t("controlAdmin:sceneSearch.noLibraries")}</p>
          ) : (
            <div className="recognition-popup-list">
              <GroupedList>
                {faceLibraries.map((library) => (
                  <ToggleRow
                    key={library.id}
                    label={library.name}
                    sub={library.enabled
                      ? `${t("galleryModals:faceSettings.scannedOf", { scanned: formatNumber(library.scanned), count: library.photos })}${library.unreadable > 0 ? t("galleryModals:faceSettings.unreadableCount", { count: library.unreadable }) : ""}`
                      : t("galleryModals:common.photoCount", { count: library.photos })}
                    checked={library.enabled}
                    // Nothing to find faces with: switching ON waits for the engine. Off always works.
                    disabled={busy !== null || (facesReady === false && !library.enabled)}
                    onChange={(next) => void toggleFaces(library, next)}
                  />
                ))}
              </GroupedList>
            </div>
          )}
          <p className="muted">{t("controlAdmin:recognition.facesNote")}</p>
          <div className="modal-actions">
            <Button variant="secondary" disabled={busy !== null} onClick={() => setLibrariesOpen(false)}>{t("common:common.close")}</Button>
          </div>
        </Modal>
      )}

      {healthOpen && (
        <Modal
          variant="card"
          title={t("controlAdmin:recognition.healthCardTitle")}
          icon={<Stethoscope size={22} />}
          onClose={() => setHealthOpen(false)}
        >
          <p className="muted">{t("controlAdmin:recognition.healthCardDescription")}</p>
          <div className="recognition-popup-list">
            <FaceHealth autoRun />
          </div>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setHealthOpen(false)}>{t("common:common.close")}</Button>
          </div>
        </Modal>
      )}

      {progressOpen && scene && (
        <Modal
          variant="card"
          title={t("controlAdmin:recognition.progressDialogTitle")}
          icon={<ListChecks size={22} />}
          onClose={() => setProgressOpen(false)}
        >
          {sceneLibraries.length === 0 ? (
            <p className="management-empty">{t("controlAdmin:sceneSearch.noLibraries")}</p>
          ) : (
            <div className="recognition-popup-list">
              <GroupedList>
                {shared.map((library) => (
                  <InfoRow
                    key={library.id}
                    label={library.name}
                    sub={library.unreadable > 0 ? t("controlAdmin:sceneSearch.unreadable", { count: library.unreadable }) : undefined}
                    value={of(library.described, library.photos)}
                    valueTone={library.photos > 0 && library.described + library.unreadable >= library.photos ? "ok" : undefined}
                  />
                ))}
                {personal.length > 0 && (
                  <InfoRow
                    label={t("controlAdmin:recognition.personalLibraries", { count: personal.length })}
                    value={of(personal.reduce((sum, library) => sum + library.described, 0), personal.reduce((sum, library) => sum + library.photos, 0))}
                  />
                )}
              </GroupedList>
            </div>
          )}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setProgressOpen(false)}>{t("common:common.close")}</Button>
          </div>
        </Modal>
      )}

      {groupingOpen && (
        <Modal
          variant="card"
          title={t("galleryModals:faceSettings.strengthLabel")}
          icon={<SlidersHorizontal size={22} />}
          busy={busy === "regroup"}
          onClose={() => setGroupingOpen(false)}
        >
          <div className="gallery-face-grouping">
            <div className="gallery-face-strength-head">
              <label htmlFor="recognition-strength">{t("galleryModals:faceSettings.strengthLabel")}</label>
              <strong>{draftStrength}</strong>
            </div>
            <input
              id="recognition-strength"
              type="range" min={2} max={8} step={1}
              value={draftStrength}
              disabled={busy !== null}
              onChange={(event) => setDraftStrength(Number(event.target.value))}
            />
            <p className="muted gallery-face-strength-desc">{t("galleryModals:faceSettings.strengthDesc")}</p>
            <p className="muted">{t("controlAdmin:recognition.groupingDialogNote")}</p>
          </div>
          <div className="modal-actions">
            <Button variant="secondary" disabled={busy !== null} onClick={() => setGroupingOpen(false)}>{t("common:common.cancel")}</Button>
            <Button variant="primary" disabled={busy !== null} onClick={() => void regroup()}>
              {busy === "regroup" ? t("galleryModals:faceSettings.regrouping") : t("galleryModals:faceSettings.regroup")}
            </Button>
          </div>
        </Modal>
      )}

      {scanOpen && scene && (
        <Modal
          variant="card"
          title={t("controlAdmin:recognition.scanDialogTitle")}
          icon={<ScanSearch size={22} />}
          busy={busy === "scan"}
          onClose={() => setScanOpen(false)}
        >
          <GroupedList>
            <CheckRow
              label={t("controlAdmin:recognition.scanChoiceNew")}
              sub={waiting > 0 ? t("controlAdmin:recognition.scanRowWaiting", { count: formatNumber(waiting) }) : t("controlAdmin:recognition.scanChoiceNewNone")}
              checked={!scanAll}
              disabled={busy !== null || waiting === 0}
              onSelect={() => setScanAll(false)}
            />
            <CheckRow
              label={t("controlAdmin:recognition.scanChoiceAll")}
              sub={t("controlAdmin:recognition.scanChoiceAllSub", { total: formatNumber(photos) })}
              checked={scanAll}
              disabled={busy !== null}
              onSelect={() => setScanAll(true)}
            />
          </GroupedList>
          <p className="muted">{t("controlAdmin:recognition.scanDialogNote")}</p>
          <div className="modal-actions">
            <Button variant="secondary" disabled={busy !== null} onClick={() => setScanOpen(false)}>{t("common:common.cancel")}</Button>
            <Button
              variant="primary"
              disabled={busy !== null}
              onClick={() => void sceneAct("scan", () => api<SceneSettings>(`${SCENE}/scan`, { method: "POST", body: JSON.stringify(scanAll ? { force: true } : {}) }))}
            >
              {busy === "scan" ? t("controlAdmin:recognition.scanStarting") : t("controlAdmin:recognition.scanStart")}
            </Button>
          </div>
        </Modal>
      )}

      {confirm === "delete" && (
        <ConfirmDialog
          danger
          title={t("controlAdmin:sceneSearch.confirmDeleteTitle")}
          confirmLabel={t("controlAdmin:sceneSearch.confirmDeleteLabel")}
          busyLabel={t("controlAdmin:sceneSearch.deleting")}
          busy={busy === "delete"}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void sceneAct("delete", () => api<SceneSettings>(`${SCENE}/data`, { method: "DELETE" }))}
        >
          {t("controlAdmin:sceneSearch.confirmDeleteBody")}
        </ConfirmDialog>
      )}
    </>
  );
}
