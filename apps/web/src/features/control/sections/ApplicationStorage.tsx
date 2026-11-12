import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HardDrive } from "lucide-react";
import { api } from "../../../api";
import { GroupedList, InfoRow, NavRow } from "../../../shared/GroupedList";
import { formatBytes } from "../../../shared/utils";
import { applicationDiskUsage, usesAppFiles, type UsageKind } from "../applicationStorage";
import type { ApplicationState } from "../applications";
import { storageHref } from "../links";
import type { AppKey } from "../nav";
import type { Contents } from "./StorageContentsSection";

export function ApplicationStorage({ app, state }: { app: Exclude<AppKey, "shared">; state: ApplicationState }) {
  const { t } = useTranslation(["control", "controlAdmin"]);
  const [result, setResult] = useState<{ app: AppKey; contents: Contents | null; failed: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!usesAppFiles(app)) return;
    let active = true;
    setResult(null);
    api<Contents>("/api/storage/app-storage/contents")
      .then((contents) => { if (active) setResult({ app, contents, failed: false }); })
      .catch(() => { if (active) setResult({ app, contents: null, failed: true }); });
    return () => { active = false; };
  }, [app, attempt]);
  const current = result?.app === app ? result : null;
  const loading = usesAppFiles(app) && !current;
  const usage = applicationDiskUsage(app, state, current?.contents ?? null);
  const labels: Record<UsageKind, string> = {
    media: t("control:appStorage.media"), inbox: t("controlAdmin:storage.roomInbox"),
    voiceNotes: t("controlAdmin:storageContents.folderVoiceNotes"), music: t("controlAdmin:storageContents.folderMusic"),
    movies: t("controlAdmin:storageContents.folderMovies"), recordings: t("controlAdmin:storageContents.folderRecordings"),
    familyTree: t("controlAdmin:storageContents.folderFamilyTree"), container: t("control:appStorage.container")
  };
  const amount = (bytes: number | null, complete: boolean) => bytes === null ? t("control:appStorage.unknown")
    : complete ? formatBytes(bytes) : t("control:appStorage.atLeast", { size: formatBytes(bytes) });
  return <GroupedList title={t("control:appStorage.title")} note={t("control:appStorage.note")}>
    <InfoRow icon={<HardDrive size={18} />} label={t("control:appStorage.measured")}
      value={loading ? t("control:ui.loading") : amount(usage.bytes, usage.complete)}
      sub={app === "games" ? t("control:appStorage.containerUnknown") : !loading && !usage.complete ? t("control:appStorage.partial") : undefined} />
    {usage.rows.map((row) => row.href
      ? <NavRow key={row.kind} label={labels[row.kind]} href={row.href}
          value={loading && row.kind !== "media" ? t("control:ui.loading") : amount(row.bytes, row.complete)} />
      : null)}
    {current?.failed && <NavRow label={t("control:appStorage.retry")} onClick={() => setAttempt((value) => value + 1)} />}
    <NavRow label={t("control:appSetup.storageLink")} href={storageHref()} />
  </GroupedList>;
}
