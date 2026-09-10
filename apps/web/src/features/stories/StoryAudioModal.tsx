import { useTranslation } from "react-i18next";
import { csrfToken } from "../../api";
import { RecordAudioModal } from "../../shared/audio/RecordAudioModal";

// Add narration to a story: the shared recording dialog, with upload allowed —
// recording is the point, but a phone recording someone already made must be
// just as welcome (the voicemail nobody could bring themselves to delete). The
// clip lands in the house library like any other recording (recordings.ts).

const MAX_SECONDS = 15 * 60;

export function StoryAudioModal({
  storyId,
  onAdded,
  onClose
}: {
  storyId: string;
  /** The stored clip's id, ready to hang a block on. */
  onAdded: (audioId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("stories");
  return (
    <RecordAudioModal
      title={t("audio.title")}
      subtitle={t("audio.intro")}
      maxSeconds={MAX_SECONDS}
      allowUpload
      onSave={async (take) => {
        const form = new FormData();
        form.append("file", take.blob, take.fileName ?? `recording.${take.ext}`);
        // Not the api() helper: this is multipart, so the browser must set the
        // Content-Type boundary itself. The CSRF header still has to be sent by
        // hand — every state-changing request is rejected without it.
        const token = csrfToken();
        const response = await fetch(`/api/stories/${storyId}/audio`, {
          method: "POST",
          body: form,
          credentials: "same-origin",
          headers: token ? { "X-CSRF-Token": token } : undefined
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || t("audio.uploadFailed"));
        onAdded(payload.audio.id);
      }}
      onClose={onClose}
    />
  );
}
