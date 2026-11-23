import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clock, Cpu, Database, FolderOpen, HardDrive, Info, Layers, MemoryStick, Zap } from "lucide-react";
import { api } from "../../../api";
import { followRoute } from "../../../router";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { PickerRow } from "../../../shared/GroupedList";
import { SegmentedControl } from "../../../shared/SegmentedControl";
import { SliderField } from "../../../shared/SliderField";
import { formatBytes } from "../../../shared/utils";
import { guideHref } from "../../help/catalog";
import { VideoFolderModal } from "./VideoFolderModal";
import type { ConversionSettings, ConversionState, CopiesState } from "./VideoSettingsSection";

// Videos › Video Streaming › Disk & memory (owner's design, 2026-11-22): the video
// cache on one line — its folder, how full the room for kept video is, and Change —
// then the two budgets as sliders (memory for conversion, disk space for kept
// video), where converted video is kept and how long unused video stays, and what
// the room holds now. Everything saves as it is changed: a slider when it is let
// go. The two changes that delete kept video at once — less room than is in use,
// and a shorter retention — ask first, saying what goes. The conversion settings live in the engine's /admin/conversion, the room and
// the retention in its /admin/copies; an engine without one of them is simply not
// offered that control.

const GB = 1024 ** 3;
/** How long kept video may go unused, in days; 0 keeps it until the room runs out. */
const RETENTION_DAYS = [0, 7, 30, 90, 365] as const;
/** The guide on mapping a disk into the video container, for an engine too old to choose one here. */
const DISK_SETUP_HREF = `${guideHref("apps")}#where-converted-video-is-kept`;

export function VideoDiskMemoryCard({ url, conversion, setConversion, saving, onSave, copiesUrl, copies, setCopies, onError }: {
  /** {prefix}/api/admin/conversion. */
  url: string;
  conversion: ConversionState;
  setConversion: (state: ConversionState) => void;
  saving: boolean;
  onSave: (patch: Partial<ConversionSettings>) => void;
  /** {prefix}/api/admin/copies, and what it last answered; null without it. */
  copiesUrl: string;
  copies: CopiesState | null;
  setCopies: (state: CopiesState) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const titleId = useId();
  const [choosing, setChoosing] = useState(false);
  const [savingCopies, setSavingCopies] = useState(false);
  /** A change that removes kept video as it is saved, waiting to be confirmed. */
  const [asking, setAsking] = useState<{ limitGb: number } | { retentionDays: number } | null>(null);

  const disk = conversion.disk ?? null;
  const storage = conversion.settings.storage;
  if (!disk || !storage) return null;
  const inForce = conversion.storage ?? storage;
  const mapped = disk.mapped;
  const memoryMb = conversion.settings.memoryMb ?? 0;

  const saveCopies = (patch: { limitGb?: number; retentionDays?: number }) => {
    setSavingCopies(true);
    onError("");
    api<CopiesState>(copiesUrl, { method: "PUT", body: JSON.stringify(patch) })
      .then(setCopies, (err) => onError(err instanceof Error ? err.message : t("controlAdmin:apps.copies.saveFailed")))
      .finally(() => { setSavingCopies(false); setAsking(null); });
  };

  // What the room for kept video holds: the films kept after watching, and the copies for download.
  const room = copies && !copies.insideContainer ? copies : null;
  const cachedBytes = room?.keptBytes ?? 0;
  const downloadBytes = room?.usedBytes ?? 0;
  const usedBytes = cachedBytes + downloadBytes;
  const limitBytes = room ? room.settings.limitGb * GB : 0;
  const percent = limitBytes > 0 ? Math.min(100, Math.round((usedBytes / limitBytes) * 100)) : 0;
  const limitLabel = room ? `${room.settings.limitGb} GB` : "";
  // The slider goes to 500 GB, or to what the disk holds where that is less.
  const diskGb = disk.totalBytes !== null ? Math.floor(disk.totalBytes / GB) : null;
  const sliderMaxGb = Math.max(10, Math.min(500, diskGb ?? 500));
  const retention = copies?.settings.retentionDays;
  const retentionChoices = retention !== undefined && !RETENTION_DAYS.includes(retention as (typeof RETENTION_DAYS)[number])
    ? [...RETENTION_DAYS, retention].sort((a, b) => a - b) : [...RETENTION_DAYS];

  return (
    <section className="settings-card video-dm" id="video-conversion-storage" aria-labelledby={titleId}>
      <header className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true"><Database size={22} /></span>
        <div><h3 id={titleId}>{t("controlAdmin:apps.videoSettings.cardDisk")}</h3></div>
      </header>

      {/* The cache itself: where it is, how full, and Change. */}
      <div className={`video-dm-cache${mapped ? "" : " is-missing"}`}>
        <span className="video-dm-cache-icon" aria-hidden="true"><HardDrive size={28} /></span>
        <span className="video-dm-cache-text">
          <strong>{mapped ? t("controlAdmin:apps.videoDisk.cacheTitle") : t("controlAdmin:apps.conversion.diskNoneTitle")}</strong>
          {mapped ? (
            <small>
              <span className="storage-row-path">{disk.folder}</span>
              {disk.freeBytes !== null && <> · {t("controlAdmin:apps.videoDisk.freeOnDisk", { free: formatBytes(disk.freeBytes) })}</>}
            </small>
          ) : (
            <small>{disk.choice ? t("controlAdmin:apps.videoFolder.noneBody") : t("controlAdmin:apps.conversion.diskNoneBody")}</small>
          )}
        </span>
        {mapped && room && (
          <span className="video-dm-cache-use">
            <strong>{t("controlAdmin:apps.videoDisk.usedOfPercent", { used: formatBytes(usedBytes), limit: limitLabel, percent })}</strong>
            <span className="video-dm-meter" role="meter" aria-label={t("controlAdmin:apps.videoSettings.usageAria", { used: formatBytes(usedBytes), limit: limitLabel })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <span style={{ width: usedBytes > 0 ? `max(${percent}%, 4px)` : 0 }} />
            </span>
          </span>
        )}
        {disk.choice ? (
          <Button variant="secondary" onClick={() => setChoosing(true)}>
            <FolderOpen size={16} aria-hidden="true" />
            {mapped ? t("controlAdmin:apps.videoDisk.change") : t("controlAdmin:apps.videoFolder.choose")}
          </Button>
        ) : !mapped && (
          // An engine before 0.42: the folder is set in the container, as the guide says.
          <a className="video-flow-more" href={DISK_SETUP_HREF} onClick={(event) => followRoute(event, DISK_SETUP_HREF)}>
            <Info size={15} aria-hidden="true" />{t("controlAdmin:apps.conversion.diskSetupLabel")}
          </a>
        )}
      </div>
      {disk.choice?.pending && (
        <p className="video-dm-notice">
          <Info size={16} aria-hidden="true" />
          <span>
            <strong>{t("controlAdmin:apps.videoFolder.pendingTitle")}</strong>{" "}
            {disk.choice.folder ? t("controlAdmin:apps.videoFolder.pendingBody", { folder: disk.choice.folder }) : t("controlAdmin:apps.videoFolder.pendingBodyContainer")}
          </span>
        </p>
      )}
      {disk.choice?.problem && (
        <p className="video-dm-notice">
          <Info size={16} aria-hidden="true" />
          <span><strong>{t("controlAdmin:apps.videoFolder.problemTitle", { folder: disk.choice.folder })}</strong> {disk.choice.problem}</span>
        </p>
      )}

      {/* The two budgets. */}
      <div className="video-dm-budgets">
        <SliderField
          icon={<MemoryStick size={20} />}
          label={t("controlAdmin:apps.videoDisk.memoryTitle")}
          sub={inForce === "disk" ? t("controlAdmin:apps.videoDisk.memoryUnused") : t("controlAdmin:apps.videoDisk.memorySub")}
          value={memoryMb}
          unit="MB"
          min={256}
          max={8192}
          step={64}
          hardMin={64}
          hardMax={16384}
          minLabel="256 MB"
          maxLabel="8,192 MB (8 GB)"
          disabled={saving || inForce === "disk"}
          onCommit={(value) => onSave({ memoryMb: value })}
        />
        {copies && (
          <SliderField
            icon={<HardDrive size={20} />}
            label={t("controlAdmin:apps.videoDisk.diskTitle")}
            sub={t("controlAdmin:apps.videoDisk.diskSub")}
            value={copies.settings.limitGb}
            unit="GB"
            min={5}
            max={sliderMaxGb}
            step={5}
            hardMin={1}
            hardMax={10000}
            minLabel="5 GB"
            maxLabel={`${sliderMaxGb} GB`}
            disabled={savingCopies || !mapped}
            // Less room than is in use removes the oldest kept video at once: asked first.
            onCommit={(value) => (room && value * GB < usedBytes ? setAsking({ limitGb: value }) : saveCopies({ limitGb: value }))}
          />
        )}
      </div>

      {/* Where converted video is kept, and how long unused video stays. */}
      <div className="video-dm-options">
        <div className="video-dm-option">
          <span className="video-dm-option-icon" aria-hidden="true"><Layers size={20} /></span>
          <span className="video-dm-option-text">
            <strong>{t("controlAdmin:apps.videoDisk.keepTitle")}</strong>
            <small>{t("controlAdmin:apps.videoDisk.keepSub")}</small>
          </span>
          <SegmentedControl
            label={t("controlAdmin:apps.videoDisk.keepTitle")}
            value={inForce === "memory" ? "memory" : "disk"}
            disabled={saving || !mapped}
            options={[
              { value: "disk", label: t("controlAdmin:apps.videoDisk.keepDisk"), icon: <HardDrive size={15} aria-hidden="true" /> },
              { value: "memory", label: t("controlAdmin:apps.videoDisk.keepMemory"), icon: <Cpu size={15} aria-hidden="true" /> }
            ]}
            // "On disk" is memory first, then the disk; a server set to the disk alone stays so.
            onChange={(value) => {
              if (value === "memory" && inForce !== "memory") onSave({ storage: "memory" });
              if (value === "disk" && inForce === "memory") onSave({ storage: "memory-disk" });
            }}
          />
        </div>
        {retention !== undefined && (
          <div className="video-dm-option is-retention">
            <PickerRow
              icon={<Clock size={20} />}
              label={t("controlAdmin:apps.videoDisk.retentionTitle")}
              sub={t("controlAdmin:apps.videoDisk.retentionSub")}
              value={String(retention)}
              disabled={savingCopies || !mapped}
              options={retentionChoices.map((days) => ({
                value: String(days),
                label: days === 0 ? t("controlAdmin:apps.videoDisk.retentionNever") : t("controlAdmin:apps.videoDisk.retentionAfter", { count: days })
              }))}
              // A shorter time removes what is already older than it, at once: asked first.
              onChange={(value) => {
                const days = Number(value);
                const shorter = days > 0 && (retention === 0 || days < retention);
                if (shorter && usedBytes > 0) setAsking({ retentionDays: days });
                else saveCopies({ retentionDays: days });
              }}
            />
          </div>
        )}
      </div>

      {/* What the room holds now. */}
      {mapped && room && (
        <p className="video-dm-usage">
          <Info size={18} aria-hidden="true" />
          <strong>{t("controlAdmin:apps.videoDisk.usageTitle")}</strong>
          <span><i className="is-cached" aria-hidden="true" />{t("controlAdmin:apps.videoDisk.usageCached")}: <b>{formatBytes(cachedBytes)}</b></span>
          <span><i className="is-downloads" aria-hidden="true" />{t("controlAdmin:apps.videoDisk.usageDownloads")}: <b>{formatBytes(downloadBytes)}</b></span>
          <span className="video-dm-usage-left">{t("controlAdmin:apps.videoDisk.usageLeft", { limit: limitLabel })}: <b>{formatBytes(Math.max(0, limitBytes - usedBytes))}</b></span>
        </p>
      )}

      <p className="video-dm-tip">
        <Zap size={18} aria-hidden="true" />
        <span><strong>{t("controlAdmin:apps.videoDisk.tipLabel")}</strong> {t("controlAdmin:apps.videoDisk.tip")}</span>
      </p>

      {asking && (
        <ConfirmDialog
          title={"limitGb" in asking
            ? t("controlAdmin:apps.videoDisk.shrinkTitle", { limit: `${asking.limitGb} GB` })
            : t("controlAdmin:apps.videoDisk.retentionAskTitle", { count: asking.retentionDays })}
          confirmLabel={t("controlAdmin:apps.videoDisk.removeConfirm")}
          busyLabel={t("controlAdmin:apps.videoDisk.removing")}
          busy={savingCopies}
          danger
          onConfirm={() => saveCopies(asking)}
          onCancel={() => setAsking(null)}
        >
          {"limitGb" in asking
            ? t("controlAdmin:apps.videoDisk.shrinkBody", { used: formatBytes(usedBytes), over: formatBytes(Math.max(0, usedBytes - asking.limitGb * GB)) })
            : t("controlAdmin:apps.videoDisk.retentionAskBody", { count: asking.retentionDays })}
        </ConfirmDialog>
      )}
      {choosing && <VideoFolderModal url={url} onSaved={setConversion} onClose={() => setChoosing(false)} />}
    </section>
  );
}
