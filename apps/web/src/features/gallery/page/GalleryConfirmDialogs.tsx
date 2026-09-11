import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";

// The gallery page's "are you sure?" questions, one named dialog each. The page
// owns the busy/error state; these own the words.

export function DeleteMovieDialog({ savedToLibrary, busy, onConfirm, onCancel }: {
  savedToLibrary: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  return (
    <ConfirmDialog
      title={t("gallery:slideshows.deleteMovieTitle")}
      confirmLabel={t("gallery:slideshows.deleteMovieConfirm")}
      danger
      busy={busy}
      onConfirm={onConfirm}
      onCancel={() => { if (!busy) onCancel(); }}
    >
      {t("gallery:slideshows.deleteMovieBody")}
      {savedToLibrary && t("gallery:slideshows.movieCopyKeptNote")}
    </ConfirmDialog>
  );
}

export function DeleteSlideshowDialog({ name, savedToLibrary, busy, onConfirm, onCancel }: {
  name: string;
  savedToLibrary: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  return (
    <ConfirmDialog
      title={t("gallery:slideshows.deleteConfirmTitle", { name })}
      confirmLabel={t("gallery:slideshows.deleteConfirmLabel")}
      danger
      busy={busy}
      onConfirm={onConfirm}
      onCancel={() => { if (!busy) onCancel(); }}
    >
      {t("gallery:slideshows.deleteConfirmBody")}
      {savedToLibrary && t("gallery:slideshows.movieRenderedKeptNote")}
    </ConfirmDialog>
  );
}

export function DeleteAlbumDialog({ name, busy, onConfirm, onCancel }: {
  name: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  return (
    <ConfirmDialog
      title={t("gallery:albums.deleteConfirmTitle", { name })}
      confirmLabel={t("gallery:albums.deleteConfirmLabel")}
      busyLabel={t("gallery:common.deleting")}
      busy={busy}
      danger
      onConfirm={onConfirm}
      onCancel={() => { if (!busy) onCancel(); }}
    >
      {t("gallery:albums.deleteConfirmBody")}
    </ConfirmDialog>
  );
}

export function BulkDeleteDialog({ count, busy, error, onConfirm, onCancel }: {
  count: number;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  return (
    <ConfirmDialog
      title={t("gallery:bulk.deleteConfirmTitle", { count })}
      confirmLabel={t("gallery:bulk.deleteConfirmLabel", { count })}
      busyLabel={t("gallery:common.moving")}
      busy={busy}
      error={error}
      danger
      onConfirm={onConfirm}
      onCancel={() => { if (!busy) onCancel(); }}
    >
      {t("gallery:bulk.deleteConfirmBody")}
    </ConfirmDialog>
  );
}

export function DeletePersonDialog({ name, onConfirm, onCancel }: {
  /** "" for an unnamed person. */
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  return (
    <ConfirmDialog
      title={t("gallery:people.deleteConfirmTitle", { name: name || t("gallery:common.unnamed") })}
      confirmLabel={t("gallery:people.deleteConfirmLabel")}
      danger
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {t("gallery:people.deleteConfirmBody")}
    </ConfirmDialog>
  );
}
