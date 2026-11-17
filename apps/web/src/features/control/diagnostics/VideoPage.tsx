import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Archive, ArrowRight, Check, Cpu, FileText, Gauge, HardDrive, MemoryStick, Minus, MonitorPlay, Network, RefreshCw, Server, Settings2 } from "lucide-react";
import { api } from "../../../api";
import { controlHref, diagnosticsPartHref, followRoute, libraryManageHref, type DiagnosticsTab } from "../../../router";
import { Button } from "../../../shared/Button";
import { GroupedList, InfoRow, NavRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { RouteTab } from "../../../shared/RouteTab";
import { StatTiles, type StatTile } from "../../../shared/StatTiles";
import { relativeTime } from "../../../shared/relativeTime";
import { formatBytes } from "../../../shared/utils";
import { AppLog, isRunning, useAppsStatus } from "../sections/AppsSection";
import { NowPlayingList } from "../sections/NowPlayingSection";
import { HardwareTestPage } from "../sections/VideoHardwareTest";
import { CODEC_NAMES, conversionBody, GpuRow, useEngine, type ConversionSettings, type ConversionState, type HardwareState } from "../sections/VideoSettingsSection";
import { SavedReports, useSavedReports } from "./SavedReports";
import { useWatching, type Play } from "./Watching";

// Diagnostics › Video (docs/diagnostics-pages-plan.md; redrawn 2026-11-17 with tabs,
// the one part page allowed a row of them): Overview — cards of how things stand,
// looked at again every 30 seconds, then the hardware and the formats it plays — with
// diagnostic mode and the newest saved reports in a narrow column; Live sessions —
// the machine right now as graphs (read every 5 seconds while open, kept nowhere but
// here), then everything being watched; then GPU tests, Logs and Reports, each the
// page those already are, not a copy.

const TABS: DiagnosticsTab[] = ["overview", "tests", "sessions", "logs", "reports"];

export function VideoPartBody({ tab, saved, modeCard, logLinks }: {
  tab: DiagnosticsTab;
  /** Saved reports with Video in them: the part page's, so a report saved there shows. */
  saved: ReturnType<typeof useSavedReports>;
  /** Diagnostic mode (Normal · Detailed · Full), the part page's own card. */
  modeCard: ReactNode;
  /** Where else to look: its log, activity and tasks pages. */
  logLinks: ReactNode;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const { apps } = useAppsStatus();
  const video = apps?.find((app) => app.id === "video") ?? null;
  const prefix = video && isRunning(video) ? video.prefix : null;
  const watching = useWatching(prefix);
  const sessions = watching.plays ? watching.plays.filter((play) => play.kind !== "download").length : null;

  const tabLabel = (id: DiagnosticsTab) => {
    const count = id === "sessions" ? sessions : id === "reports" ? saved.reports?.length ?? null : null;
    return (
      <>
        {t(`controlAdmin:diagnostics.video.tab.${id}`)}
        {count ? <span className="diag-tab-count">{count}</span> : null}
      </>
    );
  };

  return (
    <>
      <div className="control-tabs diag-video-tabs" role="tablist" aria-label={t("controlAdmin:diagnostics.video.tabsAria")}>
        {TABS.map((id) => (
          <RouteTab key={id} selected={id === tab} className={id === tab ? "active" : undefined} href={diagnosticsPartHref("video", id)} onClick={followRoute}>
            {tabLabel(id)}
          </RouteTab>
        ))}
      </div>

      {apps && !prefix && (
        <MessageBox tone="info" title={t("controlAdmin:diagnostics.page.video.unavailableTitle")}>{t("controlAdmin:diagnostics.page.video.unavailable")}</MessageBox>
      )}

      {tab === "overview" && prefix && <Overview prefix={prefix} plays={watching.plays} saved={saved} modeCard={modeCard} />}
      {tab === "tests" && prefix && <TestsTab prefix={prefix} />}
      {tab === "sessions" && prefix && <SessionsTab prefix={prefix} plays={watching.plays} missing={watching.missing} />}
      {tab === "logs" && (
        <div className="diag-video">
          <div className="diag-video-main">{prefix && <AppLog prefix={prefix} />}</div>
          <aside className="diag-video-side">
            {modeCard}
            {logLinks}
          </aside>
        </div>
      )}
      {tab === "reports" && <SavedReports saved={saved} />}
    </>
  );
}

// ── Overview ───────────────────────────────────────────────────────────────────

/** How often the Overview's cards look again: a snapshot, not a live graph. */
const OVERVIEW_MS = 30_000;

function Overview({ prefix, plays, saved, modeCard }: { prefix: string; plays: Play[] | null; saved: ReturnType<typeof useSavedReports>; modeCard: ReactNode }) {
  const conversion = useEngine<ConversionState>(`${prefix}/api/admin/conversion`);
  const server = useServerNow(OVERVIEW_MS);
  const { load } = conversion;
  useEffect(() => {
    const timer = window.setInterval(() => void load().catch(() => undefined), OVERVIEW_MS);
    return () => window.clearInterval(timer);
  }, [load]);
  // The plays as they were at the last look, kept until the next one.
  const [snapshot, setSnapshot] = useState<{ at: string | null; plays: Play[] | null }>({ at: null, plays: null });
  const at = server.now?.at ?? null;
  if ((at !== snapshot.at && plays) || (snapshot.plays === null && plays)) setSnapshot({ at, plays });
  return (
    <div className="diag-video">
      <div className="diag-video-main">
        <OverviewTiles conversion={conversion.state} now={server.now} plays={snapshot.plays} />
        <HardwareCard prefix={prefix} conversion={conversion} now={server.now} />
        <CatalogWork prefix={prefix} />
      </div>
      <aside className="diag-video-side">
        {modeCard}
        <SavedMini saved={saved} />
      </aside>
    </div>
  );
}

/** The Overview's cards: the machine, who is watching and how much goes out, and
 *  what conversions may use and hold — as of the last look, every 30 seconds. */
function OverviewTiles({ conversion, now, plays }: { conversion: ConversionState | null; now: ServerNow | null; plays: Play[] | null }) {
  const { t, i18n } = useTranslation(["controlAdmin"]);
  const streams = (plays ?? []).filter((play) => play.kind !== "download");
  const converting = streams.filter((play) => play.kind === "converted" && play.converting && play.converter !== null && !play.kept).length;
  const sending = Math.round((plays ?? []).reduce((sum, play) => sum + (play.mbps ?? 0), 0) * 10) / 10;
  const settings = conversion?.settings;
  const usage = conversion?.usage;
  const disk = conversion?.disk;
  const mode = settings?.hardware ?? "auto";
  const dash = "—";
  const tiles: StatTile[] = [
    {
      icon: <Cpu size={19} />, iconTone: "blue",
      label: t("controlAdmin:diagnostics.video.tiles.cpu"),
      value: now ? `${Math.round(now.cpu.percent)}%` : dash,
      sub: now ? t("controlAdmin:diagnostics.video.hw.threads", { count: now.cpu.cores }) : undefined,
      tone: now && now.cpu.percent >= 90 ? "warn" : undefined
    },
    {
      icon: <MonitorPlay size={19} />, iconTone: "mint",
      label: t("controlAdmin:diagnostics.video.tiles.sessions"),
      value: plays ? String(streams.length) : dash,
      sub: plays ? (converting > 0 ? t("controlAdmin:diagnostics.video.tiles.converting", { count: converting }) : streams.length ? t("controlAdmin:diagnostics.video.tiles.allDirect") : t("controlAdmin:diagnostics.video.tiles.nobody")) : undefined
    },
    {
      icon: <Network size={19} />, iconTone: "gold",
      label: t("controlAdmin:diagnostics.video.tiles.sending"),
      value: plays ? t("controlAdmin:diagnostics.video.tiles.mbps", { mbps: sending }) : dash,
      sub: plays ? t("controlAdmin:diagnostics.video.tiles.viewers", { count: streams.length }) : undefined
    },
    {
      icon: <MemoryStick size={19} />, iconTone: "rose",
      label: t("controlAdmin:diagnostics.video.tiles.serverMemory"),
      value: now ? formatBytes(now.memory.availableBytes) : dash,
      sub: now ? t("controlAdmin:diagnostics.video.tiles.freeOf", { total: formatBytes(now.memory.totalBytes) }) : undefined,
      tone: now && now.memory.availableBytes / now.memory.totalBytes < 0.1 ? "warn" : undefined
    },
    {
      icon: <Settings2 size={19} />, iconTone: "blue",
      label: t("controlAdmin:diagnostics.video.tiles.conversion"),
      value: settings ? t(`controlAdmin:diagnostics.video.gpu.modeValue.${mode}`) : dash,
      sub: settings ? [
        t("controlAdmin:diagnostics.video.tiles.atOnce", { count: settings.maxViewers }),
        settings.remoteQuality !== undefined ? (settings.remoteQuality ? t("controlAdmin:diagnostics.video.tiles.away", { height: settings.remoteQuality }) : t("controlAdmin:diagnostics.video.tiles.awayOriginal")) : null
      ].filter(Boolean).join(" · ") : undefined
    },
    {
      icon: <MemoryStick size={19} />, iconTone: "mint",
      label: t("controlAdmin:diagnostics.video.tiles.convMemory"),
      value: settings?.memoryMb !== undefined ? formatBytes(settings.memoryMb * 1024 * 1024) : settings ? t("controlAdmin:diagnostics.video.tiles.perViewer", { size: formatBytes(settings.memoryPerViewerMb * 1024 * 1024) }) : dash,
      sub: usage ? t("controlAdmin:diagnostics.video.tiles.inUse", { size: formatBytes(usage.memoryBytes) }) : undefined
    },
    {
      icon: <HardDrive size={19} />, iconTone: disk && !disk.mapped ? "warn" : "gold",
      label: t("controlAdmin:diagnostics.video.tiles.convDisk"),
      value: !disk ? dash : disk.mapped && disk.freeBytes !== null ? t("controlAdmin:diagnostics.video.tiles.free", { size: formatBytes(disk.freeBytes) }) : t("controlAdmin:diagnostics.video.tiles.noDisk"),
      sub: usage ? t("controlAdmin:diagnostics.video.tiles.inUse", { size: formatBytes(usage.diskBytes) }) : undefined
    },
    {
      icon: <Archive size={19} />, iconTone: "rose",
      label: t("controlAdmin:diagnostics.video.tiles.kept"),
      value: usage?.kept ? String(usage.kept.count) : dash,
      sub: usage?.kept ? formatBytes(usage.kept.bytes) : undefined
    }
  ];
  return (
    <section className="diag-tiles" aria-labelledby="diag-tiles-title">
      <header className="diag-tiles-head">
        <h3 id="diag-tiles-title">{t("controlAdmin:diagnostics.video.tiles.title")}</h3>
        {now && <span className="muted">{t("controlAdmin:diagnostics.video.tiles.asOf", { time: new Date(now.at).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) })}</span>}
      </header>
      <StatTiles tiles={tiles} label={t("controlAdmin:diagnostics.video.tiles.title")} />
    </section>
  );
}

/** Live sessions: the machine right now as graphs, then everything being watched. */
function SessionsTab({ prefix, plays, missing }: { prefix: string; plays: Play[] | null; missing: boolean }) {
  const conversion = useEngine<ConversionState>(`${prefix}/api/admin/conversion`);
  const server = useServerNow(POLL_MS);
  return (
    <div className="diag-sessions-tab">
      <RightNow plays={plays} conversion={conversion.state} now={server.now} failed={server.failed} />
      <NowPlayingList plays={plays} missing={missing} />
    </div>
  );
}

const PCI_MAKERS: Record<string, "intel" | "amd" | "nvidia"> = { "0x8086": "intel", "0x1002": "amd", "0x10de": "nvidia" };

/** Intel, AMD or NVIDIA: by its PCI vendor where the engine says (0.41+), else by
 *  the driver vainfo names. */
export function gpuMaker(hardware: Pick<HardwareState, "driver" | "pci">): "intel" | "amd" | "nvidia" | "other" {
  const byPci = hardware.pci ? PCI_MAKERS[hardware.pci.vendor] : undefined;
  if (byPci) return byPci;
  const driver = hardware.driver ?? "";
  if (/intel|\biHD\b|i965/i.test(driver)) return "intel";
  if (/\bAMD\b|radeon|gallium/i.test(driver)) return "amd";
  if (/nvidia|nouveau/i.test(driver)) return "nvidia";
  return "other";
}

// The pictures (public/Assets/gpu, 256 px): one per kind of card, and the CPUs'.
// Which Intel it is takes the PCI device id: Arc cards are DG2 (0x56xx) and
// Battlemage (0xe2xx); built-in graphics up to Comet Lake (gen 9) is the older
// Quick Sync, Ice Lake on the newer.
export type HardwarePicture = "intel-arc-a300" | "intel-arc-a700" | "intel-quicksync-modern" | "intel-quicksync-legacy" | "amd-radeon-gpu" | "nvidia-gpu" | "amd-cpu" | "generic-gpu";

/** Arc A310, A380 and the A3xx mobiles. */
const ARC_A300 = new Set(["0x5693", "0x5694", "0x5695", "0x5696", "0x5697", "0x56a5", "0x56a6", "0x56b0", "0x56b1", "0x56b2", "0x56b3", "0x56ba", "0x56bb", "0x56bc", "0x56bd"]);
/** Built-in graphics before Ice Lake, by the device id's first byte: Sandy Bridge to Comet Lake, Atom's Apollo and Gemini Lake. */
const QUICKSYNC_LEGACY = new Set(["0x01", "0x04", "0x0a", "0x0c", "0x0d", "0x0f", "0x16", "0x19", "0x22", "0x31", "0x3e", "0x59", "0x5a", "0x87", "0x9b"]);

/** The GPU's picture, by its maker and, for Intel, which one it is. */
export function gpuPicture(hardware: Pick<HardwareState, "driver" | "pci">): HardwarePicture {
  const maker = gpuMaker(hardware);
  if (maker === "nvidia") return "nvidia-gpu";
  if (maker === "amd") return "amd-radeon-gpu";
  if (maker !== "intel") return "generic-gpu";
  const id = hardware.pci?.vendor === "0x8086" ? hardware.pci.device : null;
  if (!id) return "intel-quicksync-modern";
  if (ARC_A300.has(id)) return "intel-arc-a300";
  if (id.startsWith("0x56") || id.startsWith("0xe2")) return "intel-arc-a700";
  return QUICKSYNC_LEGACY.has(id.slice(0, 4)) ? "intel-quicksync-legacy" : "intel-quicksync-modern";
}

/** The CPU's picture, from its model: AMD's, or Intel's older or newer; null for anything else. */
export function cpuPicture(model: string | null | undefined): HardwarePicture | null {
  const name = model ?? "";
  if (/\bAMD\b|Ryzen|EPYC|Athlon/i.test(name)) return "amd-cpu";
  if (!/Intel/i.test(name)) return null;
  // Tenth generation on (and Core Ultra, the N-series Atoms): the newer one.
  const generation = Number(name.match(/(\d+)(?:th|nd|rd|st) Gen/i)?.[1] ?? name.match(/i[3579]-(\d{4,5})/i)?.[1]?.slice(0, -3) ?? NaN);
  if (/Ultra|\bN\d{2,3}\b/i.test(name) || generation >= 10) return "intel-quicksync-modern";
  return "intel-quicksync-legacy";
}

type GpuState = "inUse" | "setAside" | "cpuOnly" | "none" | "checking";
function gpuState(hardware: HardwareState): GpuState {
  if (hardware.mode === "cpu") return "cpuOnly";
  if (hardware.checking && !hardware.encode && !hardware.error) return "checking";
  if (!hardware.encode) return "none";
  return hardware.setAside ? "setAside" : "inUse";
}
const GPU_PILL: Record<GpuState, string> = { inUse: "is-ready", setAside: "is-needsSetup", cpuOnly: "is-off", none: "is-needsSetup", checking: "is-off" };

/** The formats a GPU may decode, in the order people know them: lit where this one does. */
const DECODE_FORMATS = ["h264", "hevc", "hevc10", "hevc12", "vp9", "vp9_10", "vp9_12", "av1", "av1_10", "mpeg2video", "vc1", "mjpeg"] as const;
/** What it may encode (vainfo's list): conversions only ever make H.264. */
const ENCODE_FORMATS = ["h264", "hevc", "hevc10", "vp9", "vp9_10", "av1", "mjpeg"] as const;
/** What only the CPU plays, by the ffmpeg decoder that does it (engine 0.41+ says which it has). */
const CPU_ONLY: { decoder: string; key: "divx" | "vp8" | "h264_10" | "vvc" }[] = [
  { decoder: "mpeg4", key: "divx" },
  { decoder: "vp8", key: "vp8" },
  { decoder: "h264", key: "h264_10" },
  { decoder: "vvc", key: "vvc" }
];

function Chip({ lit, label, title, tone = "gpu" }: { lit: boolean; label: string; title: string; tone?: "gpu" | "cpu" }) {
  return (
    <li className={lit ? (tone === "cpu" ? "is-cpu" : "is-lit") : undefined} title={title} aria-label={`${label}: ${title}`}>
      {lit && tone === "gpu" && <Check size={12} aria-hidden="true" />}
      {label}
    </li>
  );
}

/** What it plays on the GPU, what the GPU could encode, what falls back to the CPU, and the rest. */
function Formats({ hardware, usable }: { hardware: HardwareState | null; usable: boolean }) {
  const { t } = useTranslation(["controlAdmin"]);
  const decodes = new Set(hardware?.decode ?? []);
  const known = hardware?.encodeFormats !== undefined;
  const encodes = new Set(hardware?.encodeFormats ?? (hardware?.encode ? ["h264"] : []));
  const name = (key: string) => CODEC_NAMES[key] ?? key;
  const onGpu = t("controlAdmin:diagnostics.video.hw.onGpu");
  const onCpu = t("controlAdmin:diagnostics.video.hw.onCpu");
  // An engine before 0.41 says nothing of the CPU's decoders: the three every ffmpeg has.
  const cpu = hardware?.cpuDecoders ? CPU_ONLY.filter((entry) => hardware.cpuDecoders!.includes(entry.decoder)) : CPU_ONLY.filter((entry) => entry.key !== "vvc");
  // 4K where it decodes pictures that large; nothing where the engine can't say.
  const fourK = Boolean(hardware?.maxDecode && hardware.maxDecode.width >= 3840);
  return (
    <div className="diag-hw-formats">
      <div className="diag-hw-group">
        <span className="diag-hw-kind">{t("controlAdmin:diagnostics.video.hw.decoding")}</span>
        <ul aria-label={t("controlAdmin:diagnostics.video.hw.decoding")}>
          {DECODE_FORMATS.map((key) => <Chip key={key} lit={usable && decodes.has(key)} label={name(key)} title={usable && decodes.has(key) ? onGpu : onCpu} />)}
        </ul>
      </div>
      <div className="diag-hw-group">
        <span className="diag-hw-kind">{t("controlAdmin:diagnostics.video.hw.encoding")}</span>
        <ul aria-label={t("controlAdmin:diagnostics.video.hw.encoding")}>
          {ENCODE_FORMATS.map((key) => {
            const lit = usable && encodes.has(key);
            const title = lit ? onGpu : known || key === "h264" ? t("controlAdmin:diagnostics.video.hw.noEncode") : t("controlAdmin:diagnostics.video.hw.encodeUnknown");
            return <Chip key={key} lit={lit} label={name(key)} title={title} />;
          })}
        </ul>
        <p className="muted">{t("controlAdmin:diagnostics.video.hw.encodingNote")}</p>
      </div>
      <div className="diag-hw-group">
        <span className="diag-hw-kind">{t("controlAdmin:diagnostics.video.hw.software")}</span>
        <ul aria-label={t("controlAdmin:diagnostics.video.hw.software")}>
          {cpu.map((entry) => <Chip key={entry.key} lit tone="cpu" label={t(`controlAdmin:diagnostics.video.hw.cpuOnly.${entry.key}`)} title={onCpu} />)}
        </ul>
      </div>
      <div className="diag-hw-group">
        <span className="diag-hw-kind">{t("controlAdmin:diagnostics.video.hw.extras")}</span>
        <ul aria-label={t("controlAdmin:diagnostics.video.hw.extras")}>
          {hardware?.tonemap !== undefined && <Chip lit={usable && hardware.tonemap} label={t("controlAdmin:diagnostics.video.hw.hdr")} title={usable && hardware.tonemap ? onGpu : onCpu} />}
          <Chip lit={usable} label={t("controlAdmin:diagnostics.video.hw.scaling")} title={usable ? onGpu : onCpu} />
          {hardware?.overlay !== undefined && <Chip lit={usable && hardware.overlay} label={t("controlAdmin:diagnostics.video.hw.subtitles")} title={usable && hardware.overlay ? onGpu : onCpu} />}
          {hardware?.maxDecode && <Chip lit={usable && fourK} label="4K" title={t("controlAdmin:diagnostics.video.hw.largest", { width: hardware!.maxDecode!.width, height: hardware!.maxDecode!.height })} />}
        </ul>
      </div>
      <p className="muted">{usable ? t("controlAdmin:diagnostics.video.hw.formatsNote") : t("controlAdmin:diagnostics.video.hw.formatsNoGpu")}</p>
    </div>
  );
}

/** The machine the video plays from: its CPU, its memory and its GPU — found, and
 *  passed to the video container — with the formats the GPU plays lit. */
function HardwareCard({ prefix, conversion, now }: { prefix: string; conversion: ReturnType<typeof useEngine<ConversionState>>; now: ServerNow | null }) {
  const { t } = useTranslation(["controlAdmin"]);
  const [checking, setChecking] = useState(false);
  const hardware = conversion.state?.hardware ?? null;
  if (conversion.missing) return <MessageBox tone="warning" title={t("controlAdmin:apps.conversion.loadFailed")}>{t("controlAdmin:diagnostics.page.video.unavailable")}</MessageBox>;
  if (!conversion.state) return null;

  const check = async () => {
    setChecking(true);
    try {
      conversion.setState(await api<ConversionState>(`${prefix}/api/admin/conversion/check`, { method: "POST" }));
    } catch {
      /* the card keeps what it last knew */
    } finally {
      setChecking(false);
    }
  };

  const state = hardware ? gpuState(hardware) : "none";
  const usable = state === "inUse";
  const attached = Boolean(hardware?.device);
  const maker = hardware ? gpuMaker(hardware) : "other";
  const gpuPic = hardware && (attached || hardware.encode) ? gpuPicture(hardware) : "generic-gpu";
  const gpuName = !attached && !hardware?.encode
    ? t("controlAdmin:diagnostics.video.gpu.title.none")
    : gpuPic.startsWith("intel-arc") ? t("controlAdmin:diagnostics.video.gpu.title.arc") : t(`controlAdmin:diagnostics.video.gpu.title.${maker}`);
  const cpuModel = now?.cpu.model ?? hardware?.cpu ?? null;
  const cpuPic = cpuPicture(cpuModel);
  const mode = conversion.state.settings.hardware ?? "auto";
  const settingsHref = `${controlHref("videoSettings")}?show=conversion`;

  return (
    <section className="organization-card diag-hw" aria-labelledby="diag-hw-title">
      <header className="diag-card-head">
        <span className="diag-card-icon" aria-hidden="true"><Server size={17} /></span>
        <h3 id="diag-hw-title">{t("controlAdmin:diagnostics.video.hw.title")}</h3>
        <span className={`app-status-pill ${GPU_PILL[state]}`}>{t(`controlAdmin:diagnostics.video.gpu.state.${state}`)}</span>
        <span className="diag-card-actions">
          <Button variant="secondary" compact onClick={() => void check()} disabled={checking || hardware?.checking}>
            <RefreshCw size={14} aria-hidden="true" />
            {checking || hardware?.checking ? t("controlAdmin:apps.conversion.checking") : t("controlAdmin:apps.conversion.checkAgain")}
          </Button>
        </span>
      </header>

      <div className="diag-hw-tiles">
        <div className="diag-hw-tile">
          <div className="diag-hw-picture">
            {cpuPic ? <img src={`/Assets/gpu/${cpuPic}.webp`} alt="" width={72} height={72} data-picture={cpuPic} /> : <Cpu size={34} aria-hidden="true" />}
          </div>
          <div className="diag-hw-text">
            <span className="diag-hw-kind">{t("controlAdmin:diagnostics.video.hw.cpu")}</span>
            <strong>{cpuModel ?? "—"}</strong>
            {now && <span className="muted">{t("controlAdmin:diagnostics.video.hw.threads", { count: now.cpu.cores })}</span>}
          </div>
        </div>
        <div className="diag-hw-tile">
          <div className="diag-hw-picture"><MemoryStick size={38} aria-hidden="true" /></div>
          <div className="diag-hw-text">
            <span className="diag-hw-kind">{t("controlAdmin:diagnostics.video.hw.memory")}</span>
            <strong>{now ? formatBytes(now.memory.totalBytes) : "—"}</strong>
            {now && <span className="muted">{t("controlAdmin:diagnostics.video.now.memoryFree", { free: formatBytes(now.memory.availableBytes), total: formatBytes(now.memory.totalBytes) })}</span>}
          </div>
        </div>
        <div className={`diag-hw-tile${attached || hardware?.encode ? "" : " is-missing"}`}>
          <div className="diag-hw-picture">
            <img src={`/Assets/gpu/${gpuPic}.webp`} alt="" width={72} height={72} data-picture={gpuPic} />
          </div>
          <div className="diag-hw-text">
            <span className="diag-hw-kind">{t("controlAdmin:diagnostics.video.hw.gpu")}</span>
            <strong>{gpuName}</strong>
            <span className={attached ? "diag-hw-ok" : "diag-hw-warn"}>
              {attached ? <Check size={13} aria-hidden="true" /> : <Minus size={13} aria-hidden="true" />}
              {attached ? t("controlAdmin:diagnostics.video.hw.attached", { device: hardware?.device }) : t("controlAdmin:diagnostics.video.hw.notAttached")}
            </span>
            {hardware?.driver && <span className="muted diag-hw-driver" title={hardware.driver}>{hardware.driver}</span>}
          </div>
        </div>
      </div>

      {hardware?.error && !usable && <p className="diag-hw-error">{hardware.error}</p>}

      <Formats hardware={hardware} usable={usable} />

      <footer className="diag-hw-foot">
        <span className="muted">{t("controlAdmin:diagnostics.video.gpu.mode")}: {t(`controlAdmin:diagnostics.video.gpu.modeValue.${mode}`)}</span>
        <a className="diag-link" href={settingsHref} onClick={(event) => followRoute(event, settingsHref)}>
          {t("controlAdmin:diagnostics.video.gpu.settings")} <ArrowRight size={14} aria-hidden="true" />
        </a>
      </footer>
    </section>
  );
}

// ── Right now ──────────────────────────────────────────────────────────────────

interface ServerNow {
  at: string;
  cpu: { percent: number; cores: number; load: [number, number, number] | null; model?: string | null };
  memory: { totalBytes: number; availableBytes: number; homeBytes: number };
}

const POLL_MS = 5000;
/** Ten minutes of readings, one every five seconds. */
const KEEP = 120;

/** The machine every few seconds while the page is open, and the readings so far. */
function useServerNow(every: number) {
  const [now, setNow] = useState<ServerNow | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const body = await api<ServerNow>("/api/admin/diagnostics/now");
        if (live) {
          setNow(body);
          setFailed(false);
        }
      } catch {
        if (live) setFailed(true);
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), every);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [every]);
  return { now, failed };
}

type Series = "speed" | "cpu" | "memory" | "sending";
type Histories = { tick: string | null } & Record<Series, number[]>;

/** The last KEEP readings of each, one added each time the server is read (`tick`):
 *  state adjusted while rendering, React's way of keeping what follows from a prop. */
function useHistories(tick: string | undefined, values: Record<Series, number | null>): Record<Series, number[]> {
  const [histories, setHistories] = useState<Histories>({ tick: null, speed: [], cpu: [], memory: [], sending: [] });
  if (tick && tick !== histories.tick) {
    const add = (series: Series) => {
      const value = values[series];
      return value !== null && Number.isFinite(value) ? [...histories[series], value].slice(-KEEP) : histories[series];
    };
    setHistories({ tick, speed: add("speed"), cpu: add("cpu"), memory: add("memory"), sending: add("sending") });
  }
  return histories;
}

function RightNow({ plays, conversion, now, failed }: { plays: Play[] | null; conversion: ConversionState | null; now: ServerNow | null; failed: boolean }) {
  const { t } = useTranslation(["controlAdmin"]);
  const converting = (plays ?? []).filter((play) => play.kind === "converted" && play.converting && play.converter !== null && !play.kept);
  const speeds = converting.map((play) => play.speed).filter((speed): speed is number => typeof speed === "number");
  const slowest = speeds.length ? Math.min(...speeds) : null;
  const viewers = (plays ?? []).filter((play) => play.kind !== "download").length;
  const sending = (plays ?? []).reduce((sum, play) => sum + (play.mbps ?? 0), 0);
  const memoryUsed = now ? ((now.memory.totalBytes - now.memory.availableBytes) / now.memory.totalBytes) * 100 : null;

  const { speed: speedHistory, cpu: cpuHistory, memory: memoryHistory, sending: sendingHistory } = useHistories(now?.at, {
    speed: slowest,
    cpu: now?.cpu.percent ?? null,
    memory: memoryUsed,
    sending: plays ? sending : null
  });

  const speedRow = converting.length === 0
    ? { sub: t("controlAdmin:diagnostics.video.now.speedNone"), verdict: null }
    : slowest === null
      ? { sub: t("controlAdmin:diagnostics.video.now.speedOld", { count: converting.length }), verdict: null }
      : {
          sub: t("controlAdmin:diagnostics.video.now.speedValue", { title: converting.find((play) => play.speed === slowest)?.heading ?? converting[0].title, speed: slowest.toLocaleString(undefined, { maximumFractionDigits: 1 }) }),
          verdict: slowest >= 1 ? ({ tone: "ok", label: t("controlAdmin:diagnostics.video.now.keepingUp") } as const) : ({ tone: "warn", label: t("controlAdmin:diagnostics.video.now.fallingBehind") } as const)
        };
  const cpuBusy = now !== null && now.cpu.percent >= 90;
  const memoryLow = now !== null && now.memory.availableBytes / now.memory.totalBytes < 0.1;
  const conversionMemory = conversion?.usage.memoryBytes ?? 0;

  return (
    <section className="organization-card diag-now" aria-labelledby="diag-now-title">
      <header className="diag-card-head">
        <span className="diag-card-icon" aria-hidden="true"><Activity size={17} /></span>
        <h3 id="diag-now-title">{t("controlAdmin:diagnostics.video.now.title")}</h3>
        <span className="muted">{t("controlAdmin:diagnostics.video.now.window")}</span>
      </header>
      {failed && !now && <p className="muted">{t("controlAdmin:diagnostics.video.now.failed")}</p>}
      <div className="diag-now-grid">
      <NowRow icon={<Gauge size={17} />} label={t("controlAdmin:diagnostics.video.now.speed")} sub={speedRow.sub} verdict={speedRow.verdict} values={speedHistory} max={Math.max(2, ...speedHistory)} line={1} lineLabel="1×" unit="×" />
      {now && (
        <>
          <NowRow
            icon={<Cpu size={17} />}
            label={t("controlAdmin:diagnostics.video.now.cpu", { percent: Math.round(now.cpu.percent) })}
            sub={now.cpu.load
              ? t("controlAdmin:diagnostics.video.now.cpuLoad", { cores: now.cpu.cores, load: now.cpu.load.map((value) => value.toFixed(1)).join(" · ") })
              : t("controlAdmin:diagnostics.video.now.cpuCores", { cores: now.cpu.cores })}
            verdict={cpuBusy ? { tone: "warn", label: t("controlAdmin:diagnostics.video.now.busy") } : { tone: "ok", label: t("controlAdmin:diagnostics.video.now.fine") }}
            values={cpuHistory}
            max={100}
            line={90}
            lineLabel="90%"
            unit="%"
          />
          <NowRow
            icon={<MemoryStick size={17} />}
            label={t("controlAdmin:diagnostics.video.now.memory")}
            sub={[
              t("controlAdmin:diagnostics.video.now.memoryFree", { free: formatBytes(now.memory.availableBytes), total: formatBytes(now.memory.totalBytes) }),
              conversionMemory > 0 ? t("controlAdmin:diagnostics.video.now.memoryConversions", { size: formatBytes(conversionMemory) }) : null
            ].filter(Boolean).join(" · ")}
            verdict={memoryLow ? { tone: "warn", label: t("controlAdmin:diagnostics.video.now.low") } : { tone: "ok", label: t("controlAdmin:diagnostics.video.now.fine") }}
            values={memoryHistory}
            max={100}
            unit={t("controlAdmin:diagnostics.video.now.usedUnit")}
          />
        </>
      )}
      {plays && (
        <NowRow
          icon={<Network size={17} />}
          label={t("controlAdmin:diagnostics.video.now.sending")}
          sub={t("controlAdmin:diagnostics.video.now.sendingValue", { mbps: Math.round(sending * 10) / 10, count: viewers })}
          verdict={null}
          values={sendingHistory}
          max={Math.max(1, ...sendingHistory) * 1.15}
          unit={t("controlAdmin:diagnostics.video.now.mbitUnit")}
        />
      )}
      </div>
      <p className="muted diag-now-foot">{t("controlAdmin:diagnostics.video.now.foot")}</p>
    </section>
  );
}

function NowRow({ icon, label, sub, verdict, values, max, line, lineLabel, unit }: {
  icon: ReactNode;
  label: string;
  sub: string;
  verdict: { tone: "ok" | "warn"; label: string } | null;
  values: number[];
  max: number;
  /** A dotted line for the limit: 1× real time, 90% of the CPU. */
  line?: number;
  lineLabel?: string;
  /** How the graph names its peak ("%", "×", " Mbit/s"). */
  unit: string;
}) {
  return (
    <div className={`diag-now-tile${verdict?.tone === "warn" ? " is-warn" : ""}`}>
      <div className="diag-now-label">
        <span className="diag-now-icon" aria-hidden="true">{icon}</span>
        <strong>{label}</strong>
        {verdict && <span className={`app-status-pill ${verdict.tone === "ok" ? "is-ready" : "is-needsSetup"}`}>{verdict.label}</span>}
      </div>
      <span className="muted diag-now-sub">{sub}</span>
      <Sparkline values={values} max={max} line={line} lineLabel={lineLabel} unit={unit} warn={verdict?.tone === "warn"} />
    </div>
  );
}

/** A smooth curve through the points (Catmull-Rom as cubic Béziers). */
function curve(points: [number, number][]): string {
  if (points.length === 0) return "";
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i - 1] ?? points[i];
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const [x3, y3] = points[i + 2] ?? points[i + 1];
    const c1 = [x1 + (x2 - x0) / 6, y1 + (y2 - y0) / 6];
    const c2 = [x2 - (x3 - x1) / 6, y2 - (y3 - y1) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  }
  return d;
}

/** Readings the graph is at least as wide as: two minutes. */
const MIN_SPAN = 24;

/** Ten minutes as a soft area under a curve, the newest reading a dot at the right,
 *  the limit a dotted line; a page just opened draws only its first readings. */
export function Sparkline({ values, max, line, lineLabel, unit, warn = false }: { values: number[]; max: number; line?: number; lineLabel?: string; unit: string; warn?: boolean }) {
  const { t } = useTranslation(["controlAdmin"]);
  const id = useId().replace(/:/g, "");
  const width = 300;
  const height = 84;
  const top = 8;
  const bottom = height - 4;
  // Two minutes wide at first, widening to ten as readings come in: a page just
  // opened draws a line across, not a stub at the right.
  const step = width / Math.min(KEEP - 1, Math.max(values.length - 1, MIN_SPAN));
  const y = (value: number) => bottom - (Math.min(Math.max(value, 0), max) / max) * (bottom - top);
  const start = width - (values.length - 1) * step;
  const points = values.map((value, index) => [start + index * step, y(value)] as [number, number]);
  const path = curve(points);
  const last = points[points.length - 1];
  const peak = values.length ? Math.max(...values) : null;
  return (
    <div className={`diag-spark-wrap${warn ? " is-warn" : ""}`}>
      <div className="diag-spark-plot">
      <svg className="diag-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={`spark-${id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.32" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line className="diag-spark-base" x1="0" x2={width} y1={bottom} y2={bottom} />
        {line !== undefined && line <= max && <line className="diag-spark-limit" x1="0" x2={width} y1={y(line)} y2={y(line)} />}
        {points.length > 1 && <path d={`${path} L${last[0].toFixed(1)},${bottom} L${points[0][0].toFixed(1)},${bottom} Z`} fill={`url(#spark-${id})`} />}
        {points.length > 1 && <path className="diag-spark-line" d={path} />}
      </svg>
      {last && <span className="diag-spark-dot" style={{ left: `${(last[0] / width) * 100}%`, top: `${(last[1] / height) * 100}%` }} aria-hidden="true" />}
      {line !== undefined && lineLabel && line <= max && <span className="diag-spark-limit-label" style={{ top: `${(y(line) / height) * 100}%` }} aria-hidden="true">{lineLabel}</span>}
      </div>
      <span className="diag-spark-caption" aria-hidden="true">
        {values.length < 2 ? t("controlAdmin:diagnostics.video.now.collecting") : t("controlAdmin:diagnostics.video.now.peak", { value: `${Math.round((peak ?? 0) * 10) / 10}${unit}` })}
      </span>
    </div>
  );
}

// ── Links, what it's working through ───────────────────────────────────────────

function MoreLink({ tab, children }: { tab: DiagnosticsTab; children: ReactNode }) {
  const href = diagnosticsPartHref("video", tab);
  return (
    <a className="diag-link diag-more" href={href} onClick={(event) => followRoute(event, href)}>
      {children} <ArrowRight size={14} aria-hidden="true" />
    </a>
  );
}

interface EngineLibraryWork {
  id: string;
  name: string;
  kind: "movies" | "shows";
  scanState: string;
  metadata?: { state: "queued" | "running"; done: number; total: number; startedAt: string | null; tmdb: boolean } | null;
}

/** What the video app is working through: a library's scan or metadata pass, only while one runs. */
function CatalogWork({ prefix }: { prefix: string }) {
  const { t } = useTranslation(["controlAdmin", "control"]);
  const [libraries, setLibraries] = useState<EngineLibraryWork[] | null>(null);
  const load = useCallback(async () => {
    try {
      setLibraries((await api<{ libraries: EngineLibraryWork[] }>(`${prefix}/api/admin/libraries`)).libraries);
    } catch {
      setLibraries([]);
    }
  }, [prefix]);
  useEffect(() => {
    void load();
  }, [load]);
  const busy = (libraries ?? []).filter((library) => library.metadata || library.scanState === "scanning" || library.scanState === "queued");
  useEffect(() => {
    if (busy.length === 0) return;
    const timer = window.setTimeout(() => void load(), 3000);
    return () => window.clearTimeout(timer);
  }, [libraries, busy.length, load]);
  if (busy.length === 0) return null;
  return (
    <GroupedList id="catalog" title={t("controlAdmin:diagnostics.page.video.catalogTitle")} note={t("controlAdmin:diagnostics.page.video.catalogNote")}>
      {busy.map((library) => {
        const work = library.metadata;
        const unit = library.kind === "shows" ? "shows" : "films";
        const label = library.scanState === "scanning" || library.scanState === "queued"
          ? t("control:libraries.status.scanning")
          : work?.state === "queued" ? t("control:libraries.status.detailsQueued") : t("control:libraries.status.details");
        const sub = work?.state === "running" && work.total > 0
          ? `${t(`control:libraries.status.detailsProgress.${unit}`, { done: work.done.toLocaleString(), total: work.total.toLocaleString() })}${work.startedAt ? ` · ${t("controlAdmin:diagnostics.page.video.catalogSince", { when: relativeTime(work.startedAt) })}` : ""}${work.tmdb ? "" : ` · ${t("controlAdmin:diagnostics.page.video.catalogNoKey")}`}`
          : undefined;
        return <NavRow key={library.id} icon={<MonitorPlay size={17} />} iconTone="muted" label={`${library.name} · ${label}`} sub={sub} href={libraryManageHref(library.id)} />;
      })}
    </GroupedList>
  );
}

/** The two newest saved reports; the Reports tab has them all. */
function SavedMini({ saved }: { saved: ReturnType<typeof useSavedReports> }) {
  const { t, i18n } = useTranslation(["controlAdmin"]);
  const reports = saved.reports ?? [];
  return (
    <section className="organization-card diag-side-card" aria-labelledby="diag-saved-title">
      <h3 id="diag-saved-title">{t("controlAdmin:diagnostics.saved.title")}</h3>
      {reports.length === 0 && <p className="muted">{t("controlAdmin:diagnostics.video.savedNone")}</p>}
      {reports.slice(0, 2).map((report) => (
        <div key={report.id} className="diag-saved-row">
          <FileText size={15} aria-hidden="true" />
          <span>{new Date(report.createdAt).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" })}</span>
        </div>
      ))}
      <MoreLink tab="reports">{t("controlAdmin:diagnostics.video.savedAll")}</MoreLink>
    </section>
  );
}

// ── GPU tests ──────────────────────────────────────────────────────────────────

/** The hardware test, as Videos › Settings has it, with the GPU's row above it. */
function TestsTab({ prefix }: { prefix: string }) {
  const { t } = useTranslation(["controlAdmin"]);
  const url = `${prefix}/api/admin/conversion`;
  const conversion = useEngine<ConversionState>(url);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const state = conversion.state;
  const save = async (patch: Partial<ConversionSettings>) => {
    if (!state) return;
    setSaving(true);
    setError("");
    try {
      conversion.setState(await api<ConversionState>(url, { method: "PUT", body: JSON.stringify(conversionBody(state.settings, patch)) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:apps.conversion.saveFailed"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div id="tests" className="diagnostics-part-tests">
      {error && <MessageBox tone="error" title={t("controlAdmin:apps.conversion.saveFailed")}>{error}</MessageBox>}
      <HardwareTestPage
        prefix={prefix}
        capabilities={state?.hardware ? <GpuRow hardware={state.hardware} /> : state ? <InfoRow icon={<Cpu size={17} />} iconTone="muted" label={t("controlAdmin:apps.conversion.gpuNoneTitle")} /> : null}
        maxViewers={state?.settings.maxViewers ?? null}
        saving={saving}
        onUseLimit={(count) => void save({ maxViewers: count })}
      />
    </div>
  );
}
