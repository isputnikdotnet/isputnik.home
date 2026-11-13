import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Clapperboard, Clock, Cpu, Download, Gauge, HardDrive, Image as ImageIcon, KeyRound, SkipForward } from "lucide-react";
import { api } from "../../../api";
import { controlHref } from "../../../router";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { ActionRow, GroupedList, InfoRow, InputRow, NavRow, NavToggleRow, PickerRow, ToggleRow } from "../../../shared/GroupedList";
import { ActionMenu } from "../../../shared/ActionMenu";
import { MessageBox } from "../../../shared/MessageBox";
import { queryPageHref, useQueryPage } from "../../../shared/useQueryPage";
import { formatBytes } from "../../../shared/utils";
import { KEEP_READY_URL, type KeepReadyState } from "../../video/KeepReadyModal";
import { ControlSectionHead } from "../ControlSectionHead";
import { isRunning, useAppsStatus } from "./AppsSection";
import { HardwareTestPage, HardwareTestRow } from "./VideoHardwareTest";

// Applications › Videos › Settings: the video engine's own settings, laid out like a
// phone's Settings (control panel v2). The page is a short overview — each topic one
// row saying how it stands, the two most-used settings (quality away from home, and
// finding intros) right on it — and each topic opens a page of its own
// (?show=conversion|metadata|copies|detection) with its explanation and controls.
// Everything saves as it changes. All of it lives in the engine and is read and
// saved through the gateway, so the page needs the engine answering, and a setting
// an older engine does not have is simply not offered.

// ── What the engine answers ────────────────────────────────────────────────────

/** GET/PUT {prefix}/api/admin/conversion (isputnik.video hls.ts). */
interface ConversionSettings {
  /** Before engine 0.35 (0.35+ still answers them, worked out from the new two). */
  memoryPerViewerMb: number;
  maxViewers: number;
  whenFull: "disk" | "wait";
  /** Engine 0.35+: memory only, memory then the disk, or the disk only. */
  storage?: ConversionStorage;
  /** Engine 0.35+: memory for everyone's conversion together. */
  memoryMb?: number;
  /** Engine 0.20+: where a picture is re-encoded (hardware.ts). */
  hardware?: HardwareMode;
  /** Engine 0.31+: the most a viewer on the internet gets; null is the file as it is. */
  remoteQuality?: 1080 | 720 | 480 | null;
}

type HardwareMode = "auto" | "cpu" | "gpu";
type ConversionStorage = "memory" | "memory-disk" | "disk";
const STORAGES: ConversionStorage[] = ["memory", "memory-disk", "disk"];
type RemoteQuality = "original" | "1080" | "720" | "480";
const REMOTE_QUALITIES: RemoteQuality[] = ["original", "1080", "720", "480"];

/** What the engine found the GPU does (engine 0.20+). */
interface HardwareState {
  mode: HardwareMode;
  device: string | null;
  driver: string | null;
  encode: boolean;
  decode: string[];
  /** Engine 0.25+: HDR tone-mapped on the GPU, and subtitles drawn there. */
  tonemap?: boolean;
  overlay?: boolean;
  error: string | null;
  checking: boolean;
  /** Automatic gave up on the GPU after failures, until Check again. */
  setAside: boolean;
}

interface ConversionState {
  available: boolean;
  settings: ConversionSettings;
  usage: {
    viewers: { user: string; title: string; mode: string; converter?: "gpu" | "cpu" | null; hdr?: boolean; rung?: number | null; converting: boolean; memoryBytes: number; diskBytes: number; shared?: boolean; kept?: boolean }[];
    memoryBytes: number;
    diskBytes: number;
    /** Engine 0.35+: films kept whole once converted all through. */
    kept?: { count: number; bytes: number };
  };
  hardware?: HardwareState | null;
  /** Engine 0.35+: whether the conversion folder is a disk mapped into the
   *  container (memory only without one), and the storage in force. */
  disk?: { mapped: boolean; folder: string; freeBytes: number | null; totalBytes: number | null } | null;
  storage?: ConversionStorage | null;
}

/** GET/PUT {prefix}/api/admin/metadata: whether the engine has a TMDB key (never the key). */
interface MetadataState {
  hasKey: boolean;
  keyHint: string | null;
}

/** GET/PUT/DELETE {prefix}/api/admin/copies (engine 0.33+, copies.ts). */
interface CopiesState {
  settings: { limitGb: number };
  folder: string;
  usedBytes: number;
  copies: { itemId: string; quality: number; title: string; state: "queued" | "running" | "ready" | "failed"; sizeBytes: number }[];
  /** Engine 0.35+: the copies' folder is no disk of its own, so none are prepared. */
  insideContainer?: boolean;
  /** Engine 0.35+: films kept whole once converted all through, under the same room. */
  kept?: { variant: string; title: string; rung: number | null; sizeBytes: number; usedAt: string; inUse?: boolean }[];
  keptBytes?: number;
}

/** GET/PUT {prefix}/api/admin/detection (engine 0.18+). */
interface DetectionState {
  enabled: boolean;
  /** false where the engine has no ffmpeg, so nothing can be found. */
  available: boolean;
  /** What it is looking at now (engine 0.18.1+); null when idle. */
  working?: string | null;
}

/** The decode test's codec names as people know them; not words to translate. */
const CODEC_NAMES: Record<string, string> = {
  h264: "H.264", hevc: "HEVC", hevc10: "HEVC 10-bit", vp9: "VP9", vp9_10: "VP9 10-bit", av1: "AV1", mpeg2video: "MPEG-2", vc1: "VC-1"
};

/** One engine endpoint: its answer, and null with no error while loading. An engine
 *  too old for it answers with an error, and the topic is then left out. */
function useEngine<T>(url: string) {
  const [state, setState] = useState<T | null>(null);
  const [missing, setMissing] = useState(false);
  const load = useCallback(() => api<T>(url).then((payload) => { setState(payload); setMissing(false); return payload; }), [url]);
  useEffect(() => { load().catch(() => setMissing(true)); }, [load]);
  return { state, setState, missing, load };
}

type Page = "conversion" | "metadata" | "copies" | "detection" | "jobs" | "hardware";

/** GET/PUT {prefix}/api/admin/jobs (engine 0.35+): when the queue works, and what is on it. */
interface JobsState {
  gate: { open: true } | { open: false; reason: "idle" | "night" };
  settings: { when: "now" | "idle" | "night"; nightStart: string; nightEnd: string; atOnce: number; perPerson: number; remoteMbps: number };
  jobs: { id: string; kind: "copy" | "keep" | "finish"; title: string; quality: number | null; state: "running" | "queued"; progress: number; paused: boolean }[];
}

export function VideoSettingsSection() {
  const { t } = useTranslation(["common", "controlAdmin", "control"]);
  const { apps, error } = useAppsStatus();
  const video = apps?.find((app) => app.id === "video") ?? null;
  // One reading of ?show= for the head and the pages: two would drift apart.
  const [show, go] = useQueryPage();
  const page = (["conversion", "metadata", "copies", "detection", "jobs", "hardware"] as const).find((name) => name === show) ?? null;

  const titles: Record<Page, string> = {
    conversion: t("controlAdmin:apps.conversion.title"),
    metadata: t("controlAdmin:apps.metadata.title"),
    copies: t("controlAdmin:apps.copies.title"),
    detection: t("controlAdmin:apps.detection.title"),
    jobs: t("controlAdmin:apps.jobs.title"),
    hardware: t("controlAdmin:apps.hardwareTest.title")
  };

  return (
    <>
      <ControlSectionHead
        section="videoSettings"
        icon={<Clapperboard size={30} />}
        iconClassName="blue"
        description={page ? undefined : t("controlAdmin:apps.videoSettings.description")}
        title={page ? titles[page] : undefined}
        back={show ? { href: queryPageHref(null), label: t("control:ui.back") } : undefined}
      />
      {error && <MessageBox tone="error" title={t("controlAdmin:apps.loadFailed")}>{error}</MessageBox>}
      {!apps && !error && <p className="muted">{t("controlAdmin:ui.loading")}</p>}
      {apps && video && isRunning(video) && <VideoSettings prefix={video.prefix} page={page} go={go} />}
      {apps && (!video || !isRunning(video)) && (
        <MessageBox tone="info" title={t("controlAdmin:apps.videoSettings.unavailableTitle")}>
          {video?.configured ? t("controlAdmin:apps.videoSettings.notAnswering") : t("controlAdmin:apps.videoSettings.notSetUp")}{" "}
          <a href={controlHref(video?.configured ? "dashboard" : "appsSetup")}>
            {video?.configured ? t("controlAdmin:apps.videoSettings.openDashboard") : t("controlAdmin:apps.videoSettings.openSetup")}
          </a>
        </MessageBox>
      )}
    </>
  );
}

/** The overview and the four topic pages, over one reading of each endpoint. */
export function VideoSettings({ prefix, page, go }: { prefix: string; page: Page | null; go: (page: Page | null) => void }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const conversion = useEngine<ConversionState>(`${prefix}/api/admin/conversion`);
  const metadata = useEngine<MetadataState>(`${prefix}/api/admin/metadata`);
  const copies = useEngine<CopiesState>(`${prefix}/api/admin/copies`);
  const detection = useEngine<DetectionState>(`${prefix}/api/admin/detection`);
  const jobs = useEngine<JobsState>(`${prefix}/api/admin/jobs`);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  /** Every change writes straight through and shows what the engine kept. */
  const write = async <T,>(work: () => Promise<T>, apply: (payload: T) => void, failed: string) => {
    setSaving(true);
    setError("");
    try {
      apply(await work());
    } catch (err) {
      setError(err instanceof Error ? err.message : failed);
    } finally {
      setSaving(false);
    }
  };

  const conversionUrl = `${prefix}/api/admin/conversion`;
  const saveConversion = (patch: Partial<ConversionSettings>) => {
    const current = conversion.state?.settings;
    if (!current) return;
    // An engine with `storage` answers the old words beside it, worked out from the
    // new; sent back they would read as a change, so it gets the new words alone.
    const { memoryPerViewerMb: _perViewer, whenFull: _whenFull, ...rest } = current;
    const body = current.storage ? { ...rest, ...patch } : { ...current, ...patch };
    void write(
      () => api<ConversionState>(conversionUrl, { method: "PUT", body: JSON.stringify(body) }),
      conversion.setState,
      t("controlAdmin:apps.conversion.saveFailed")
    );
  };
  const setDetection = (enabled: boolean) => void write(
    () => api<DetectionState>(`${prefix}/api/admin/detection`, { method: "PUT", body: JSON.stringify({ enabled }) }),
    detection.setState,
    t("controlAdmin:apps.detection.saveFailed")
  );

  const errors = error && <MessageBox tone="error" title={t("errors.unableToSave")}>{error}</MessageBox>;

  if (page === "conversion") {
    return conversion.state
      ? <ConversionPage url={conversionUrl} state={conversion.state} setState={conversion.setState} reload={conversion.load} saving={saving} errors={errors} onSave={saveConversion} />
      : <Waiting missing={conversion.missing} failed={t("controlAdmin:apps.conversion.loadFailed")} />;
  }
  if (page === "hardware") {
    return (
      <>
        {errors}
        <HardwareTestPage
          prefix={prefix}
          capabilities={conversion.state?.hardware ? <GpuRow hardware={conversion.state.hardware} /> : null}
          maxViewers={conversion.state?.settings.maxViewers ?? null}
          saving={saving}
          onUseLimit={(count) => saveConversion({ maxViewers: count })}
        />
      </>
    );
  }
  if (page === "metadata") {
    return metadata.state
      ? <MetadataPage url={`${prefix}/api/admin/metadata`} state={metadata.state} setState={metadata.setState} />
      : <Waiting missing={metadata.missing} failed={t("controlAdmin:apps.metadata.loadFailed")} />;
  }
  if (page === "copies") {
    return copies.state
      ? <CopiesPage url={`${prefix}/api/admin/copies`} state={copies.state} setState={copies.setState} />
      : <Waiting missing={copies.missing} failed={t("controlAdmin:apps.copies.loadFailed")} />;
  }
  if (page === "jobs") {
    return jobs.state && Array.isArray(jobs.state.jobs)
      ? <JobsPage url={`${prefix}/api/admin/jobs`} state={jobs.state} setState={jobs.setState} reload={jobs.load} />
      : <Waiting missing={jobs.missing} failed={t("controlAdmin:apps.jobs.loadFailed")} />;
  }
  if (page === "detection") {
    return detection.state
      ? <DetectionPage state={detection.state} saving={saving} errors={errors} onChange={setDetection} />
      : <Waiting missing={detection.missing} failed={t("controlAdmin:apps.detection.loadFailed")} />;
  }

  // ── The overview ───────────────────────────────────────────────────────────
  const conv = conversion.state;
  const quality = conv?.settings.remoteQuality;
  const det = detection.state;
  const cop = copies.state;
  const meta = metadata.state;

  return (
    <div className="grouped-page">
      {errors}
      {conv && !conv.available && (
        <MessageBox tone="warning" title={t("controlAdmin:apps.conversion.noFfmpegTitle")}>{t("controlAdmin:apps.conversion.noFfmpegBody")}</MessageBox>
      )}

      <GroupedList id="video-conversion" title={t("controlAdmin:apps.videoSettings.groupPlayback")} note={quality !== undefined ? t("controlAdmin:apps.videoSettings.remoteQualityNote") : undefined}>
        <NavRow
          icon={<Cpu size={17} />}
          iconTone={!conv ? "muted" : conv.available ? "ok" : "warn"}
          label={t("controlAdmin:apps.conversion.title")}
          sub={conv ? `${converterWord(conv, t)} · ${t("controlAdmin:apps.videoSettings.atOnce", { limit: conv.settings.maxViewers })}` : conversion.missing ? t("controlAdmin:apps.conversion.loadFailed") : t("controlAdmin:ui.loading")}
          value={conv ? t("controlAdmin:apps.videoSettings.watching", { now: conv.usage.viewers.length }) : undefined}
          onClick={() => go("conversion")}
        />
        {conv?.available && <HardwareTestRow prefix={prefix} onOpen={() => go("hardware")} />}
        {conv && quality !== undefined && (
          <PickerRow
            label={t("controlAdmin:apps.conversion.remoteQualityLabel")}
            value={quality === null ? "original" : String(quality)}
            options={REMOTE_QUALITIES.map((value) => ({
              value,
              label: value === "original" ? t("controlAdmin:apps.conversion.qualityOriginal") : t("controlAdmin:apps.conversion.qualityUpTo", { height: Number(value) })
            }))}
            disabled={saving}
            onChange={(value) => saveConversion({ remoteQuality: value === "original" ? null : Number(value) as 1080 | 720 | 480 })}
          />
        )}
      </GroupedList>

      {(meta || det) && (
        <GroupedList id="video-metadata" title={t("controlAdmin:apps.videoSettings.groupLibrary")}>
          {meta && (
            <NavRow
              icon={<ImageIcon size={17} />}
              iconTone={meta.hasKey ? "ok" : "muted"}
              label={t("controlAdmin:apps.metadata.title")}
              sub={t("controlAdmin:apps.videoSettings.metadataSub")}
              value={meta.hasKey ? t("controlAdmin:apps.videoSettings.tmdbSet") : t("controlAdmin:apps.videoSettings.tmdbNone")}
              onClick={() => go("metadata")}
            />
          )}
          {det && (
            <NavToggleRow
              icon={<SkipForward size={17} />}
              iconTone={det.available && det.enabled ? "ok" : "muted"}
              label={t("controlAdmin:apps.detection.title")}
              sub={detectionWord(det, t)}
              checked={det.enabled && det.available}
              disabled={saving || !det.available}
              toggleLabel={t("controlAdmin:apps.detection.label")}
              onToggle={setDetection}
              onClick={() => go("detection")}
            />
          )}
        </GroupedList>
      )}

      {cop && (
        <GroupedList id="video-copies" title={t("controlAdmin:apps.videoSettings.groupDownloads")}>
          <NavRow
            icon={<Download size={17} />}
            label={t("controlAdmin:apps.copies.title")}
            sub={t("controlAdmin:apps.videoSettings.copiesSub")}
            value={t("controlAdmin:apps.videoSettings.copiesValue", { used: formatBytes(cop.usedBytes), limit: `${cop.settings.limitGb} GB` })}
            onClick={() => go("copies")}
          />
          {jobs.state && Array.isArray(jobs.state.jobs) && (
            <NavRow
              icon={<Clock size={17} />}
              label={t("controlAdmin:apps.jobs.title")}
              sub={t(`controlAdmin:apps.jobs.when.${jobs.state.settings.when}`, { start: jobs.state.settings.nightStart, end: jobs.state.settings.nightEnd })}
              value={t("controlAdmin:apps.jobs.queued", { count: jobs.state.jobs.length })}
              onClick={() => go("jobs")}
            />
          )}
        </GroupedList>
      )}
    </div>
  );
}

function Waiting({ missing, failed }: { missing: boolean; failed: string }) {
  const { t } = useTranslation(["controlAdmin"]);
  return <div className="grouped-page"><p className="muted">{missing ? failed : t("controlAdmin:ui.loading")}</p></div>;
}

type T = TFunction<["common", "controlAdmin"]>;

/** Where it converts, in a word or two: the GPU, the CPU, or nothing at all. */
function converterWord(state: ConversionState, t: T): string {
  if (!state.available) return t("controlAdmin:apps.videoSettings.conversionNone");
  const hardware = state.hardware;
  return hardware && hardware.mode !== "cpu" && hardware.encode && !hardware.setAside
    ? t("controlAdmin:apps.videoSettings.conversionGpu")
    : t("controlAdmin:apps.videoSettings.conversionCpu");
}

function detectionWord(state: DetectionState, t: T): string {
  if (!state.available) return t("controlAdmin:apps.detection.unavailableTitle");
  if (!state.enabled) return t("controlAdmin:apps.videoSettings.detectionOff");
  return state.working ? t("controlAdmin:apps.videoSettings.detectionWorking", { title: state.working }) : t("controlAdmin:apps.videoSettings.detectionIdle");
}

// ── Converting video ─────────────────────────────────────────────────────────

/** What the GPU does here, as one row: found and used, set aside, or not there. */
function GpuRow({ hardware }: { hardware: HardwareState }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  if (hardware.mode === "cpu") {
    return <InfoRow icon={<Cpu size={17} />} iconTone="muted" label={t("controlAdmin:apps.conversion.gpuOffTitle")} sub={t("controlAdmin:apps.conversion.gpuOffBody")} />;
  }
  if (hardware.checking && !hardware.encode && !hardware.error) {
    return <InfoRow icon={<Cpu size={17} />} iconTone="muted" label={t("controlAdmin:apps.conversion.checking")} sub={t("controlAdmin:apps.conversion.gpuCheckingBody")} />;
  }
  if (!hardware.encode) {
    return <InfoRow icon={<Cpu size={17} />} iconTone={hardware.mode === "gpu" ? "warn" : "muted"} label={t("controlAdmin:apps.conversion.gpuNoneTitle")} sub={hardware.error ?? t("controlAdmin:apps.conversion.gpuNoneBody")} />;
  }
  const codecs = hardware.decode.map((codec) => CODEC_NAMES[codec] ?? codec).join(", ");
  const where = [hardware.device, hardware.driver].filter(Boolean).join(" · ");
  if (hardware.setAside) {
    return <InfoRow icon={<Cpu size={17} />} iconTone="warn" label={t("controlAdmin:apps.conversion.gpuSetAsideTitle")} sub={t("controlAdmin:apps.conversion.gpuSetAsideBody", { where })} />;
  }
  const lines = [
    where,
    codecs ? t("controlAdmin:apps.conversion.gpuDecodes", { codecs }) : t("controlAdmin:apps.conversion.gpuDecodesNone"),
    // An engine before 0.25 says nothing of either: no line.
    hardware.tonemap === undefined ? null : hardware.tonemap ? t("controlAdmin:apps.conversion.gpuTonemap") : t("controlAdmin:apps.conversion.gpuTonemapCpu"),
    hardware.overlay === undefined ? null : hardware.overlay ? t("controlAdmin:apps.conversion.gpuOverlay") : t("controlAdmin:apps.conversion.gpuOverlayCpu")
  ].filter((line): line is string => Boolean(line));
  return (
    <InfoRow
      icon={<Cpu size={17} />}
      iconTone="ok"
      label={t("controlAdmin:apps.conversion.gpuFoundTitle")}
      sub={<>{lines.map((line, index) => <span key={index} className="storage-row-path">{line}</span>)}</>}
    />
  );
}

function ConversionPage({ url, state, setState, reload, saving, errors, onSave }: {
  url: string;
  state: ConversionState;
  setState: (state: ConversionState) => void;
  reload: () => Promise<ConversionState>;
  saving: boolean;
  errors: ReactNode;
  onSave: (patch: Partial<ConversionSettings>) => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [checking, setChecking] = useState(false);
  const [viewers, setViewers] = useState(String(state.settings.maxViewers));
  const [memory, setMemory] = useState(String(state.settings.memoryPerViewerMb));
  const [pool, setPool] = useState(String(state.settings.memoryMb ?? ""));
  useEffect(() => setViewers(String(state.settings.maxViewers)), [state.settings.maxViewers]);
  useEffect(() => setMemory(String(state.settings.memoryPerViewerMb)), [state.settings.memoryPerViewerMb]);
  useEffect(() => setPool(String(state.settings.memoryMb ?? "")), [state.settings.memoryMb]);

  // Who is watching changes by the minute: the page keeps itself current while open.
  useEffect(() => {
    const timer = window.setInterval(() => { reload().catch(() => undefined); }, 5000);
    return () => window.clearInterval(timer);
  }, [reload]);

  // Check again: the engine tries the GPU afresh (and forgets its failures).
  const check = async () => {
    setChecking(true);
    try {
      setState(await api<ConversionState>(`${url}/check`, { method: "POST" }));
    } catch {
      /* the row keeps saying what it last knew */
    } finally {
      setChecking(false);
    }
  };

  /** A number left blank or out of range goes back to what the engine has. */
  const commit = (raw: string, current: number, min: number, max: number, key: "maxViewers" | "memoryPerViewerMb" | "memoryMb", reset: (value: string) => void) => {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(value) || value < min || value > max) { reset(String(current)); return; }
    if (value !== current) onSave({ [key]: value });
  };

  const usage = state.usage;
  const memoryMb = Number(memory) || 0;
  // Engine 0.35+: one memory pool and a storage mode; older ones per viewer.
  const storage = state.settings.storage;
  const disk = state.disk;
  const inForce = state.storage ?? storage;
  const storageWord: Record<ConversionStorage, string> = {
    memory: t("controlAdmin:apps.conversion.storageMemory"),
    "memory-disk": t("controlAdmin:apps.conversion.storageMemoryDisk"),
    disk: t("controlAdmin:apps.conversion.storageDisk")
  };

  return (
    <div className="grouped-page">
      {errors}
      {!state.available && (
        <MessageBox tone="warning" title={t("controlAdmin:apps.conversion.noFfmpegTitle")}>{t("controlAdmin:apps.conversion.noFfmpegBody")}</MessageBox>
      )}

      {state.hardware && (
        <GroupedList note={storage ? t("controlAdmin:apps.conversion.introStorage") : t("controlAdmin:apps.conversion.intro")}>
          <GpuRow hardware={state.hardware} />
          <ActionRow
            label={checking || state.hardware.checking ? t("controlAdmin:apps.conversion.checking") : t("controlAdmin:apps.conversion.checkAgain")}
            disabled={checking || state.hardware.checking}
            onClick={() => void check()}
          />
          {state.available && <NavRow icon={<Gauge size={17} />} label={t("controlAdmin:apps.hardwareTest.linkFromConversion")} href={queryPageHref("hardware")} />}
        </GroupedList>
      )}

      <GroupedList title={t("controlAdmin:apps.conversion.nowLabel")}>
        <InfoRow label={t("controlAdmin:apps.conversion.watching")} value={t("controlAdmin:apps.conversion.watchingValue", { now: usage.viewers.length, limit: state.settings.maxViewers })} />
        {usage.viewers.map((viewer, index) => (
          <InfoRow
            key={`${viewer.user}-${index}`}
            label={viewer.user}
            sub={[
              viewer.title,
              viewer.mode === "transcode" ? t("controlAdmin:apps.conversion.modeTranscode") : t("controlAdmin:apps.conversion.modeRemux"),
              viewer.converter ? (viewer.converter === "gpu" ? t("controlAdmin:apps.conversion.onGpu") : t("controlAdmin:apps.conversion.onCpu")) : null,
              viewer.hdr ? t("controlAdmin:apps.conversion.hdr") : null,
              viewer.rung ? t("controlAdmin:apps.conversion.rung", { height: viewer.rung }) : null,
              viewer.kept ? t("controlAdmin:apps.conversion.keptFilm") : null,
              viewer.shared ? t("controlAdmin:apps.conversion.shared") : null,
              viewer.converting || viewer.kept ? null : t("controlAdmin:apps.conversion.paused")
            ].filter(Boolean).join(" · ")}
            value={formatBytes(viewer.memoryBytes + viewer.diskBytes)}
          />
        ))}
        <InfoRow label={t("controlAdmin:apps.conversion.inMemory")} value={formatBytes(usage.memoryBytes)} />
        <InfoRow label={t("controlAdmin:apps.conversion.onDisk")} value={formatBytes(usage.diskBytes)} />
        {usage.kept && (
          <InfoRow label={t("controlAdmin:apps.conversion.keptLabel")} value={t("controlAdmin:apps.conversion.keptValue", { count: usage.kept.count, size: formatBytes(usage.kept.bytes) })} />
        )}
      </GroupedList>

      {state.settings.hardware && (
        <GroupedList note={t("controlAdmin:apps.conversion.hardwareHelp")}>
          <PickerRow
            label={t("controlAdmin:apps.conversion.hardwareLabel")}
            value={state.settings.hardware}
            disabled={saving}
            options={[
              { value: "auto", label: t("controlAdmin:apps.conversion.hardwareAuto") },
              { value: "cpu", label: t("controlAdmin:apps.conversion.hardwareCpu") },
              { value: "gpu", label: t("controlAdmin:apps.conversion.hardwareGpu") }
            ]}
            onChange={(value) => onSave({ hardware: value as HardwareMode })}
          />
        </GroupedList>
      )}

      {storage && disk && (
        <GroupedList id="video-conversion-storage" title={t("controlAdmin:apps.conversion.storageTitle")} note={t("controlAdmin:apps.conversion.storageHelp")}>
          {disk.mapped ? (
            <InfoRow
              icon={<HardDrive size={17} />}
              iconTone="ok"
              label={t("controlAdmin:apps.conversion.diskLabel")}
              sub={<span className="storage-row-path">{disk.folder}</span>}
              value={disk.freeBytes !== null
                ? t("controlAdmin:apps.conversion.diskFree", { free: formatBytes(disk.freeBytes) })
                : undefined}
            />
          ) : (
            <InfoRow
              icon={<HardDrive size={17} />}
              iconTone="muted"
              label={t("controlAdmin:apps.conversion.diskNoneTitle")}
              sub={t("controlAdmin:apps.conversion.diskNoneBody")}
            />
          )}
          <PickerRow
            label={t("controlAdmin:apps.conversion.storageLabel")}
            value={inForce ?? storage}
            disabled={saving || !disk.mapped}
            options={STORAGES.map((value) => ({ value, label: storageWord[value], disabled: !disk.mapped && value !== "memory" }))}
            onChange={(value) => onSave({ storage: value as ConversionStorage })}
          />
          {inForce !== "disk" && (
            <InputRow
              label={t("controlAdmin:apps.conversion.memoryPoolLabel")}
              sub={t("controlAdmin:apps.conversion.memoryPoolHelp")}
              type="number"
              min={64}
              max={16384}
              value={pool}
              disabled={saving}
              onChange={setPool}
              onCommit={() => commit(pool, state.settings.memoryMb ?? 0, 64, 16384, "memoryMb", setPool)}
            />
          )}
        </GroupedList>
      )}

      {storage ? (
        <GroupedList title={t("controlAdmin:apps.videoSettings.groupLimits")} note={t("controlAdmin:apps.conversion.viewersHelp")}>
          <InputRow
            label={t("controlAdmin:apps.conversion.viewersLabel")}
            type="number"
            min={1}
            max={50}
            value={viewers}
            disabled={saving}
            onChange={setViewers}
            onCommit={() => commit(viewers, state.settings.maxViewers, 1, 50, "maxViewers", setViewers)}
          />
        </GroupedList>
      ) : (
        <>
        <GroupedList
          title={t("controlAdmin:apps.videoSettings.groupLimits")}
          note={<>
            {t("controlAdmin:apps.conversion.viewersHelp")}{" "}
            {memoryMb === 0
              ? t("controlAdmin:apps.conversion.totalDiskOnly")
              : t("controlAdmin:apps.conversion.total", { memory: formatBytes(memoryMb * (Number(viewers) || 0) * 1024 * 1024) })}
          </>}
        >
          <InputRow
            label={t("controlAdmin:apps.conversion.viewersLabel")}
            type="number"
            min={1}
            max={50}
            value={viewers}
            disabled={saving}
            onChange={setViewers}
            onCommit={() => commit(viewers, state.settings.maxViewers, 1, 50, "maxViewers", setViewers)}
          />
          <InputRow
            label={t("controlAdmin:apps.conversion.memoryLabel")}
            sub={t("controlAdmin:apps.conversion.memoryHelp")}
            type="number"
            min={0}
            max={16384}
            value={memory}
            disabled={saving}
            onChange={setMemory}
            onCommit={() => commit(memory, state.settings.memoryPerViewerMb, 0, 16384, "memoryPerViewerMb", setMemory)}
          />
          <PickerRow
            label={t("controlAdmin:apps.conversion.whenFullLabel")}
            sub={t("controlAdmin:apps.conversion.whenFullHelp")}
            value={state.settings.whenFull}
            disabled={saving || state.settings.memoryPerViewerMb === 0}
            options={[
              { value: "disk", label: t("controlAdmin:apps.conversion.whenFullDisk") },
              { value: "wait", label: t("controlAdmin:apps.conversion.whenFullWait") }
            ]}
            onChange={(value) => onSave({ whenFull: value as ConversionSettings["whenFull"] })}
          />
        </GroupedList>
        </>
      )}
    </div>
  );
}

// ── When downloads are prepared (C4) ─────────────────────────────────────────

// The queue the video app makes copies for download, kept-ready titles and
// finished-off films on: when it works (right away, when the server is quiet, or
// at night), how many at once, how many copies a member may have waiting, and how
// fast a copy goes to someone away from home. Below, what runs and waits, with
// the admin's hand on each.
function JobsPage({ url, state, setState, reload }: { url: string; state: JobsState; setState: (state: JobsState) => void; reload: () => Promise<JobsState> }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const settings = state.settings;
  const [start, setStart] = useState(settings.nightStart);
  const [end, setEnd] = useState(settings.nightEnd);
  const [atOnce, setAtOnce] = useState(String(settings.atOnce));
  const [perPerson, setPerPerson] = useState(String(settings.perPerson));
  const [speed, setSpeed] = useState(String(settings.remoteMbps));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setStart(settings.nightStart);
    setEnd(settings.nightEnd);
    setAtOnce(String(settings.atOnce));
    setPerPerson(String(settings.perPerson));
    setSpeed(String(settings.remoteMbps));
  }, [settings]);

  // What runs moves along: the page keeps itself current while open.
  useEffect(() => {
    const timer = window.setInterval(() => { reload().catch(() => undefined); }, 5000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const run = async (work: () => Promise<JobsState>) => {
    setBusy(true);
    setError("");
    try {
      setState(await work());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:apps.jobs.saveFailed"));
    } finally {
      setBusy(false);
    }
  };
  const save = (patch: Partial<JobsState["settings"]>) => void run(() => api<JobsState>(url, { method: "PUT", body: JSON.stringify(patch) }));
  /** A number left blank or out of range goes back to what the engine has. */
  const commitNumber = (raw: string, current: number, min: number, max: number, key: "atOnce" | "perPerson" | "remoteMbps", reset: (value: string) => void, whole = true) => {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value) || (whole && !Number.isInteger(value)) || value < min || value > max) { reset(String(current)); return; }
    if (value !== current) save({ [key]: value });
  };
  const commitTime = (raw: string, current: string, key: "nightStart" | "nightEnd", reset: (value: string) => void) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) { reset(current); return; }
    if (raw !== current) save({ [key]: raw });
  };
  const act = (path: "top" | "run", id: string) => void run(() => api<JobsState>(`${url}/${path}`, { method: "POST", body: JSON.stringify({ id }) }));
  const cancel = (id: string) => void run(() => api<JobsState>(`${url}?id=${encodeURIComponent(id)}`, { method: "DELETE" }));

  return (
    <div className="grouped-page">
      {error && <MessageBox tone="error" title={t("errors.unableToSave")}>{error}</MessageBox>}
      <GroupedList id="video-jobs" note={t("controlAdmin:apps.jobs.intro")}>
        <PickerRow
          label={t("controlAdmin:apps.jobs.whenLabel")}
          value={settings.when}
          disabled={busy}
          options={(["now", "idle", "night"] as const).map((value) => ({ value, label: t(`controlAdmin:apps.jobs.whenOption.${value}`) }))}
          onChange={(value) => save({ when: value as JobsState["settings"]["when"] })}
        />
        {settings.when === "night" && (
          <>
            <InputRow label={t("controlAdmin:apps.jobs.nightStart")} type="time" value={start} disabled={busy} onChange={setStart} onCommit={() => commitTime(start, settings.nightStart, "nightStart", setStart)} />
            <InputRow label={t("controlAdmin:apps.jobs.nightEnd")} type="time" value={end} disabled={busy} onChange={setEnd} onCommit={() => commitTime(end, settings.nightEnd, "nightEnd", setEnd)} />
          </>
        )}
        {!state.gate.open && <InfoRow label={t(`controlAdmin:apps.jobs.gate.${state.gate.reason}`)} />}
      </GroupedList>

      <GroupedList title={t("controlAdmin:apps.videoSettings.groupLimits")} note={t("controlAdmin:apps.jobs.limitsNote")}>
        <InputRow label={t("controlAdmin:apps.jobs.atOnce")} type="number" min={1} max={4} value={atOnce} disabled={busy} onChange={setAtOnce}
          onCommit={() => commitNumber(atOnce, settings.atOnce, 1, 4, "atOnce", setAtOnce)} />
        <InputRow label={t("controlAdmin:apps.jobs.perPerson")} sub={t("controlAdmin:apps.jobs.perPersonNote")} type="number" min={1} max={1000} value={perPerson} disabled={busy} onChange={setPerPerson}
          onCommit={() => commitNumber(perPerson, settings.perPerson, 1, 1000, "perPerson", setPerPerson)} />
        <InputRow label={t("controlAdmin:apps.jobs.remoteMbps")} sub={t("controlAdmin:apps.jobs.remoteMbpsNote")} type="number" min={0} max={10000} value={speed} disabled={busy} onChange={setSpeed}
          onCommit={() => commitNumber(speed, settings.remoteMbps, 0, 10000, "remoteMbps", setSpeed, false)} />
      </GroupedList>

      <GroupedList title={t("controlAdmin:apps.jobs.queueTitle")}>
        {state.jobs.length === 0 && <InfoRow label={t("controlAdmin:apps.jobs.queueEmpty")} />}
        {state.jobs.map((job) => (
          <div key={job.id} className="grouped-row video-job-row">
            <span className="grouped-row-label">
              <strong>{job.title}</strong>
              <small>{[
                t(`controlAdmin:apps.jobs.kind.${job.kind}`),
                job.quality ? t("controlAdmin:apps.conversion.rung", { height: job.quality }) : null,
                job.state === "running"
                  ? (job.paused ? t("controlAdmin:apps.jobs.paused") : t("controlAdmin:apps.jobs.running", { percent: Math.round(job.progress * 100) }))
                  : t("controlAdmin:apps.jobs.waiting")
              ].filter(Boolean).join(" · ")}</small>
            </span>
            <ActionMenu
              trigger="icon"
              label={t("controlAdmin:apps.jobs.menu", { title: job.title })}
              items={[
                ...(job.state === "queued" ? [
                  { key: "run", label: t("controlAdmin:apps.jobs.runNow"), onSelect: () => act("run", job.id) },
                  { key: "top", label: t("controlAdmin:apps.jobs.toTop"), onSelect: () => act("top", job.id) }
                ] : []),
                { key: "cancel", label: t("controlAdmin:apps.jobs.cancel"), onSelect: () => cancel(job.id) }
              ]}
            />
          </div>
        ))}
      </GroupedList>
    </div>
  );
}

// ── Posters and descriptions ─────────────────────────────────────────────────

// Art beside the files is always used; with a key from the admin's own TMDB account
// the engine fetches the rest. The engine checks a key with TMDB before keeping it,
// and never hands it back.
function MetadataPage({ url, state, setState }: { url: string; state: MetadataState; setState: (state: MetadataState) => void }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState("");

  const put = async (tmdbKey: string | null) => {
    setBusy(tmdbKey ? "save" : "remove");
    setSaved("");
    setSaveError("");
    try {
      setState(await api<MetadataState>(url, { method: "PUT", body: JSON.stringify({ tmdbKey }) }));
      setKey("");
      setSaved(tmdbKey ? t("controlAdmin:apps.metadata.savedKey") : t("controlAdmin:apps.metadata.removedKey"));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("controlAdmin:apps.metadata.saveFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grouped-page">
      {saveError && <MessageBox tone="error" title={t("errors.unableToSave")}>{saveError}</MessageBox>}
      {saved && <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{saved}</MessageBox>}
      <GroupedList note={t("controlAdmin:apps.metadata.intro")}>
        <InfoRow
          icon={<KeyRound size={17} />}
          iconTone={state.hasKey ? "ok" : "muted"}
          label={state.hasKey ? t("controlAdmin:apps.metadata.hasKey", { hint: state.keyHint }) : t("controlAdmin:apps.metadata.noKey")}
        />
      </GroupedList>
      <GroupedList
        note={<Trans
          i18nKey="apps.metadata.keyHelp"
          ns="controlAdmin"
          components={{ link: <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer noopener" /> }}
        />}
      >
        <InputRow
          label={state.hasKey ? t("controlAdmin:apps.metadata.replaceLabel") : t("controlAdmin:apps.metadata.keyLabel")}
          type="password"
          value={key}
          onChange={setKey}
          disabled={busy !== null}
          wide
        />
        <ActionRow
          label={busy === "save" ? t("controlAdmin:apps.metadata.checking") : t("controlAdmin:apps.metadata.save")}
          disabled={busy !== null || !key.trim()}
          onClick={() => void put(key.trim())}
        />
      </GroupedList>
      {state.hasKey && (
        <GroupedList>
          <ActionRow
            tone="danger"
            label={busy === "remove" ? t("controlAdmin:apps.metadata.removing") : t("controlAdmin:apps.metadata.remove")}
            disabled={busy !== null}
            onClick={() => void put(null)}
          />
        </GroupedList>
      )}
    </div>
  );
}

// ── Copies for download ──────────────────────────────────────────────────────

// A smaller MP4 of a film, prepared when someone asks to keep it on a phone or tablet,
// and kept for whoever asks next: how much room they may take together, what they
// take now, and Remove all.
function CopiesPage({ url, state, setState }: { url: string; state: CopiesState; setState: (state: CopiesState) => void }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  // Engine 0.35+: the titles kept ready; an older engine answers 404 and the group stays away.
  const [keepReady, setKeepReady] = useState<KeepReadyState | null>(null);
  useEffect(() => {
    let live = true;
    api<KeepReadyState>(KEEP_READY_URL).then((answer) => { if (live && Array.isArray(answer?.titles)) setKeepReady(answer); }, () => undefined);
    return () => { live = false; };
  }, []);
  const [limit, setLimit] = useState(String(state.settings.limitGb));
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [saveError, setSaveError] = useState("");
  useEffect(() => setLimit(String(state.settings.limitGb)), [state.settings.limitGb]);

  const run = async (work: () => Promise<CopiesState>) => {
    setBusy(true);
    setSaveError("");
    try {
      setState(await work());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("controlAdmin:apps.copies.saveFailed"));
    } finally {
      setBusy(false);
      setClearing(false);
    }
  };

  const commitLimit = () => {
    const wanted = Number(limit);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 10_000) { setLimit(String(state.settings.limitGb)); return; }
    if (wanted !== state.settings.limitGb) void run(() => api<CopiesState>(url, { method: "PUT", body: JSON.stringify({ limitGb: wanted }) }));
  };

  const ready = state.copies.filter((copy) => copy.state === "ready").length;
  const waiting = state.copies.filter((copy) => copy.state === "queued" || copy.state === "running").length;
  const making = state.copies.find((copy) => copy.state === "running");

  return (
    <div className="grouped-page">
      {saveError && <MessageBox tone="error" title={t("errors.unableToSave")}>{saveError}</MessageBox>}
      {state.insideContainer && (
        <MessageBox tone="warning" title={t("controlAdmin:apps.copies.insideTitle")}>
          {t("controlAdmin:apps.copies.insideBody", { used: formatBytes(state.usedBytes) })}
        </MessageBox>
      )}
      <GroupedList note={t("controlAdmin:apps.copies.intro")}>
        <InfoRow
          icon={<Download size={17} />}
          label={t("controlAdmin:apps.copies.usage", { count: ready, used: formatBytes(state.usedBytes), limit: `${state.settings.limitGb} GB` })}
          sub={waiting > 0
            ? (making ? t("controlAdmin:apps.copies.making", { title: making.title, count: waiting }) : t("controlAdmin:apps.copies.waiting", { count: waiting }))
            : undefined}
        />
      </GroupedList>
      {state.kept && (
        <GroupedList title={t("controlAdmin:apps.copies.keptTitle")} note={t("controlAdmin:apps.copies.keptNote")}>
          <InfoRow
            label={state.kept.length > 0
              ? t("controlAdmin:apps.copies.keptCount", { count: state.kept.length, size: formatBytes(state.keptBytes ?? 0) })
              : t("controlAdmin:apps.copies.keptNone")}
          />
          {state.kept.map((film) => (
            <InfoRow
              key={film.variant}
              label={film.title}
              sub={[film.rung ? t("controlAdmin:apps.conversion.rung", { height: film.rung }) : null, film.inUse ? t("controlAdmin:apps.copies.watchingNow") : null].filter(Boolean).join(" · ") || undefined}
              value={formatBytes(film.sizeBytes)}
            />
          ))}
        </GroupedList>
      )}
      {keepReady && (
        <GroupedList title={t("controlAdmin:apps.copies.keepReadyTitle")} note={keepReady.available ? t("controlAdmin:apps.copies.keepReadyNote") : t("controlAdmin:apps.copies.keepReadyUnavailable")}>
          {keepReady.titles.length === 0 && <InfoRow label={t("controlAdmin:apps.copies.keepReadyNone")} />}
          {keepReady.titles.map((title) => (
            <NavRow
              key={title.id}
              label={title.title}
              sub={[
                title.rungs.map((rung) => t("controlAdmin:apps.conversion.rung", { height: rung })).join(", "),
                t("controlAdmin:apps.copies.keepReadyProgress", { ready: title.ready, total: title.total - title.asIs - title.missing }),
                title.making ? t("controlAdmin:apps.copies.keepReadyMaking", { percent: Math.round(title.making.progress * 100) }) : null
              ].filter(Boolean).join(" · ")}
              value={formatBytes(title.sizeBytes)}
              href={title.kind === "movie" ? `/movies/${encodeURIComponent(title.targetId)}` : `/shows/${encodeURIComponent(title.targetId)}`}
            />
          ))}
        </GroupedList>
      )}
      <GroupedList note={t("controlAdmin:apps.copies.folder", { folder: state.folder })}>
        <InputRow
          label={state.kept ? t("controlAdmin:apps.copies.limitLabelShared") : t("controlAdmin:apps.copies.limitLabel")}
          type="number"
          min={1}
          max={10000}
          value={limit}
          disabled={busy}
          onChange={setLimit}
          onCommit={commitLimit}
        />
      </GroupedList>
      {(state.copies.length > 0 || (state.kept?.length ?? 0) > 0) && (
        <GroupedList>
          <ActionRow tone="danger" label={state.kept ? t("controlAdmin:apps.copies.clearAll") : t("controlAdmin:apps.copies.clear")} disabled={busy} onClick={() => setClearing(true)} />
        </GroupedList>
      )}
      {clearing && (
        <ConfirmDialog
          title={state.kept ? t("controlAdmin:apps.copies.clearAllTitle") : t("controlAdmin:apps.copies.clearTitle")}
          confirmLabel={state.kept ? t("controlAdmin:apps.copies.clearAllConfirm") : t("controlAdmin:apps.copies.clearConfirm")}
          busyLabel={t("controlAdmin:apps.copies.clearing")}
          busy={busy}
          danger
          onConfirm={() => void run(() => api<CopiesState>(url, { method: "DELETE" }))}
          onCancel={() => setClearing(false)}
        >
          {state.kept ? t("controlAdmin:apps.copies.clearAllBody") : t("controlAdmin:apps.copies.clearBody")}
        </ConfirmDialog>
      )}
    </div>
  );
}

// ── Intros, recaps and credits ───────────────────────────────────────────────

// Finding them by itself (engine 0.18.0+): the engine reads every episode's sound and
// picture once, after each scan. On unless turned off; marks set by hand, .edl files
// and chapters count either way.
function DetectionPage({ state, saving, errors, onChange }: { state: DetectionState; saving: boolean; errors: ReactNode; onChange: (enabled: boolean) => void }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  return (
    <div className="grouped-page">
      {errors}
      <GroupedList note={t("controlAdmin:apps.detection.intro")}>
        <ToggleRow
          label={t("controlAdmin:apps.detection.label")}
          checked={state.enabled && state.available}
          disabled={saving || !state.available}
          onChange={onChange}
        />
        <InfoRow
          icon={<SkipForward size={17} />}
          iconTone={state.available && state.enabled ? "ok" : "muted"}
          label={!state.available
            ? t("controlAdmin:apps.detection.unavailable")
            : !state.enabled
              ? t("controlAdmin:apps.detection.offHint")
              : state.working
                ? t("controlAdmin:apps.detection.working", { title: state.working })
                : t("controlAdmin:apps.detection.idle")}
        />
      </GroupedList>
    </div>
  );
}
