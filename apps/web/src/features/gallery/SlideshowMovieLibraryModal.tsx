import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LibraryBig, Lock, FileWarning } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { ChoiceGroup } from "../../shared/ChoiceGroup";
import type { GallerySlideshowDetail, MovieLibraryOption, MovieTargetPreview, SlideshowPatch } from "./types";

// Where a slideshow's finished movie is filed. Off by default — a movie lives in the
// editor until someone decides it belongs in the gallery proper.
//
// The clash has to be settled HERE, while a person is present: the save itself happens at
// the end of a render that takes minutes and may finish long after the page is closed, so
// there is nobody to ask by then. Whatever is chosen is stored on the slideshow and every
// later re-render just follows it.
export function SlideshowMovieLibraryModal({
  slideshow,
  libraries,
  onClose,
  onPatch,
  onSaved
}: {
  slideshow: GallerySlideshowDetail;
  libraries: MovieLibraryOption[];
  onClose: () => void;
  onPatch: (fields: SlideshowPatch) => Promise<void>;
  onSaved: (message: string) => void;
}) {
  const { t } = useTranslation(["common", "galleryModals"]);
  const [libraryId, setLibraryId] = useState<string>(slideshow.movieTargetLibraryId ?? "");
  const [stem, setStem] = useState<string>(slideshow.movieFileStem ?? "");
  const [renaming, setRenaming] = useState(false);
  const [preview, setPreview] = useState<MovieTargetPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const usable = libraries.filter((library) => library.writable);

  // Ask the server what saving would do, every time the target or the name changes.
  const check = useCallback(async (id: string, name: string) => {
    if (!id) { setPreview(null); return; }
    setChecking(true);
    try {
      const params = new URLSearchParams({ libraryId: id });
      if (name.trim()) params.set("stem", name.trim());
      setPreview(await api<MovieTargetPreview>(
        `/api/library/gallery/slideshows/${slideshow.id}/movie-target/preview?${params}`
      ));
    } catch {
      setPreview(null); // advisory; Save still reports a real failure
    } finally {
      setChecking(false);
    }
  }, [slideshow.id]);

  // Debounced so typing a new name doesn't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => { void check(libraryId, stem); }, 250);
    return () => clearTimeout(timer);
  }, [libraryId, stem, check]);

  const conflict = preview?.conflict ?? "none";
  const blocked = conflict === "item";
  // The name that is TAKEN, which is what a clash has to be reported against — not the
  // numbered name "keep both" would fall back to, which is free by construction.
  const wantedName = preview?.wantedPath?.split("/").pop() ?? preview?.fileName ?? "";

  const apply = async (onConflict: "overwrite" | "keep_both") => {
    setBusy(true);
    setError("");
    try {
      await onPatch({
        movieTargetLibraryId: libraryId || null,
        movieOnConflict: onConflict,
        movieFileStem: stem.trim() ? stem.trim() : null
      });
      // A movie that already exists is filed straight away; otherwise the next render does it.
      if (libraryId && slideshow.renderStatus === "ready") {
        const result = await api<{ saved: boolean }>(
          `/api/library/gallery/slideshows/${slideshow.id}/save-to-library`,
          { method: "POST", body: JSON.stringify({}) }
        );
        if (result.saved) onSaved(t("galleryModals:movieLibrary.savedNotice", { name: preview?.fileName ?? "" }));
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:movieLibrary.unableToSave"));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setError("");
    try {
      await onPatch({ movieTargetLibraryId: null });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:movieLibrary.unableToSave"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("galleryModals:movieLibrary.title")}
      icon={<LibraryBig size={20} />}
      busy={busy}
      className="gallery-bulk-edit-modal"
      onClose={onClose}
    >
      <p className="muted">{t("galleryModals:movieLibrary.body")}</p>

      {error && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>}

      {usable.length === 0 ? (
        <MessageBox tone="info" title={t("galleryModals:movieLibrary.noneTitle")}>
          {t("galleryModals:movieLibrary.noneBody")}
        </MessageBox>
      ) : (
        <ChoiceGroup
          legend={t("galleryModals:movieLibrary.legend")}
          value={libraryId}
          onChange={(value) => { setLibraryId(value); setRenaming(false); }}
          options={[
            { value: "", label: t("galleryModals:movieLibrary.dontSave") },
            ...usable.map((library) => ({ value: library.id, label: library.name }))
          ]}
        />
      )}

      {/* Libraries that exist but can't take a movie, each saying why — leaving them out
          of the list entirely just looks like the library has gone missing. */}
      {libraries.some((library) => !library.writable) && (
        <ul className="gallery-movie-unusable">
          {libraries.filter((library) => !library.writable).map((library) => (
            <li key={library.id}>
              <Lock size={13} aria-hidden="true" />
              <span>{library.name}</span>
              <small>
                {library.reason === "permission"
                  ? t("galleryModals:movieLibrary.reasonPermission")
                  : t("galleryModals:movieLibrary.reasonReadonly")}
              </small>
            </li>
          ))}
        </ul>
      )}

      {libraryId && (
        <div className="gallery-bulk-edit-field">
          <span className="slideshow-setting-label">{t("galleryModals:movieLibrary.fileNameLabel")}</span>
          {renaming ? (
            <label>
              <span className="sr-only">{t("galleryModals:movieLibrary.fileNameLabel")}</span>
              <input
                value={stem}
                onChange={(event) => setStem(event.target.value)}
                placeholder={slideshow.name}
                maxLength={120}
                disabled={busy}
                autoFocus
              />
            </label>
          ) : (
            <div className="gallery-movie-filename">
              <code>{preview?.fileName ?? slideshow.movieFileName}</code>
              <Button variant="text" disabled={busy} onClick={() => setRenaming(true)}>
                {t("galleryModals:movieLibrary.rename")}
              </Button>
            </div>
          )}
          <small className="muted gallery-bulk-edit-hint">
            {checking
              ? t("galleryModals:movieLibrary.checking")
              : conflict === "own"
                ? t("galleryModals:movieLibrary.ownHint")
                : conflict === "none"
                  ? t("galleryModals:movieLibrary.freeHint")
                  : t("galleryModals:movieLibrary.takenHint", { name: preview?.fileName ?? "" })}
          </small>
        </div>
      )}

      {/* The two clashes read differently on purpose: one is a stray file, the other is
          a video somebody actually has. Only the first can be overwritten. */}
      {conflict === "file" && (
        <MessageBox tone="warning" title={t("galleryModals:movieLibrary.clashFileTitle", { name: wantedName })}>
          {t("galleryModals:movieLibrary.clashFileBody")}
        </MessageBox>
      )}
      {blocked && (
        <MessageBox tone="error" title={t("galleryModals:movieLibrary.clashItemTitle", { name: wantedName })}>
          <span className="gallery-movie-clash">
            <FileWarning size={15} aria-hidden="true" />
            {t("galleryModals:movieLibrary.clashItemBody", { title: preview?.existingTitle || preview?.fileName || "" })}
          </span>
        </MessageBox>
      )}

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
        {slideshow.movieTargetLibraryId && !libraryId && (
          <Button variant="danger" onClick={() => void turnOff()} disabled={busy}>
            {t("galleryModals:movieLibrary.turnOff")}
          </Button>
        )}
        {conflict === "file" && (
          <Button variant="secondary" onClick={() => void apply("overwrite")} disabled={busy}>
            {t("galleryModals:movieLibrary.overwrite")}
          </Button>
        )}
        <Button
          variant="primary"
          onClick={() => void apply(blocked ? "keep_both" : conflict === "file" ? "keep_both" : slideshow.movieOnConflict)}
          disabled={busy || checking || (!libraryId && !slideshow.movieTargetLibraryId)}
        >
          {busy
            ? t("galleryModals:common.applying")
            : conflict === "file" || blocked
              ? t("galleryModals:movieLibrary.keepBoth")
              : t("galleryModals:common.apply")}
        </Button>
      </div>
    </Modal>
  );
}
