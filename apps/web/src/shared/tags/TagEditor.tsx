import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Tag, X } from "lucide-react";
import { Button } from "../Button";
import { followRoute } from "../../router";
import { SuggestBox } from "./SuggestBox";
import type { TagSuggestion } from "./useTagSuggestions";

// The tags on one thing — a photo, a book, a story, an album, a quote, a person in
// the family tree — and the one way they are changed, wherever that is. It is the
// lightbox's design, made the app's: chips with ×, a round + at the end, and the
// search list (SuggestBox) under them, most-used first, with "Add … as a new tag".
// Its sibling for a selection of many things is BulkTagEditor.
//
// It does not save anything itself. `onAdd` / `onRemove` either change a form's
// draft or save straight away; a promise that resolves `false` means the tag did
// not go on, so what was typed stays in the box.

export function TagEditor({
  tags,
  suggestions,
  onAdd,
  onRemove,
  busy = false,
  alwaysOpen = false,
  tagHref,
  emptyHint
}: {
  tags: string[];
  suggestions: TagSuggestion[];
  /** Leave both out for chips nobody can change here. */
  onAdd?: (tag: string) => boolean | void | Promise<boolean | void>;
  onRemove?: (tag: string) => void | Promise<unknown>;
  busy?: boolean;
  /** Keep the search box open — for a tab or dialog that is only about tags.
   *  Otherwise the round + opens it. */
  alwaysOpen?: boolean;
  /** Makes each chip's name a link (the tag's browse page). */
  tagHref?: (tag: string) => string;
  emptyHint?: string;
}) {
  const { t } = useTranslation(["common"]);
  const [open, setOpen] = useState(false);
  const editable = !!onAdd;
  const searching = editable && (alwaysOpen || open);

  const has = (name: string) => tags.some((tag) => tag.toLowerCase() === name.toLowerCase());

  const items = suggestions
    .filter((tag) => !has(tag.name))
    .map((tag) => ({
      id: tag.name,
      name: tag.name,
      weight: tag.uses ?? 0,
      avatar: <Tag size={13} />,
      detail: tag.uses ? t("common:tagEditor.uses", { count: tag.uses }) : undefined
    }));

  const pick = async (name: string) => {
    if (has(name)) return true;
    return (await onAdd?.(name)) !== false;
  };

  if (tags.length === 0 && !editable) return null;

  return (
    <div className="tag-editor">
      {(tags.length > 0 || !searching) && (
        <div className="tag-chips">
          {tags.map((tag) => (
            <span key={tag} className="tag-chip">
              {tagHref ? (
                <a href={tagHref(tag)} onClick={(event) => followRoute(event, tagHref(tag))}>{tag}</a>
              ) : (
                <span>{tag}</span>
              )}
              {onRemove && (
                <Button
                  variant="bare"
                  className="tag-chip-remove"
                  onClick={() => void onRemove(tag)}
                  disabled={busy}
                  aria-label={t("common:tagEditor.remove", { tag })}
                  title={t("common:tagEditor.remove", { tag })}
                >
                  <X size={12} aria-hidden="true" />
                </Button>
              )}
            </span>
          ))}
          {editable && !searching && (
            <Button
              variant="chip"
              className="tag-chip-add"
              onClick={() => setOpen(true)}
              disabled={busy}
              aria-label={t("common:tagEditor.add")}
              title={t("common:tagEditor.add")}
            >
              <Plus size={16} aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
      {searching && (
        <SuggestBox
          items={items}
          takenNames={tags}
          busy={busy}
          placeholder={t("common:tagEditor.searchPlaceholder")}
          ariaLabel={t("common:tagEditor.searchPlaceholder")}
          listLabel={t("common:tagEditor.listLabel")}
          emptyHint={emptyHint ?? (tags.length === 0 ? t("common:tagEditor.noneYet") : undefined)}
          newLabel={(name) => t("common:tagEditor.addNew", { name })}
          onPick={(choice) => pick(choice.name)}
          onClose={alwaysOpen ? undefined : () => setOpen(false)}
        />
      )}
    </div>
  );
}
