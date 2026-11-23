import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, Check, ChevronRight, CirclePlay, Cpu, Database, Film, HardDrive, Info, Lightbulb, MemoryStick, Monitor, Play, Settings, Zap } from "lucide-react";
import { diagnosticsPartHref, followRoute } from "../../../router";
import { guideHref } from "../../help/catalog";
import { Button } from "../../../shared/Button";
import { formatBytes, formatManagedDate } from "../../../shared/utils";
import { FormatChip } from "../diagnostics/FormatChip";
import { gpuMaker, gpuPicture, useServerNow } from "../diagnostics/VideoPage";
import type { HardwareTest, TestState } from "./VideoHardwareTest";
import type { ConversionState, HardwareState } from "./VideoSettingsSection";

// The top of Videos › Settings (owner, 2026-11-22; they replaced the "At a glance"
// cards): first HOW video plays — as it is where the device plays the format,
// from the cache where a converted version is already kept on the disk, converted
// where neither — then the hardware that does the converting: the GPU
// and whether it is in use, the CPU, the server's memory, what the disk holds for
// video, and the formats people ask about. Everything here is read, nothing set:
// the cards under it are where it is changed. The pictures and the chips are
// Diagnostics › Video's (diagnostics/VideoPage.tsx), which has the full account.

type GpuState = "inUse" | "setAside" | "cpuOnly" | "none" | "checking";
function gpuStateOf(hardware: HardwareState | null | undefined): GpuState {
  if (!hardware) return "none";
  if (hardware.mode === "cpu") return "cpuOnly";
  if (hardware.checking && !hardware.encode && !hardware.error) return "checking";
  if (!hardware.encode) return "none";
  return hardware.setAside ? "setAside" : "inUse";
}

/** Whether converted video is kept on the disk and played from there the next
 *  time: with a disk for video, unless it is all kept in memory. Null from an
 *  engine before 0.35, which keeps nothing. */
function cacheStateOf(conversion: ConversionState | null): "on" | "noDisk" | "memoryOnly" | null {
  const disk = conversion?.disk;
  const storage = conversion?.storage ?? conversion?.settings.storage;
  if (!conversion || !disk || !storage) return null;
  if (!disk.mapped) return "noDisk";
  return storage === "memory" ? "memoryOnly" : "on";
}

/** The guide's account of what is converted, and why. */
const HOW_HREF = `${guideHref("apps")}#converting-video`;

/** One of the three ways a flow ends in. */
export interface FlowWay {
  icon: ReactNode;
  title: string;
  sub: string;
  /** The small sign at its right end. */
  mark: ReactNode;
  /** Not on offer on this server: drawn dimmed, its line dashed (the cache way only). */
  off?: boolean;
}

/** Two questions, three ways, as a flow: a source, a first question whose Yes is
 *  the first way, a second question (its No) whose Yes is the second way and whose
 *  No is the third, and where it all arrives. Video Streaming's "How video plays"
 *  and Video Downloads' "How downloads work" are both this.
 *
 *  One set of elements, placed over the lines above the phone breakpoint and read
 *  top to bottom as a list below it (styles: .video-flow-chart). */
export function VideoFlow({ icon, title, body, aria, learnHref, source, device, askFirst, askSecond, direct, cache, convert }: {
  icon: ReactNode;
  title: string;
  body: string;
  /** The whole flow in a sentence or two, for a screen reader. */
  aria: string;
  /** The guide's account of it. */
  learnHref: string;
  source: { icon: ReactNode; title: string; sub: string };
  device: { icon: ReactNode; title: string; sub: string };
  askFirst: { icon: ReactNode; text: string };
  askSecond: { icon: ReactNode; text: string };
  direct: FlowWay;
  cache: FlowWay;
  convert: FlowWay;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const titleId = useId();
  const yes = t("controlAdmin:apps.videoHero.yes");
  const no = t("controlAdmin:apps.videoHero.no");
  const way = (kind: "direct" | "cache" | "convert", entry: FlowWay, answer: string, yesNo: "yes" | "no") => (
    <li className={`video-flow-way is-${kind}${entry.off ? " is-off" : ""}`}>
      <b className={`video-flow-pill is-${yesNo}`}>{answer}</b>
      <span className="video-flow-way-icon" aria-hidden="true">{entry.icon}</span>
      <span>
        <strong>{entry.title}</strong>
        <small>{entry.sub}</small>
      </span>
      <span className="video-flow-mark" aria-hidden="true">{entry.mark}</span>
    </li>
  );
  return (
    <section className="settings-card video-flow" aria-labelledby={titleId}>
      <div className="video-flow-copy">
        <span className="settings-card-icon" aria-hidden="true">{icon}</span>
        <div>
          <h3 id={titleId}>{title}</h3>
          <p>{body}</p>
          <a className="video-flow-more" href={learnHref} onClick={(event) => followRoute(event, learnHref)}>
            <Info size={15} aria-hidden="true" />{t("controlAdmin:apps.videoHero.learnMore")}
          </a>
        </div>
      </div>
      <ol className={`video-flow-chart${cache.off ? " is-cache-off" : ""}`} aria-label={aria}>
        {/* The lines, under everything: a 100 × 100 box stretched over the chart. */}
        <li className="video-flow-lines" aria-hidden="true">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            <path className="is-plain" d="M12 50 C17 50 17 36 23 36" />
            <path className="is-yes" d="M23 36 C23 14 27 14 33 14 L56 14" />
            <path className="is-no" d="M23 36 C23 66 28 66 40 66" />
            <path className="is-yes is-cache" d="M40 66 C47 66 47 50 52 50 L56 50" />
            <path className="is-no" d="M40 66 C40 84 46 84 52 84 L56 84" />
            <path className="is-direct" d="M85 14 C87.5 14 87.5 50 90 50" />
            <path className="is-cache" d="M85 50 L90 50" />
            <path className="is-convert" d="M85 84 C87.5 84 87.5 50 90 50" />
          </svg>
        </li>
        <li className="video-flow-node is-source">
          <span aria-hidden="true">{source.icon}</span>
          <strong>{source.title}</strong>
          <small>{source.sub}</small>
        </li>
        <li className="video-flow-ask is-first">
          <span>
            <span aria-hidden="true">{askFirst.icon}</span>
            <strong>{askFirst.text}</strong>
          </span>
        </li>
        {way("direct", direct, yes, "yes")}
        <li className="video-flow-ask is-second">
          <b className="video-flow-pill is-no">{no}</b>
          <span>
            <span aria-hidden="true">{askSecond.icon}</span>
            <strong>{askSecond.text}</strong>
          </span>
        </li>
        {way("cache", cache, yes, "yes")}
        {way("convert", convert, no, "no")}
        <li className="video-flow-node is-device">
          <span aria-hidden="true">{device.icon}</span>
          <strong>{device.title}</strong>
          <small>{device.sub}</small>
        </li>
      </ol>
    </section>
  );
}

/** How the server chooses: can the device play it as it is (Direct Play)? If not,
 *  is a converted version already kept (From cache)? If not, it is converted
 *  (Transcode) — with how this server stands: the cache dimmed where nothing is
 *  kept, and where the converting is done. */
export function HowVideoPlays({ conversion }: { conversion: ConversionState | null }) {
  const { t } = useTranslation(["controlAdmin"]);
  const onGpu = gpuStateOf(conversion?.hardware) === "inUse";
  const how = !conversion ? t("controlAdmin:apps.videoHero.transcodeSub")
    : !conversion.available ? t("controlAdmin:apps.videoHero.transcodeNone")
    : onGpu ? t("controlAdmin:apps.videoHero.transcodeGpu") : t("controlAdmin:apps.videoHero.transcodeCpu");
  const cache = cacheStateOf(conversion);
  // An engine that keeps nothing (before 0.35) is the same to the viewer as no disk.
  const cacheOff = conversion !== null && cache !== "on";
  return (
    <VideoFlow
      icon={<CirclePlay size={22} />}
      title={t("controlAdmin:apps.videoHero.flowTitle")}
      body={t("controlAdmin:apps.videoHero.flowBody")}
      aria={t("controlAdmin:apps.videoHero.flowAria")}
      learnHref={HOW_HREF}
      source={{ icon: <Film size={26} />, title: t("controlAdmin:apps.videoHero.video"), sub: t("controlAdmin:apps.videoHero.videoSub") }}
      device={{ icon: <Monitor size={26} />, title: t("controlAdmin:apps.videoHero.device"), sub: t("controlAdmin:apps.videoHero.deviceSub") }}
      askFirst={{ icon: <Monitor size={20} />, text: t("controlAdmin:apps.videoHero.askPlays") }}
      askSecond={{ icon: <Database size={20} />, text: t("controlAdmin:apps.videoHero.askCached") }}
      direct={{ icon: <CirclePlay size={24} />, title: t("controlAdmin:apps.videoHero.direct"), sub: t("controlAdmin:apps.videoHero.directSub"), mark: <Check size={20} /> }}
      cache={{
        icon: <Database size={24} />, title: t("controlAdmin:apps.videoHero.cache"), mark: <Zap size={20} />, off: cacheOff,
        sub: !cacheOff ? t("controlAdmin:apps.videoHero.cacheSub") : t(`controlAdmin:apps.videoHero.cacheState.${cache === "memoryOnly" ? "memoryOnly" : "noDisk"}`)
      }}
      convert={{ icon: <Settings size={24} />, title: t("controlAdmin:apps.videoHero.transcode"), sub: how, mark: <ArrowLeftRight size={20} /> }}
    />
  );
}

/** How much of something is used, as a thin bar under its number. */
export function Meter({ used, total, label }: { used: number; total: number; label: string }) {
  const percent = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  return (
    <span className="video-hw-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
      {/* Anything used shows as a sliver, so a little of a lot does not read as none. */}
      <span style={{ width: used > 0 ? `max(${percent}%, 4px)` : 0 }} />
    </span>
  );
}

/** What the last test found this server converts fast enough to watch (as fast as
 *  it plays, or faster), and on what: the GPU where it managed there, else the CPU.
 *  Only those: a kind of film that came out too slow, or failed, is not listed. */
type FastFormat = { id: HardwareTest["scenarios"][number]["id"]; on: "gpu" | "cpu" };
function convertsFastEnough(test: HardwareTest): FastFormat[] {
  const fast = (run: HardwareTest["scenarios"][number]["gpuRun"]) => run !== null && (run.verdict === "smooth" || run.verdict === "tight");
  const found: FastFormat[] = [];
  for (const scenario of test.scenarios) {
    if (fast(scenario.gpuRun)) found.push({ id: scenario.id, on: "gpu" });
    else if (fast(scenario.cpuRun)) found.push({ id: scenario.id, on: "cpu" });
  }
  return found;
}

/** Hardware & transcoding: the GPU, the CPU, memory and the disk for video as they
 *  stand, the formats, and — as `children` — every conversion setting: where to
 *  convert, the hardware test, how many at once, the quality away from home. */
export function VideoHardwareSummary({ conversion, keptBytes, limitGb, test, onRunTest, onOpenTest, children }: {
  conversion: ConversionState;
  /** Kept films and download copies together; null while that is not known (or the engine has none). */
  keptBytes: number | null;
  limitGb: number | null;
  /** The hardware test: its last result and whether one runs; null for an engine with no test. */
  test: TestState | null;
  onRunTest: () => void;
  /** Opens the test's own page: its results in full. */
  onOpenTest: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const titleId = useId();
  // The machine itself: its memory and its CPU's name (home's own reading).
  const { now } = useServerNow(10_000);
  const hardware = conversion.hardware ?? null;
  const state = gpuStateOf(hardware);
  const attached = Boolean(hardware?.device) || Boolean(hardware?.encode);
  const gpuPic = hardware && attached ? gpuPicture(hardware) : "generic-gpu";
  const gpuName = !hardware || !attached
    ? t("controlAdmin:diagnostics.video.gpu.title.none")
    : gpuPic.startsWith("intel-arc") ? t("controlAdmin:diagnostics.video.gpu.title.arc") : t(`controlAdmin:diagnostics.video.gpu.title.${gpuMaker(hardware)}`);
  const cpuModel = now?.cpu.model ?? hardware?.cpu ?? null;

  const disk = conversion.disk ?? null;
  const diskUsed = disk?.mapped ? (keptBytes ?? 0) + conversion.usage.diskBytes : null;
  const limitBytes = limitGb !== null ? limitGb * 1024 ** 3 : null;
  const memoryUsed = now ? now.memory.totalBytes - now.memory.availableBytes : null;
  // The last test that ran to the end: what the formats and the advice are read from.
  const tested = test?.last?.phase === "done" ? test.last : null;
  const formats = tested ? convertsFastEnough(tested) : [];
  // Whether the test got anything through the GPU fast enough: then the GPU is the advice.
  const gpuAdvised = tested ? formats.some((format) => format.on === "gpu") : null;
  const gpuFollowed = gpuAdvised === null || !gpuAdvised || conversion.settings.hardware !== "cpu";
  const viewersFollowed = tested?.suggestedViewers === conversion.settings.maxViewers;
  const adviceId = useId();
  const formatsHref = diagnosticsPartHref("video");
  // What it converts fast enough, by the test: nothing is claimed before one has run.
  const formatsBlock = !test ? null : (
    <span className="diag-hw-group video-hw-formats">
      <span className="diag-hw-kind">{t("controlAdmin:apps.videoHero.codecs")}</span>
      {tested ? (
        formats.length > 0 ? (
          <ul aria-label={t("controlAdmin:apps.videoHero.codecs")}>
            {formats.map((format) => (
              <FormatChip
                key={format.id}
                tone="gpu"
                label={t(`controlAdmin:apps.videoHero.format.${format.id}`)}
                title={format.on === "gpu" ? t("controlAdmin:diagnostics.video.hw.onGpu") : t("controlAdmin:diagnostics.video.hw.onCpu")}
              />
            ))}
          </ul>
        ) : <small>{t("controlAdmin:apps.videoHero.formatsNone")}</small>
      ) : (
        <small>{test.running ? t("controlAdmin:apps.videoHero.formatsRunning") : t("controlAdmin:apps.videoHero.formatsRunFirst")}</small>
      )}
      <a className="diag-link" href={formatsHref} onClick={(event) => followRoute(event, formatsHref)}>{t("controlAdmin:apps.videoHero.allFormats")}</a>
    </span>
  );

  return (
    <section className="settings-card video-hw" id="video-conversion" aria-labelledby={titleId}>
      <header className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true"><Cpu size={22} /></span>
        <div>
          <h3 id={titleId}>{t("controlAdmin:apps.videoHero.hwTitle")}</h3>
          <p>{t("controlAdmin:apps.videoHero.hwBody")}</p>
        </div>
        {test && (
          <div className="settings-card-head-actions">
            <Button variant="secondary" disabled={Boolean(test.running)} onClick={onRunTest}>
              <Play size={16} aria-hidden="true" />
              {test.running ? t("controlAdmin:apps.hardwareTest.runningTitle") : t("controlAdmin:apps.hardwareTest.run")}
            </Button>
            {(test.running ?? test.last) && (
              <Button variant="secondary" onClick={onOpenTest}>
                {tested && <Check size={16} aria-hidden="true" />}
                {t("controlAdmin:apps.videoHero.testResults")}
                <span className="muted">{formatManagedDate((test.running ?? test.last)!.startedAt)}</span>
                <ChevronRight size={15} aria-hidden="true" />
              </Button>
            )}
          </div>
        )}
      </header>

      {/* One row: the GPU, the CPU, memory and the disk for video in a box, and beside
          it what the test advises. What converts fast enough runs under all four,
          the box's whole width. */}
      <div className="video-hw-top">
        <div className="video-hw-box">
          <div className={`video-hw-item is-chip${attached ? "" : " is-missing"}`}>
            <span className="video-hw-picture"><img src={`/Assets/gpu/${gpuPic}.webp`} alt="" width={60} height={60} data-picture={gpuPic} /></span>
            <span className="video-hw-text">
              <strong>{gpuName}</strong>
              <span className={`video-hw-state is-${state}`}>
                <i aria-hidden="true" />{t("controlAdmin:apps.videoHero.acceleration")}: <b>{t(`controlAdmin:apps.videoHero.gpuState.${state}`)}</b>
              </span>
            </span>
          </div>
          {/* The CPU in words alone, and no rule between the two that do the converting. */}
          <div className="video-hw-item is-chip">
            <span className="video-hw-text">
              <strong title={cpuModel ?? undefined}>{cpuModel ?? t("controlAdmin:diagnostics.video.hw.cpu")}</strong>
              <span className={`video-hw-state ${conversion.available ? "is-inUse" : "is-none"}`}>
                <i aria-hidden="true" />{t("controlAdmin:apps.videoHero.transcoding")}: <b>{conversion.available ? t("controlAdmin:apps.videoHero.gpuState.inUse") : t("controlAdmin:apps.videoHero.unavailable")}</b>
              </span>
            </span>
          </div>
          <div className="video-hw-item is-metric">
            <span className="video-hw-text">
              <small><MemoryStick size={15} aria-hidden="true" />{t("controlAdmin:diagnostics.video.hw.memory")}</small>
              <strong>{now && memoryUsed !== null
                ? t("controlAdmin:apps.videoHero.usedOf", { used: formatBytes(memoryUsed), total: formatBytes(now.memory.totalBytes) })
                : "—"}</strong>
              {now && memoryUsed !== null && <Meter used={memoryUsed} total={now.memory.totalBytes} label={t("controlAdmin:diagnostics.video.hw.memory")} />}
              {conversion.settings.memoryMb !== undefined && (conversion.storage ?? conversion.settings.storage) !== "disk" && (
                <small>{t("controlAdmin:apps.videoHero.conversionShare", { used: formatBytes(conversion.usage.memoryBytes), total: formatBytes(conversion.settings.memoryMb * 1024 * 1024) })}</small>
              )}
            </span>
          </div>
          <div className="video-hw-item is-metric">
            <span className="video-hw-text">
              <small><HardDrive size={15} aria-hidden="true" />{t("controlAdmin:apps.videoHero.diskCache")}</small>
              {diskUsed === null ? (
                <strong className={disk ? "is-warn" : undefined}>{disk ? t("controlAdmin:apps.conversion.placeNotSetUp") : "—"}</strong>
              ) : (
                <>
                  <strong>{limitBytes !== null
                    ? t("controlAdmin:apps.videoHero.usedOf", { used: formatBytes(diskUsed), total: `${limitGb} GB` })
                    : formatBytes(diskUsed)}</strong>
                  {limitBytes !== null && <Meter used={diskUsed} total={limitBytes} label={t("controlAdmin:apps.videoHero.diskCache")} />}
                </>
              )}
              {disk && <small><a className="diag-link" href="#video-conversion-storage">{t("controlAdmin:apps.videoSettings.cardDisk")}</a></small>}
            </span>
          </div>
          {formatsBlock && <div className="video-hw-box-formats">{formatsBlock}</div>}
        </div>

        {/* What the test advises for the settings below, and whether they are set so. */}
        {test && (
          <section className="video-hw-advice" aria-labelledby={adviceId}>
            <h4 id={adviceId}><Lightbulb size={17} aria-hidden="true" />{t("controlAdmin:apps.videoHero.recommended")}</h4>
            {tested ? (
              <ul>
                {gpuAdvised !== null && (
                  <li className={gpuFollowed ? "is-ok" : "is-todo"}>
                    {gpuFollowed ? <Check size={16} aria-hidden="true" /> : <Lightbulb size={16} aria-hidden="true" />}
                    <span>
                      {/* With no GPU to try, the CPU is simply what there is. */}
                      {gpuAdvised ? t("controlAdmin:apps.videoHero.adviseGpu") : attached ? t("controlAdmin:apps.videoHero.adviseCpu") : t("controlAdmin:apps.videoHero.adviseCpuOnly")}
                      {!gpuFollowed && <small>{t("controlAdmin:apps.videoHero.adviseGpuNow")}</small>}
                    </span>
                  </li>
                )}
                {tested.suggestedViewers !== null && (
                  <li className={viewersFollowed ? "is-ok" : "is-todo"}>
                    {viewersFollowed ? <Check size={16} aria-hidden="true" /> : <Lightbulb size={16} aria-hidden="true" />}
                    <span>
                      {t("controlAdmin:apps.videoHero.adviseViewers", { count: tested.suggestedViewers })}
                      {!viewersFollowed && <small>{t("controlAdmin:apps.videoHero.adviseViewersNow", { count: conversion.settings.maxViewers })}</small>}
                    </span>
                  </li>
                )}
              </ul>
            ) : (
              <p className="muted">{test.running ? t("controlAdmin:apps.videoHero.formatsRunning") : t("controlAdmin:apps.videoHero.adviceRunFirst")}</p>
            )}
          </section>
        )}
      </div>

      {children && <div className="video-hw-settings">{children}</div>}
    </section>
  );
}
