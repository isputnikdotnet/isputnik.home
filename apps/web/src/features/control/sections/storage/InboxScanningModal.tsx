import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScanLine } from "lucide-react";
import { api } from "../../../../api";
import { Button } from "../../../../shared/Button";
import { MessageBox } from "../../../../shared/MessageBox";
import { Modal } from "../../../../shared/Modal";
import {
  DEFAULT_BACK_SIDES,
  type AudiobookLibrary,
  type BackSidesSettings,
  type LibraryTypeDefaults,
  type MetadataSourceInfo,
  type ScanSource
} from "../../../audiobooks/types";
import { BackSidesEditor } from "../../libraries/BackSidesEditor";
import { ScanSourcesEditor } from "../../libraries/ScanSourcesEditor";
import "../../../../styles/system-data.css";

// The Photo Inbox's Scanning settings (docs/back-sides-proposal.md). The Inbox is
// a system library: it is not listed on the Libraries page, so the Scanning tab
// of the edit dialog there — the scan sources and the back-sides pairing rule —
// cannot be reached for it. This dialog holds that tab's content, with the same
// editors, opened from the Inbox's row of the Storage page beside Reviewers.
// Saving goes through the same PATCH as the Libraries page, which takes the
// whole core shape: everything but the two edited settings is sent back as it is.

type GalleryLibrary = Omit<AudiobookLibrary, "type"> & { type: "gallery" };

interface LibrarySettingsPayload {
  metadataSources?: MetadataSourceInfo[];
  typeDefaults?: Record<string, LibraryTypeDefaults>;
}

export function InboxScanningModal({ libraryId, onClose, onSaved }: {
  libraryId: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { t } = useTranslation(["common", "control", "controlAdmin"]);
  const [library, setLibrary] = useState<GalleryLibrary | null>(null);
  const [typeDefaults, setTypeDefaults] = useState<LibraryTypeDefaults | null>(null);
  const [sourceInfo, setSourceInfo] = useState<MetadataSourceInfo[]>([]);
  const [sources, setSources] = useState<ScanSource[]>([]);
  const [backSides, setBackSides] = useState<BackSidesSettings>(DEFAULT_BACK_SIDES);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<LibrarySettingsPayload>("/api/library/settings"),
      api<{ libraries: GalleryLibrary[] }>("/api/library/gallery-libraries?manage=1")
    ])
      .then(([settings, listing]) => {
        if (cancelled) return;
        const found = listing.libraries.find((entry) => entry.id === libraryId);
        if (!found) throw new Error(t("controlAdmin:appStorage.scanning.missing"));
        const defaults = settings.typeDefaults?.gallery ?? null;
        setLibrary(found);
        setTypeDefaults(defaults);
        setSourceInfo((settings.metadataSources ?? []).filter((source) => source.appliesTo.includes("gallery")));
        setSources(found.settings?.scanSources ?? defaults?.sources ?? []);
        setBackSides(found.settings?.backSides ?? DEFAULT_BACK_SIDES);
      })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : t("controlAdmin:appStorage.scanning.loadFailed")); });
    return () => { cancelled = true; };
  }, [libraryId, t]);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!library) return;
    setSaving(true);
    setSaveError("");
    try {
      await api(`/api/library/gallery-libraries/${library.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: library.name,
          visibility: library.visibility,
          publicRole: library.publicRole ?? "member",
          mode: library.mode ?? "managed",
          ownerId: library.ownerId ?? null,
          ownerType: library.ownerType ?? null,
          scanExtensions: library.settings?.scanExtensions ?? typeDefaults?.extensions ?? [],
          companionExtensions: library.settings?.companionExtensions ?? typeDefaults?.companions ?? [],
          maxUploadMB: library.settings?.maxUploadMB ?? null,
          scanSources: sources,
          backSides
        })
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("controlAdmin:appStorage.scanning.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="panel"
      title={t("controlAdmin:appStorage.scanning.title")}
      icon={<ScanLine size={24} />}
      className="inbox-scanning-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={save}
    >
      <div className="modal-tab-content inbox-scanning">
        <p className="inbox-scanning-intro">{t("controlAdmin:appStorage.scanning.intro")}</p>
        {loadError && <MessageBox tone="error" title={t("controlAdmin:appStorage.scanning.loadFailed")}>{loadError}</MessageBox>}
        {!library && !loadError && <p className="management-empty">{t("controlAdmin:ui.loading")}</p>}
        {library && (
          <>
            <ScanSourcesEditor sources={sources} onChange={setSources} sourceInfo={sourceInfo} />
            <BackSidesEditor value={backSides} onChange={setBackSides} libraryId={library.id} />
          </>
        )}
        {saveError && <MessageBox tone="error" title={t("controlAdmin:appStorage.scanning.saveFailed")}>{saveError}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common:common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={saving || !library}>
            {saving ? t("controlAdmin:ui.saving") : t("control:ui.saveChanges")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
