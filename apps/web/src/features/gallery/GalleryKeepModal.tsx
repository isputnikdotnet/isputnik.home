// Keep — where a reviewed Inbox photo goes. Asks for the destination rather than
// guessing it (docs/photo-inbox-proposal.md, decision 5): the upload rule files by
// capture date, which is right for phone photos and wrong for scans, whose EXIF
// date is the scan date. The last choice is remembered for the session, so a box
// of two hundred prints is not two hundred dialogs' worth of typing.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderInput } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import type { Choice } from "../../shared/ChoiceGroup";
import { ChoiceGroup } from "../../shared/ChoiceGroup";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { GalleryFolder, GalleryLibrary } from "./types";

export interface KeepDestination {
  libraryId: string;
  /** Folder under the library root ("" = the root); ignored when `dated`. */
  folder: string;
  /** File by capture date (YYYY/YYYY-MM-DD), the upload rule. */
  dated: boolean;
}

type Placement = "folder" | "dated";

const REMEMBER_KEY = "gallery.inbox.keep";

function remembered(): Partial<KeepDestination> {
  try {
    const raw = window.sessionStorage.getItem(REMEMBER_KEY);
    return raw ? (JSON.parse(raw) as Partial<KeepDestination>) : {};
  } catch {
    return {};
  }
}

function remember(dest: KeepDestination): void {
  try { window.sessionStorage.setItem(REMEMBER_KEY, JSON.stringify(dest)); } catch { /* per-session nicety */ }
}

export function GalleryKeepModal({
  count,
  libraries,
  busy,
  error,
  onClose,
  onKeep
}: {
  count: number;
  /** Where a photo may go: gallery libraries this user can upload to, Inboxes excluded. */
  libraries: GalleryLibrary[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onKeep: (dest: KeepDestination) => void;
}) {
  const { t } = useTranslation(["common", "galleryModals"]);
  const initial = useMemo(remembered, []);
  const [libraryId, setLibraryId] = useState(() => (
    libraries.some((library) => library.id === initial.libraryId) ? initial.libraryId! : libraries[0]?.id ?? ""
  ));
  const [dated, setDated] = useState(initial.dated === true);
  const [folder, setFolder] = useState(initial.folder ?? "");
  const [suggestions, setSuggestions] = useState<GalleryFolder[]>([]);

  // Folder names the destination already has, as you type — the same search the
  // Folders view uses, so a kept photo lands beside its neighbours by name.
  useEffect(() => {
    if (!libraryId || dated || folder.trim().length < 1) { setSuggestions([]); return; }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      const params = new URLSearchParams({ q: folder.trim(), libraryIds: libraryId, limit: "12" });
      api<{ folders: GalleryFolder[] }>(`/api/library/gallery/folders/search?${params}`)
        .then((payload) => { if (!cancelled) setSuggestions(payload.folders); })
        .catch(() => { if (!cancelled) setSuggestions([]); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [libraryId, dated, folder]);

  const placement: Placement = dated ? "dated" : "folder";
  const placementOptions: Choice<Placement>[] = [
    {
      value: "folder",
      label: t("galleryModals:keep.intoFolder"),
      description: t("galleryModals:keep.intoFolderHint"),
      // The folder name belongs to this choice, so it rides under its card.
      detail: (
        <label className="field">
          <span className="sr-only">{t("galleryModals:keep.folderLabel")}</span>
          <input
            type="text"
            list="gallery-keep-folders"
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            placeholder={t("galleryModals:keep.folderPlaceholder")}
            disabled={busy}
            autoComplete="off"
          />
          <datalist id="gallery-keep-folders">
            {suggestions.map((hit) => <option key={hit.path} value={hit.path} />)}
          </datalist>
        </label>
      )
    },
    {
      value: "dated",
      label: t("galleryModals:keep.byDate"),
      description: t("galleryModals:keep.byDateHint")
    }
  ];

  const submit = () => {
    if (!libraryId || busy) return;
    const dest: KeepDestination = { libraryId, folder: dated ? "" : folder.trim(), dated };
    remember(dest);
    onKeep(dest);
  };

  return (
    <Modal
      title={t("galleryModals:keep.title", { count })}
      icon={<FolderInput size={20} />}
      busy={busy}
      className="gallery-bulk-edit-modal"
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); submit(); }}
    >
      <p className="muted">{t("galleryModals:keep.intro")}</p>

      {libraries.length === 0 ? (
        <MessageBox tone="warning" title={t("galleryModals:keep.noDestinationTitle")}>
          {t("galleryModals:keep.noDestinationBody")}
        </MessageBox>
      ) : (
        <>
          <label className="field">
            <span>{t("galleryModals:keep.libraryLabel")}</span>
            <select value={libraryId} onChange={(event) => setLibraryId(event.target.value)} disabled={busy}>
              {libraries.map((library) => (
                <option key={library.id} value={library.id}>{library.name}</option>
              ))}
            </select>
          </label>

          <ChoiceGroup
            legend={t("galleryModals:keep.placementLegend")}
            className="gallery-keep-placement"
            value={placement}
            onChange={(next) => setDated(next === "dated")}
            disabled={busy}
            options={placementOptions}
          />
        </>
      )}

      {error && <MessageBox tone="error" title={t("galleryModals:keep.errorTitle")}>{error}</MessageBox>}

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={busy || !libraryId}>
          {busy ? t("galleryModals:keep.keeping") : t("galleryModals:keep.confirm", { count })}
        </Button>
      </div>
    </Modal>
  );
}
