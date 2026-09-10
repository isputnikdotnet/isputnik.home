import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { RecordAudioModal } from "../../shared/audio/RecordAudioModal";
import type { VoiceNote } from "./types";

// Recording a voice memory onto a photo: the shared recording dialog, told
// what a photo calls it and where the take goes (docs/lightbox-panel.md).

const MAX_SECONDS = 5 * 60;

export function RecordVoiceNoteModal({
  assetId,
  thumbnailUrl,
  large = false,
  onSaved,
  onClose
}: {
  assetId: string;
  /** The photo, small, in the dialog's header — the story stays tied to the picture. */
  thumbnailUrl?: string | null;
  /** Review mode's larger controls. */
  large?: boolean;
  onSaved: (notes: VoiceNote[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("gallery");
  return (
    <RecordAudioModal
      title={t("voiceNotes.dialogTitle")}
      subtitle={t("voiceNotes.dialogSubtitle")}
      thumbnailUrl={thumbnailUrl}
      maxSeconds={MAX_SECONDS}
      large={large}
      onSave={async (take) => {
        const form = new FormData();
        form.append("file", take.blob, `voice-note.${take.ext}`);
        const payload = await api<{ notes: VoiceNote[] }>(`/api/library/gallery/assets/${encodeURIComponent(assetId)}/voice-notes`, {
          method: "POST",
          body: form
        });
        onSaved(payload.notes);
      }}
      onClose={onClose}
    />
  );
}
