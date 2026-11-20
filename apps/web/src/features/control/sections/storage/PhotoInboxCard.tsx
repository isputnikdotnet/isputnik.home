import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HardDrive, Inbox, ScanLine, Users } from "lucide-react";
import { api } from "../../../../api";
import { GroupedList, InfoRow, NavRow } from "../../../../shared/GroupedList";
import { SettingsCard } from "../../../../shared/SettingsCard";
import { storageHref } from "../../links";
import { InboxReviewersModal } from "./InboxReviewersModal";
import { InboxScanningModal } from "./InboxScanningModal";

// Gallery › Settings: the Photo Inbox's own settings — who reviews it, and what a scan
// reads. They were rows under the Inbox on the Storage page; Storage now keeps to
// where files live and links here. The Inbox itself comes with App storage.

interface InboxPart { part: string; library?: { id: string } | null }

/** `plain`: drawn as a titled list (Gallery › Settings) rather than a card. */
export function PhotoInboxCard({ plain = false }: { plain?: boolean } = {}) {
  const { t } = useTranslation(["controlAdmin"]);
  const [inboxId, setInboxId] = useState<string | null | undefined>(undefined);
  const [reviewersOpen, setReviewersOpen] = useState(false);
  const [scanningOpen, setScanningOpen] = useState(false);

  const load = useCallback(async () => {
    const view = await api<{ enabled: boolean; parts: InboxPart[] }>("/api/storage/app-storage");
    setInboxId(view.enabled ? view.parts.find((part) => part.part === "inbox")?.library?.id ?? null : null);
  }, []);
  useEffect(() => { load().catch(() => setInboxId(null)); }, [load]);

  if (inboxId === undefined) return null;
  const modals = (
    <>
      {reviewersOpen && <InboxReviewersModal onClose={() => setReviewersOpen(false)} />}
      {scanningOpen && inboxId && <InboxScanningModal libraryId={inboxId} onClose={() => setScanningOpen(false)} />}
    </>
  );
  const rows = inboxId ? (
    <>
      <NavRow icon={<Users size={17} />} label={t("controlAdmin:appStorage.reviewers.button")} sub={t("controlAdmin:photoInboxCard.reviewersSub")} onClick={() => setReviewersOpen(true)} />
      <NavRow icon={<ScanLine size={17} />} label={t("controlAdmin:appStorage.scanning.button")} sub={t("controlAdmin:photoInboxCard.scanningSub")} onClick={() => setScanningOpen(true)} />
    </>
  ) : (
    <>
      <InfoRow icon={<Inbox size={17} />} iconTone="muted" label={t("controlAdmin:photoInboxCard.off")} />
      <NavRow icon={<HardDrive size={17} />} label={t("controlAdmin:photoInboxCard.openStorage")} href={storageHref("app-storage")} />
    </>
  );
  // Gallery › Settings draws it as a titled list, as the workspace Overview's lists.
  if (plain) {
    return (
      <>
        <GroupedList id="photo-inbox" title={t("controlAdmin:photoInboxCard.title")} note={t("controlAdmin:photoInboxCard.body")}>{rows}</GroupedList>
        {modals}
      </>
    );
  }
  return (
    <SettingsCard id="photo-inbox" icon={<Inbox size={20} />} title={t("controlAdmin:photoInboxCard.title")} description={t("controlAdmin:photoInboxCard.body")}>
      <GroupedList>{rows}</GroupedList>
      {modals}
    </SettingsCard>
  );
}
