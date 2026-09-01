import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookText, RotateCcw, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate } from "../../../shared/utils";

interface DeletedStory {
  id: string;
  title: string;
  status: string;
  kind: string;
  chapterCount: number;
  authorName: string | null;
  deletedAt: string | null;
  purgesAt: string | null;
}

// Deleted STORIES, as a quiet block under the library items' bin. Stories are
// rows, not files — no size, no bin folder — so they get a compact list of
// their own rather than tiles in the grid above. Renders nothing while the
// block would be empty; admin-only, like the routes it calls.
export function DeletedStoriesPanel() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [stories, setStories] = useState<DeletedStory[]>([]);
  const [error, setError] = useState("");
  const [confirmPurge, setConfirmPurge] = useState<DeletedStory | null>(null);
  const [busyId, setBusyId] = useState("");

  const load = () =>
    api<{ stories: DeletedStory[] }>("/api/stories/trash")
      .then((payload) => { setStories(payload.stories ?? []); setError(""); })
      .catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:recycleBin.stories.loadFailed")));

  useEffect(() => { void load(); }, []);

  const restore = async (story: DeletedStory) => {
    setBusyId(story.id);
    setError("");
    try {
      await api(`/api/stories/trash/${story.id}/restore`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:recycleBin.stories.restoreFailed"));
    } finally {
      setBusyId("");
    }
  };

  const purge = async () => {
    if (!confirmPurge) return;
    setBusyId(confirmPurge.id);
    setError("");
    try {
      await api(`/api/stories/trash/${confirmPurge.id}`, { method: "DELETE" });
      setConfirmPurge(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:recycleBin.stories.purgeFailed"));
    } finally {
      setBusyId("");
    }
  };

  if (stories.length === 0 && !error) return null;

  return (
    <section className="trash-stories">
      <h2 className="trash-stories-heading">{t("controlAdmin:recycleBin.stories.heading")}</h2>
      <p className="datagrid-muted trash-stories-blurb">{t("controlAdmin:recycleBin.stories.blurb")}</p>

      {error && <MessageBox tone="error" title={t("controlAdmin:recycleBin.stories.errorTitle")}>{error}</MessageBox>}

      <div className="trash-stories-list">
        {stories.map((story) => (
          <div className="trash-stories-row" key={story.id}>
            <span className="trash-stories-icon" aria-hidden="true"><BookText size={17} /></span>
            <span className="trash-stories-body">
              <strong>{story.title}</strong>
              <small className="datagrid-muted">
                {[
                  story.authorName,
                  story.deletedAt ? t("controlAdmin:recycleBin.stories.deletedOn", { date: formatManagedDate(story.deletedAt) }) : "",
                  story.purgesAt
                    ? t("controlAdmin:recycleBin.stories.purgesOn", { date: formatManagedDate(story.purgesAt) })
                    : t("controlAdmin:recycleBin.stories.keptForever")
                ].filter(Boolean).join(" · ")}
              </small>
            </span>
            <span className="row-actions">
              <Button variant="secondary" compact disabled={busyId === story.id} onClick={() => void restore(story)}>
                <RotateCcw size={15} aria-hidden="true" />
                <span>{t("controlAdmin:recycleBin.stories.restore")}</span>
              </Button>
              <Button variant="danger" compact disabled={busyId === story.id} onClick={() => setConfirmPurge(story)}>
                <Trash2 size={15} aria-hidden="true" />
                <span>{t("controlAdmin:recycleBin.stories.deleteForever")}</span>
              </Button>
            </span>
          </div>
        ))}
      </div>

      {confirmPurge && (
        <ConfirmDialog
          title={t("controlAdmin:recycleBin.stories.purgeTitle", { name: confirmPurge.title })}
          confirmLabel={t("controlAdmin:recycleBin.stories.purgeConfirm")}
          busyLabel={t("controlAdmin:recycleBin.stories.purging")}
          danger
          busy={busyId === confirmPurge.id}
          onConfirm={() => void purge()}
          onCancel={() => setConfirmPurge(null)}
        >
          {t("controlAdmin:recycleBin.stories.purgeBody")}
        </ConfirmDialog>
      )}
    </section>
  );
}
