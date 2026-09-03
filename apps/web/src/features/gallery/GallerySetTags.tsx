import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tags } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { PeopleCombobox } from "../../shared/PeopleCombobox";
import { followRoute } from "../../router";

// Tags on an album or a slideshow. Read-only they are chips that lead into the
// cross-type tag browse; for an editor a Tags button swaps in the same
// combobox every other tag field in the app uses. One component for both,
// because tagging a set is the same act whichever kind of set it is.
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
  const { t } = useTranslation(["common", "gallery"]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tags);
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => { setDraft(tags); }, [tags]);

  // Tags are cross-type, so offer the ones the gallery already uses — albums
  // and slideshows count as gallery, so a set's own vocabulary is in here.
  // Every book's subject heading as well would be a list nobody can read.
  useEffect(() => {
    if (!editing || suggestions.length > 0) return;
    api<{ tags: { name: string; galleryCount: number }[] }>("/api/library/tags")
      .then((payload) => setSuggestions(
        payload.tags.filter((tag) => tag.galleryCount > 0).map((tag) => tag.name)
      ))
      .catch(() => setSuggestions([]));
  }, [editing]);

  const save = async () => {
    setBusy(true);
    try {
      const result = await api<{ tags: string[] }>(endpoint, {
        method: "PUT",
        body: JSON.stringify({ tags: draft })
      });
      onSaved(result.tags);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    if (tags.length === 0 && !canEdit) return null;
    return (
      <div className="gallery-set-tags">
        {tags.map((tag) => (
          <a
            key={tag}
            className="gallery-set-tag"
            href={`/tags/${encodeURIComponent(tag)}`}
            onClick={(event) => followRoute(event, `/tags/${encodeURIComponent(tag)}`)}
          >
            {tag}
          </a>
        ))}
        {canEdit && (
          <Button variant="text" compact onClick={() => setEditing(true)}>
            <Tags size={14} aria-hidden="true" />
            <span>{tags.length === 0 ? t("gallery:setTags.add") : t("gallery:setTags.edit")}</span>
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="gallery-set-tags is-editing">
      <PeopleCombobox
        value={draft}
        onChange={setDraft}
        suggestions={suggestions}
        placeholder={t("tagInput.placeholder")}
        disabled={busy}
        autoFocus
      />
      <div className="gallery-set-tag-actions">
        <Button variant="secondary" compact disabled={busy} onClick={() => { setDraft(tags); setEditing(false); }}>
          {t("common:common.cancel")}
        </Button>
        <Button variant="primary" compact disabled={busy} onClick={() => void save()}>
          {busy ? t("gallery:setTags.saving") : t("gallery:common.save")}
        </Button>
      </div>
    </div>
  );
}
