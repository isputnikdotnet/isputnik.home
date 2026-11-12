import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Database, DatabaseBackup, FileArchive, Folder, Trash2, RotateCcw, UploadCloud } from "lucide-react";
import { api } from "../../../api";
import { controlHref, followRoute, goBack, replaceNavigate } from "../../../router";
import { storageHref } from "../links";
import { ActionRow, CommandRow, GroupedList, InfoRow, InputRow, NavRow, ToggleRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { FileUpload } from "../../../shared/FileUpload";
import { queryPageHref, useQueryPage } from "../../../shared/useQueryPage";
import { formatBytes, formatManagedDate } from "../../../shared/utils";
import { ControlSectionHead } from "../ControlSectionHead";
import { JobScheduleRows, useScheduleSummary, type JobScheduleFields } from "../JobScheduleControls";
import { JobRunRows } from "./ScheduledJobsSection";
import { ContainerBackups } from "./ContainerBackups";

type BackupKind = "full" | "minimal" | "database";

interface BackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
  kind: BackupKind;
}

// How many of each kind to keep, one number per kind: a nightly minimal backup and
// a monthly full one are different sizes and kept for different reasons.
type Retention = Record<BackupKind, number>;

interface BackupSettings {
  retention: Retention;
}

interface BackupList {
  backups: BackupFile[];
  backupPath: string;
  settings: BackupSettings;
  coversAvailable: boolean;
  totalSizeBytes: number;
  runningSince: string | null;
  runningKind: BackupKind | null;
  lastError: string | null;
}

// The two backup jobs as the Scheduled jobs page holds them; this page edits them
// with the same rows, so a schedule set here is the one seen there.
interface ScheduledJob extends JobScheduleFields {
  key: string;
  label: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | null;
  lastMessage: string | null;
}

const SCHEDULED_KINDS: { key: string; kind: "full" | "minimal" }[] = [
  { key: "backup_full", kind: "full" },
  { key: "backup_minimal", kind: "minimal" }
];

// A compact overview, with addressable details for schedules, retention, storage,
// files and application backups. Back follows the visit, including its entry page.
export function BackupSection() {
  const { t } = useTranslation(["common", "control", "controlAdmin"]);
  const [data, setData] = useState<BackupList | null>(null);
  const [jobs, setJobs] = useState<Record<string, ScheduledJob> | null>(null);
  const [jobsUnavailable, setJobsUnavailable] = useState(false);
  const [retention, setRetention] = useState<Retention>({ full: 10, minimal: 10, database: 10 });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState<BackupKind | null>(null);
  const [savingRetention, setSavingRetention] = useState<BackupKind | null>(null);
  const [savingJob, setSavingJob] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BackupFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<BackupFile | null>(null);
  const [restoreCovers, setRestoreCovers] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [show, go] = useQueryPage();
  const scheduleSummary = useScheduleSummary();

  // Old dashboard/app links pointed at an expanded container card. Keep them
  // useful now that each application opens its own page, without adding a visit.
  useEffect(() => {
    const legacyApp = window.location.hash.match(/^#container-backup-(.+)$/)?.[1];
    if (!show && legacyApp) replaceNavigate(queryPageHref(`app:${legacyApp}`));
  }, [show]);

  const load = useCallback(async () => {
    const payload = await api<BackupList>("/api/backups");
    setData(payload);
    setRetention(payload.settings.retention);
  }, []);

  const loadJobs = useCallback(async () => {
    const payload = await api<{ jobs: ScheduledJob[] }>("/api/scheduled-jobs");
    setJobs(Object.fromEntries(payload.jobs.filter((job) => job.key.startsWith("backup_")).map((job) => [job.key, job])));
    setJobsUnavailable(false);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : t("control:backup.unableToLoad")));
    loadJobs().catch((err) => {
      setJobsUnavailable(true);
      setError(err instanceof Error ? err.message : t("control:backup.unableToLoadSchedule"));
    });
  }, [load, loadJobs, t]);

  // A backup runs for minutes — far longer than a proxy will hold the request
  // open — so the server answers the start right away and the page watches the
  // list until the run is over. Scheduled runs and other admins are seen too:
  // any load that reports runningSince puts the page into the same waiting state.
  const running = Boolean(data?.runningSince);
  const sawRun = useRef(false);
  useEffect(() => {
    if (running) {
      sawRun.current = true;
      const timer = setTimeout(() => { load().catch(() => {}); }, 3000);
      return () => clearTimeout(timer);
    }
    if (sawRun.current) {
      sawRun.current = false;
      if (data?.lastError) {
        setError(t("control:backup.notFinished", { reason: data.lastError }));
      } else {
        setNotice(t("control:backup.created", { name: data?.backups[0]?.name ?? t("control:backup.createdFallback") }));
      }
    }
  }, [running, data, load, t]);

  const createBackup = async (kind: BackupKind) => {
    setCreating(kind);
    setError(""); setNotice("");
    try {
      await api<{ startedAt: string }>("/api/backups", { method: "POST", body: JSON.stringify({ kind }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:backup.unableToStart"));
    } finally {
      setCreating(null);
    }
  };

  // How many of a kind to keep is written through on leaving the field. A field
  // left empty or out of 1–100 is not a number to save: it goes back to what the
  // server last said.
  const commitRetention = async (kind: BackupKind) => {
    const wanted = Math.floor(retention[kind]);
    const current = data?.settings.retention[kind];
    if (!Number.isFinite(wanted) || wanted < 1 || wanted > 100) {
      if (current != null) setRetention((state) => ({ ...state, [kind]: current }));
      return;
    }
    if (wanted === current) return;
    setSavingRetention(kind);
    setError(""); setNotice("");
    try {
      await api("/api/backups/settings", { method: "PATCH", body: JSON.stringify({ retention: { [kind]: wanted } }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:backup.unableToSaveSettings"));
      await load().catch(() => undefined);
    } finally {
      setSavingRetention(null);
    }
  };

  // Same write-through as the Scheduled jobs page: the server's answer is reloaded
  // and that is what recomputes "next run".
  const saveJob = async (job: ScheduledJob, patch: Partial<JobScheduleFields> & { enabled?: boolean }) => {
    setSavingJob(job.key);
    setError("");
    try {
      await api(`/api/scheduled-jobs/${job.key}`, {
        method: "PATCH",
        body: JSON.stringify({
          enabled: job.enabled,
          frequency: job.frequency,
          time: job.time,
          dayOfWeek: job.dayOfWeek,
          dayOfMonth: job.dayOfMonth,
          ...patch
        })
      });
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:scheduledJobs.saveFailed"));
      await loadJobs().catch(() => undefined);
    } finally {
      setSavingJob(null);
    }
  };

  const deleteBackup = async () => {
    if (!pendingDelete) return;
    setDeleting(true); setError("");
    try {
      await api(`/api/backups/${encodeURIComponent(pendingDelete.name)}`, { method: "DELETE" });
      setPendingDelete(null);
      goBack(queryPageHref(null));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:backup.unableToDelete"));
    } finally {
      setDeleting(false);
    }
  };

  const restoreBackup = async () => {
    if (!pendingRestore) return;
    // Both zip kinds carry pictures now — a full one the whole store, a minimal one
    // the art a rescan could not put back — so both offer to leave them alone.
    const covers = pendingRestore.kind !== "database" && restoreCovers;
    setRestoring(true); setError("");
    try {
      await api(`/api/backups/${encodeURIComponent(pendingRestore.name)}/restore`, {
        method: "POST",
        body: JSON.stringify({ covers })
      });
      setNotice(
        covers
          ? t("control:backup.restoredNotice", { name: pendingRestore.name })
          : t("control:backup.restoredNoticeDbOnly", { name: pendingRestore.name })
      );
      setPendingRestore(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:backup.unableToStageRestore"));
    } finally {
      setRestoring(false);
    }
  };

  const handleBackupUploaded = async (payload: unknown) => {
    const res = payload as { backup?: BackupFile };
    setShowUpload(false);
    setError("");
    setNotice(t("control:backup.uploaded", { name: res.backup?.name ?? t("control:backup.uploadedFallback") }));
    await load();
  };

  const kindLabel = (kind: BackupKind) =>
    kind === "full" ? t("control:backup.kindFull") : kind === "minimal" ? t("control:backup.kindMinimal") : t("control:backup.kindDatabase");
  const kindIcon = (kind: BackupKind) =>
    kind === "full" ? <DatabaseBackup size={17} /> : kind === "minimal" ? <FileArchive size={17} /> : <Database size={17} />;

  // Which row is busy: the kind being started, or the kind running (a scheduled run
  // lights the matching row too).
  const busyKind = creating ?? data?.runningKind ?? null;
  const anyBusy = creating !== null || running;
  // The file being written is already in the list and grows as we poll; it must not
  // offer Restore/Download/Delete half-made.
  const isWriting = (backup: BackupFile) => running && data?.runningSince != null && backup.createdAt >= data.runningSince;

  const notices = (
    <>
      {error && <MessageBox tone="error" title={t("control:backup.errorTitle")}>{error}</MessageBox>}
      {!error && data?.lastError && <MessageBox tone="error" title={t("control:backup.errorTitle")}>{t("control:backup.notFinished", { reason: data.lastError })}</MessageBox>}
      {notice && <MessageBox tone="success" title={t("control:backup.listTitle")}>{notice}</MessageBox>}
    </>
  );
  const unit = (count: number) => t("control:backup.unitBackups", { count: Number.isFinite(count) ? count : 0 });
  const keepRow = (kind: BackupKind, label: string) => (
    <InputRow
      label={label}
      type="number"
      min={1}
      max={100}
      value={Number.isNaN(retention[kind]) ? "" : String(retention[kind])}
      unit={unit(retention[kind])}
      disabled={!data || savingRetention === kind}
      onChange={(value) => setRetention((state) => ({ ...state, [kind]: value === "" ? Number.NaN : Number(value) }))}
      onCommit={() => void commitRetention(kind)}
    />
  );

  let body: ReactNode;
  const jobKey = show?.startsWith("job:") ? show.slice(4) : null;
  const backupName = show?.startsWith("backup:") ? show.slice(7) : null;
  const appId = show?.startsWith("app:") ? show.slice(4) : null;
  const files = [...(data?.backups ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = files.find((file) => !isWriting(file));
  const nextJob = Object.values(jobs ?? {}).filter((job) => job.enabled && job.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];
  let title: ReactNode;

  const backupRows = (backups: BackupFile[]) => backups.length === 0
    ? <InfoRow icon={<FileArchive size={17} />} iconTone="muted" label={t("control:backup.emptyTitle")} sub={t("control:backup.emptyBody")} />
    : backups.map((backup) => (
      <NavRow
        key={backup.name}
        icon={kindIcon(backup.kind)}
        label={formatManagedDate(backup.createdAt)}
        sub={isWriting(backup) ? t("control:backup.writingInProgress") : kindLabel(backup.kind)}
        value={formatBytes(backup.sizeBytes)}
        disabled={isWriting(backup)}
        onClick={() => go(`backup:${backup.name}`)}
      />
    ));

  if (appId) {
    body = <ContainerBackups appId={appId} onOpen={(id) => go(`app:${id}`)} />;
  } else if (show === "retention") {
    title = t("control:backup.retentionTitle");
    body = <>{notices}<GroupedList note={t("control:backup.retentionNote")}>
      {keepRow("full", kindLabel("full"))}
      {keepRow("minimal", kindLabel("minimal"))}
      {keepRow("database", kindLabel("database"))}
    </GroupedList></>;
  } else if (show === "storage") {
    title = t("control:backup.storageTitle");
    body = <>{notices}{data && <>
      <GroupedList note={t("control:backup.pathTitle")}>
        <InfoRow icon={<Folder size={17} />} label={t("control:backup.savedIn")} sub={<code>{data.backupPath}</code>} />
        <InfoRow label={t("control:backup.thSize")} value={formatBytes(data.totalSizeBytes)} />
        <NavRow label={t("control:backup.viewAll")} value={t("control:backup.unitBackups", { count: files.length })} onClick={() => go("all")} />
      </GroupedList>
      <GroupedList><NavRow label={t("control:backup.storageLink")} href={storageHref()} /></GroupedList>
    </>}</>;
  } else if (show === "all") {
    title = t("control:backup.viewAll");
    body = <>{notices}{data ? <GroupedList>{backupRows(files)}</GroupedList> : !error && <p className="muted">{t("control:ui.loading")}</p>}</>;
  } else if (jobKey) {
    // ── A scheduled kind ──────────────────────────────────────────────────────
    const entry = SCHEDULED_KINDS.find((candidate) => candidate.key === jobKey);
    const job = jobs?.[jobKey];
    title = entry?.kind === "full" ? t("control:backup.scheduleFull") : t("control:backup.scheduleMinimal");
    if (!entry || !job) {
      body = <>{notices}{!jobsUnavailable && <p className="muted">{!jobs && entry ? t("controlAdmin:ui.loading") : t("controlAdmin:scheduledJobs.gone")}</p>}</>;
    } else {
      const busy = savingJob === job.key;
      body = (
        <>
          {notices}
          <GroupedList note={entry.kind === "full" ? t("control:backup.scheduleFullHint") : t("control:backup.scheduleMinimalHint")}>
            <ToggleRow
              label={t("controlAdmin:scheduledJobs.onRow")}
              checked={job.enabled}
              disabled={busy}
              onChange={(next) => void saveJob(job, { enabled: next })}
            />
          </GroupedList>
          {entry.kind === "full" && data && !data.coversAvailable && (
            <MessageBox tone="warning" title={t("control:backup.noThumbnailStoreTitle")}>
              {t("control:backup.noThumbnailStore")}{" "}
              <a href={storageHref("system-data")} onClick={(event) => followRoute(event, storageHref("system-data"))}>
                {t("control:backup.storageLink")}
              </a>
            </MessageBox>
          )}
          {job.enabled && (
            <GroupedList title={t("controlAdmin:scheduledJobs.groupSchedule")}>
              <JobScheduleRows schedule={job} disabled={busy} onChange={(patch) => void saveJob(job, patch)} />
            </GroupedList>
          )}
          {/* With the schedule, because how many to keep belongs with how often they
              are made — though it governs the ones made by hand just the same. */}
          <GroupedList note={t("control:backup.keepKindNote")}>
            {keepRow(entry.kind, t("control:backup.keepNewest"))}
          </GroupedList>
          <JobRunRows job={job} />
          <p className="grouped-list-note">
            <a href={controlHref("scheduledJobs")} onClick={(event) => followRoute(event, controlHref("scheduledJobs"))}>
              {t("control:backup.allJobsLink")}
            </a>
          </p>
        </>
      );
    }
  } else if (backupName) {
    // ── One backup ────────────────────────────────────────────────────────────
    const backup = data?.backups.find((candidate) => candidate.name === backupName);
    title = backup ? formatManagedDate(backup.createdAt) : t("control:nav.tabs.backup");
    if (!data) {
      body = <>{notices}<p className="muted">{t("controlAdmin:ui.loading")}</p></>;
    } else if (!backup) {
      body = <>{notices}<p className="muted">{t("control:backup.gone")}</p></>;
    } else {
      const writing = isWriting(backup);
      body = (
        <>
          {notices}
          <GroupedList>
            <InfoRow label={t("control:backup.fileName")} sub={backup.name} />
            <InfoRow icon={kindIcon(backup.kind)} label={t("control:backup.thType")} value={writing ? t("control:backup.writingInProgress") : kindLabel(backup.kind)} />
            <InfoRow label={t("control:backup.thCreated")} value={formatManagedDate(backup.createdAt)} />
            <InfoRow label={t("control:backup.thSize")} value={formatBytes(backup.sizeBytes)} />
          </GroupedList>
          {!writing && (
            <>
              <GroupedList note={t("control:backup.restoreRowNote")}>
                <ActionRow label={t("control:backup.restore")} onClick={() => { setRestoreCovers(true); setPendingRestore(backup); }} />
                <ActionRow label={t("control:backup.download")} href={`/api/backups/${encodeURIComponent(backup.name)}/download`} download />
              </GroupedList>
              <GroupedList>
                <ActionRow tone="danger" label={t("control:backup.deleteConfirmLabel")} onClick={() => setPendingDelete(backup)} />
              </GroupedList>
            </>
          )}
        </>
      );
    }
  } else {
    // ── The page ─────────────────────────────────────────────────────────────
    body = (
      <>
        {notices}
        {data && <GroupedList note={t("control:backup.summaryNote")}>
          {running && <InfoRow label={t("control:backup.backingUp")} value={data.runningKind ? kindLabel(data.runningKind) : undefined} />}
          {latest
            ? <NavRow label={t("control:backup.latestAvailable")} value={formatManagedDate(latest.createdAt)} onClick={() => go(`backup:${latest.name}`)} />
            : <InfoRow label={t("control:backup.latestAvailable")} value={t("control:backup.emptyTitle")} />}
          <NavRow label={t("control:backup.nextScheduled")} value={jobsUnavailable ? t("control:backup.unavailable") : !jobs ? t("control:ui.loading") : nextJob?.nextRunAt ? formatManagedDate(nextJob.nextRunAt) : t("control:backup.scheduleOff")}
            disabled={!jobs}
            onClick={() => go(`job:${nextJob?.key ?? "backup_minimal"}`)} />
          <NavRow label={t("control:backup.storageTitle")} value={formatBytes(data.totalSizeBytes)} sub={t("control:backup.unitBackups", { count: files.length })} onClick={() => go("storage")} />
        </GroupedList>}
        {!data && !error && <p className="muted">{t("control:ui.loading")}</p>}
        <GroupedList title={t("control:backup.nowGroup")} note={t("control:backup.coverageNote")}>
          {(["full", "minimal", "database"] as const).map((kind) => (
            <CommandRow
              key={kind}
              icon={kindIcon(kind)}
              label={kind === "full" ? t("control:backup.createFull") : kind === "minimal" ? t("control:backup.createMinimal") : t("control:backup.createDatabase")}
              sub={kind === "full" ? t("control:backup.createFullTitle") : kind === "minimal" ? t("control:backup.createMinimalTitle") : t("control:backup.createDatabaseTitle")}
              value={busyKind === kind ? t("control:backup.backingUp") : t("control:backup.createAction")}
              disabled={!data || anyBusy}
              onClick={() => void createBackup(kind)}
            />
          ))}
        </GroupedList>

        <GroupedList
          id="scheduled-backups"
          title={t("control:backup.scheduledTitle")}
        >
          {SCHEDULED_KINDS.map(({ key, kind }) => {
            const job = jobs?.[key];
            return (
              <NavRow
                key={key}
                icon={kindIcon(kind)}
                iconTone={job?.enabled ? undefined : "muted"}
                label={kind === "full" ? t("control:backup.scheduleFull") : t("control:backup.scheduleMinimal")}
                value={job ? scheduleSummary(job) : jobsUnavailable ? t("control:backup.unavailable") : t("control:ui.loading")}
                disabled={!job}
                onClick={() => go(`job:${key}`)}
              />
            );
          })}
          <NavRow label={t("control:backup.retentionTitle")} sub={t("control:backup.retentionSummary")}
            value={data ? `${data.settings.retention.full} / ${data.settings.retention.minimal} / ${data.settings.retention.database}` : t("control:ui.loading")}
            disabled={!data} onClick={() => go("retention")} />
        </GroupedList>

        <ContainerBackups onOpen={(id) => go(`app:${id}`)} />

        {data && (
          <GroupedList
            title={t("control:backup.recentTitle")}
          >
            {backupRows(files.slice(0, 3))}
            {files.length > 3 && <NavRow label={t("control:backup.viewAll")} value={t("control:backup.unitBackups", { count: files.length })} onClick={() => go("all")} />}
          </GroupedList>
        )}
        <GroupedList>
          <ActionRow label={t("control:backup.uploadBackup")} onClick={() => { setError(""); setNotice(""); setShowUpload(true); }} />
        </GroupedList>
      </>
    );
  }

  return (
    <>
      {!appId && <ControlSectionHead section="backup" title={title}
        back={{ href: show ? queryPageHref(null) : controlHref("appearance"), label: t("control:backup.back") }} />}
      {appId ? body : <div className="grouped-page">{body}</div>}

      {pendingDelete && (
        <ConfirmDialog
          title={t("control:backup.deleteConfirmTitle")}
          confirmLabel={t("control:backup.deleteConfirmLabel")}
          busyLabel={t("control:ui.deleting")}
          confirmIcon={<Trash2 size={15} />}
          danger
          busy={deleting}
          error={error}
          onConfirm={deleteBackup}
          onCancel={() => setPendingDelete(null)}
        >
          {t("control:backup.willBeRemoved", { name: pendingDelete.name, size: formatBytes(pendingDelete.sizeBytes) })}
        </ConfirmDialog>
      )}

      {pendingRestore && (
        <ConfirmDialog
          title={t("control:backup.restoreConfirmTitle")}
          confirmLabel={t("control:backup.stageRestore")}
          busyLabel={t("control:backup.staging")}
          confirmIcon={<RotateCcw size={15} />}
          rich
          busy={restoring}
          error={error}
          onConfirm={restoreBackup}
          onCancel={() => setPendingRestore(null)}
        >
          <p>
            {t("control:backup.restoreBody", { name: pendingRestore.name })}
            {pendingRestore.kind !== "database" && restoreCovers && t("control:backup.restoreCoversNote")}
          </p>
          {pendingRestore.kind !== "database" && (
            <label className="field-checkbox backup-cover-toggle">
              <input
                type="checkbox"
                checked={restoreCovers}
                onChange={(e) => setRestoreCovers(e.target.checked)}
              />
              <span>
                {t("control:backup.alsoRestoreCovers")}
                <small>{t("control:backup.alsoRestoreCoversHint")}</small>
              </span>
            </label>
          )}
          <p><strong>{t("control:backup.restoreRestartWarning")}</strong></p>
        </ConfirmDialog>
      )}

      {showUpload && (
        <Modal
          variant="card"
          className="backup-upload-modal"
          title={t("control:backup.uploadModalTitle")}
          icon={<UploadCloud size={20} />}
          busy={uploadBusy}
          onClose={() => setShowUpload(false)}
        >
          <p className="muted">
            {t("control:backup.uploadModalBody")}
          </p>
          <FileUpload
            endpoint="/api/backups/upload"
            accept={["zip", "sqlite"]}
            maxBytes={null}
            hint={t("control:backup.uploadHint")}
            onUploaded={handleBackupUploaded}
            onBusyChange={setUploadBusy}
          />
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setShowUpload(false)} disabled={uploadBusy}>
              {t("control:ui.close")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
