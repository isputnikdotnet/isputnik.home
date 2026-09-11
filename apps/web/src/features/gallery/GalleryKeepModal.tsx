// Keep — where a reviewed Inbox photo goes. Asks for the destination rather than
// guessing it (docs/photo-inbox-proposal.md, decision 5): the upload rule files by
// capture date, which is right for phone photos and wrong for scans, whose EXIF
// date is the scan date. The last choice is remembered for the session, so a box
// of two hundred prints is not two hundred dialogs' worth of typing.
//
// Two tabs, because there are two ways to answer and they need different controls:
// NAME a folder (or file by date), or PICK one the library already has. The picker
// is the reason for the split — an autocomplete only helps someone who already
// knows what the folders are called, and after a year of scanning nobody does.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, FolderInput, FolderOpen, FolderPlus, Images, Search } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import type { Choice } from "../../shared/ChoiceGroup";
import { ChoiceGroup } from "../../shared/ChoiceGroup";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { SelectField } from "../../shared/SelectField";
import { TabStrip } from "../../shared/TabStrip";
import { useDebouncedValue } from "../../shared/useDebouncedValue";
import type { GalleryFolder, GalleryLibrary } from "./types";

export interface KeepDestination {
  libraryId: string;
  /** Folder under the library root ("" = the root); ignored when `dated`. */
  folder: string;
  /** File by capture date (YYYY/YYYY-MM-DD), the upload rule. */
  dated: boolean;
}

type Placement = "folder" | "dated";
type Tab = "new" | "existing";

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
  const { t } = useTranslation(["common", "gallery", "galleryModals"]);
  const initial = useMemo(remembered, []);
  const [libraryId, setLibraryId] = useState(() => (
    libraries.some((library) => library.id === initial.libraryId) ? initial.libraryId! : libraries[0]?.id ?? ""
  ));
  const [tab, setTab] = useState<Tab>("new");
  const [dated, setDated] = useState(initial.dated === true);
  const [folder, setFolder] = useState(initial.folder ?? "");
  const [search, setSearch] = useState("");
  const [folders, setFolders] = useState<GalleryFolder[] | null>(null);

  // What each tab narrows the list by: the picker’s own search box, or the folder
  // name being typed on the other tab (which the box suggests from). Choosing a
  // folder must not count as typing, or the list would reload under the click.
  const term = useDebouncedValue(tab === "existing" ? search : folder, 200);

  // The destination’s folders, for both tabs. Debounced, and an empty term lists
  // the whole library. The rows already on screen stay until the new ones land:
  // blanking them on every keystroke made the list flicker.
  useEffect(() => {
    if (!libraryId) { setFolders([]); return; }
    let cancelled = false;
    const params = new URLSearchParams({ q: term.trim(), libraryIds: libraryId, limit: "200" });
    api<{ folders: GalleryFolder[] }>(`/api/library/gallery/folders/search?${params}`)
      .then((payload) => { if (!cancelled) setFolders(payload.folders); })
      .catch(() => { if (!cancelled) setFolders([]); });
    return () => { cancelled = true; };
  }, [libraryId, term]);

  const chooseExisting = (path: string) => { setFolder(path); setDated(false); };

  const submit = () => {
    if (!libraryId || busy) return;
    const dest: KeepDestination = { libraryId, folder: dated ? "" : folder.trim(), dated };
    remember(dest);
    onKeep(dest);
  };

  const placement: Placement = dated ? "dated" : "folder";
  const placementOptions: Choice<Placement>[] = [
    {
      value: "folder",
      label: t("galleryModals:keep.intoFolder"),
      description: t("galleryModals:keep.intoFolderHint"),
      icon: <FolderPlus size={18} />,
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
            {(folders ?? []).map((hit) => <option key={hit.path} value={hit.path} />)}
          </datalist>
        </label>
      )
    },
    {
      value: "dated",
      label: t("galleryModals:keep.byDate"),
      description: t("galleryModals:keep.byDateHint"),
      icon: <CalendarDays size={18} />
    }
  ];

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
          <SelectField
            label={t("galleryModals:keep.libraryLabel")}
            icon={<Images size={17} />}
            value={libraryId}
            onChange={setLibraryId}
            disabled={busy}
            options={libraries.map((library) => ({ value: library.id, label: library.name }))}
          />

          <TabStrip
            items={[
              { key: "new", label: t("galleryModals:keep.tabNew"), icon: FolderPlus },
              { key: "existing", label: t("galleryModals:keep.tabExisting"), icon: FolderOpen }
            ]}
            active={tab}
            onChange={setTab}
            ariaLabel={t("galleryModals:keep.placementLegend")}
          />

          {tab === "new" ? (
            <ChoiceGroup
              legend={t("galleryModals:keep.placementLegend")}
              className="gallery-keep-placement"
              value={placement}
              onChange={(next) => setDated(next === "dated")}
              disabled={busy}
              options={placementOptions}
            />
          ) : (
            <div className="gallery-keep-existing">
              <label className="gallery-keep-search">
                <Search size={16} aria-hidden="true" />
                <span className="sr-only">{t("galleryModals:keep.searchLabel")}</span>
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("galleryModals:keep.searchPlaceholder")}
                  disabled={busy}
                  autoComplete="off"
                />
              </label>

              <ul className="gallery-keep-folder-list">
                {/* The root is a real answer — "just put them in the library" — so it
                    is offered rather than left to be guessed at with an empty box. */}
                <li>
                  <Button
                    variant="bare"
                    className={`gallery-keep-folder${!dated && folder === "" ? " is-chosen" : ""}`}
                    onClick={() => chooseExisting("")}
                    disabled={busy}
                  >
                    <FolderOpen size={16} aria-hidden="true" />
                    <span className="gallery-keep-folder-path">{t("galleryModals:keep.libraryRoot")}</span>
                  </Button>
                </li>
                {folders === null ? (
                  <li className="muted gallery-keep-folder-note">{t("galleryModals:common.loading")}</li>
                ) : folders.length === 0 ? (
                  <li className="muted gallery-keep-folder-note">
                    {search.trim() ? t("galleryModals:keep.noFolderMatch") : t("galleryModals:keep.noFoldersYet")}
                  </li>
                ) : folders.map((hit) => (
                  <li key={hit.path}>
                    <Button
                      variant="bare"
                      className={`gallery-keep-folder${!dated && folder === hit.path ? " is-chosen" : ""}`}
                      onClick={() => chooseExisting(hit.path)}
                      disabled={busy}
                    >
                      <FolderOpen size={16} aria-hidden="true" />
                      <span className="gallery-keep-folder-path">{hit.path}</span>
                      <span className="muted">{t("gallery:common.counts.photo", { count: hit.assetCount })}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <MessageBox tone="info" title={t("galleryModals:keep.moveNoteTitle", { count })}>
            {t("galleryModals:keep.moveNoteBody")}
          </MessageBox>
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
