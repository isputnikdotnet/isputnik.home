import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { TagEditor } from "../../shared/tags/TagEditor";
import { useTagSuggestions } from "../../shared/tags/useTagSuggestions";

// Tags on an album or a slideshow: the shared TagEditor, each chip a link into the
// cross-type tag browse. For an editor, × and + save straight away, as a photo's
// tags do in the lightbox. One component for both kinds of set, because tagging a
// set is the same act whichever kind of set it is.
export function GallerySetTags({
  endpoint,
  tags,
  canEdit,
  onSaved
}: {
  /** PUT { tags } and get the stored set back. */
  endpoint: string;
  tags: string[];
  canEdit: boolean;
  onSaved: (tags: string[]) => void;
}) {
  const { t } = useTranslation(["common"]);
  // Albums and slideshows count as gallery, so a set's own vocabulary is in here.
  const suggestions = useTagSuggestions("gallery", canEdit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async (next: string[]) => {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ tags: string[] }>(endpoint, {
        method: "PUT",
        body: JSON.stringify({ tags: next })
      });
      onSaved(result.tags);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common:errors.unableToSave"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (tags.length === 0 && !canEdit) return null;

  return (
    <div className="gallery-set-tags">
      <TagEditor
        tags={tags}
        suggestions={suggestions}
        busy={busy}
        tagHref={(tag) => `/tags/${encodeURIComponent(tag)}`}
        onAdd={canEdit ? (tag) => save([...tags, tag]) : undefined}
        onRemove={canEdit ? (tag) => save(tags.filter((other) => other !== tag)) : undefined}
      />
      {error && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>}
    </div>
  );
}
