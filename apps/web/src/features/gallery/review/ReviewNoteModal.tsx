import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, FileText, Mic } from "lucide-react";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { MarkdownEditor } from "../../../shared/MarkdownEditor";
import { Modal } from "../../../shared/Modal";
import { useDictation } from "./useDictation";

// Review mode's "Add note": the words about a photo, written in the same editor
// a story's text uses (shared/MarkdownEditor — bold, lists, a quote), with the
// ways in that don't need a keyboard beside it: dictation, and the previous
// photo's note for a run of prints from one day.
//
// The note is the photo's description, stored as markdown and read back through
// StoryMarkdown. Save hands it to the page's answer for this photo; Save & Next
// writes it, as it writes the date and the place.

export const NOTE_MAX = 5000;

export function ReviewNoteModal({
  initial,
  previousNote,
  thumbnailUrl,
  onSave,
  onClose
}: {
  initial: string;
  /** The previous photo's note, offered as a starting point. */
  previousNote: string | null;
  thumbnailUrl?: string | null;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["galleryReview", "common"]);
  const [text, setText] = useState(initial);
  const [confirmClose, setConfirmClose] = useState(false);

  // Each finished sentence lands at the end, as it is spoken. The recogniser keeps
  // the callback it started with, so the text is read from the updater, not a closure.
  const dictation = useDictation(useCallback((spoken: string) => {
    if (!spoken) return;
    setText((current) => (current.trim() ? `${current.replace(/\s+$/, "")} ${spoken}` : spoken).slice(0, NOTE_MAX));
  }, []));

  const changed = text !== initial;
  const requestClose = () => {
    if (changed && text.trim()) setConfirmClose(true);
    else onClose();
  };

  const stopListening = () => { if (dictation.listening) dictation.toggle(); };

  return (
    <Modal
      title={initial.trim() ? t("galleryReview:noteDialog.editTitle") : t("galleryReview:noteDialog.title")}
      subtitle={t("galleryReview:noteDialog.subtitle")}
      icon={thumbnailUrl ? <img className="audio-record-thumb" src={thumbnailUrl} alt="" /> : <FileText size={20} aria-hidden="true" />}
      onClose={requestClose}
      className="review-note-modal"
      onSubmit={(event) => {
        event.preventDefault();
        stopListening();
        onSave(text.trim());
        onClose();
      }}
    >
      <MarkdownEditor
        value={text}
        onChange={setText}
        placeholder={t("galleryReview:notes.placeholder")}
        rows={10}
        maxLength={NOTE_MAX}
        ariaLabel={t("galleryReview:notes.heading")}
        autoFocus
      />

      <div className="review-note-options">
        {dictation.supported && (
          <Button variant="chip" className="review-chip" aria-pressed={dictation.listening} onClick={dictation.toggle}>
            <Mic size={18} aria-hidden="true" /> {dictation.listening ? t("galleryReview:notes.dictating") : t("galleryReview:notes.dictate")}
          </Button>
        )}
        {previousNote && (
          <Button
            variant="chip"
            className="review-chip review-chip-same"
            onClick={() => setText((current) => (current.trim() ? `${current.replace(/\s+$/, "")}\n\n${previousNote}` : previousNote).slice(0, NOTE_MAX))}
          >
            <Copy size={16} aria-hidden="true" /> {t("galleryReview:noteDialog.useLast")}
          </Button>
        )}
        <span className="review-note-count" aria-live="polite">
          {text.length > NOTE_MAX * 0.9 ? t("galleryReview:noteDialog.remaining", { count: NOTE_MAX - text.length }) : ""}
        </span>
      </div>

      <div className="modal-actions">
        <Button variant="secondary" onClick={requestClose}>{t("common:common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!changed}>{t("galleryReview:noteDialog.save")}</Button>
      </div>

      {confirmClose && (
        <ConfirmDialog
          title={t("galleryReview:noteDialog.discardTitle")}
          confirmLabel={t("galleryReview:noteDialog.discard")}
          danger
          onConfirm={() => { stopListening(); setConfirmClose(false); onClose(); }}
          onCancel={() => setConfirmClose(false)}
        >
          {t("galleryReview:noteDialog.discardBody")}
        </ConfirmDialog>
      )}
    </Modal>
  );
}
