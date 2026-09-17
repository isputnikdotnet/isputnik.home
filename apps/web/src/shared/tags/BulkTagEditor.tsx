import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, RotateCcw, Tag, X } from "lucide-react";
import { api } from "../../api";
import { bulkBatches } from "../bulk";
import { Button } from "../Button";
import { MessageBox } from "../MessageBox";
import { SuggestBox } from "./SuggestBox";
import type { TagSuggestion } from "./useTagSuggestions";

// TagEditor for a selection — photos picked in the Gallery, books picked in a
// catalog. It opens on the tags the selection already wears, each saying on how
// many of the items ("on 3 of 12") when it isn't all of them. × takes a tag off
// every selected item and a tag picked in the box goes on every one; nothing else
// about an item's tags changes. It edits a pending change ({ add, remove }) that
// the dialog around it sends on Apply, so a slip is undone before anything is saved.

export interface BulkTagChange {
  add: string[];
  remove: string[];
}

export const NO_TAG_CHANGE: BulkTagChange = { add: [], remove: [] };

export const hasTagChange = (change: BulkTagChange) => change.add.length > 0 || change.remove.length > 0;

/** What /api/library/items/tags/current takes in one request. */
const CURRENT_BATCH = 1000;

type Current = { items: number; tags: { name: string; count: number }[] };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function BulkTagEditor({
  itemIds,
  suggestions,
  value,
  onChange,
  busy = false
}: {
  itemIds: string[];
  suggestions: TagSuggestion[];
  value: BulkTagChange;
  onChange: (change: BulkTagChange) => void;
  busy?: boolean;
}) {
  const { t } = useTranslation(["common"]);
  const [current, setCurrent] = useState<Current | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const counts = new Map<string, number>();
      let items = 0;
      for (const ids of bulkBatches(itemIds, CURRENT_BATCH)) {
        const part = await api<Current>("/api/library/items/tags/current", {
          method: "POST",
          body: JSON.stringify({ ids })
        });
        items += part.items;
        for (const tag of part.tags) counts.set(tag.name, (counts.get(tag.name) ?? 0) + tag.count);
      }
      const tags = [...counts].map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      if (alive) setCurrent({ items, tags });
    })().catch((err) => {
      if (!alive) return;
      setLoadError(err instanceof Error ? err.message : t("common:tagEditor.unableToRead"));
      setCurrent({ items: itemIds.length, tags: [] });
    });
    return () => { alive = false; };
    // The selection is fixed for as long as the dialog is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = current?.items ?? itemIds.length;
  const onAll = (name: string) => current?.tags.some((tag) => same(tag.name, name) && tag.count >= total) ?? false;
  const removing = (name: string) => value.remove.some((tag) => same(tag, name));
  const adding = (name: string) => value.add.some((tag) => same(tag, name));

  // Already on every item and staying there, or about to be: nothing to offer.
  const taken = [
    ...(current?.tags ?? []).filter((tag) => tag.count >= total && !removing(tag.name)).map((tag) => tag.name),
    ...value.add
  ];

  const items = suggestions
    .filter((tag) => !taken.some((name) => same(name, tag.name)))
    .map((tag) => ({
      id: tag.name,
      name: tag.name,
      weight: tag.uses ?? 0,
      avatar: <Tag size={13} />,
      detail: tag.uses ? t("common:tagEditor.uses", { count: tag.uses }) : undefined
    }));

  const pick = async (name: string) => {
    const remove = value.remove.filter((tag) => !same(tag, name));
    // A tag already on all of them only needed its removal undone.
    const add = onAll(name) || adding(name) ? value.add : [...value.add, name];
    onChange({ add, remove });
    return true;
  };

  const toggleRemove = (name: string) => onChange({
    add: value.add,
    remove: removing(name) ? value.remove.filter((tag) => !same(tag, name)) : [...value.remove, name]
  });

  const dropAdd = (name: string) => onChange({ add: value.add.filter((tag) => !same(tag, name)), remove: value.remove });

  // A tag on only some of the items that is also being added reads as added.
  const shown = (current?.tags ?? []).filter((tag) => !adding(tag.name));

  return (
    <div className="tag-editor is-bulk">
      {loadError && (
        <MessageBox tone="warning" title={t("common:tagEditor.unableToRead")}>{loadError}</MessageBox>
      )}

      {current === null ? (
        <p className="tag-editor-status muted">{t("common:tagEditor.reading")}</p>
      ) : (shown.length > 0 || value.add.length > 0) && (
        <div className="tag-chips">
          {shown.map((tag) => {
            const off = removing(tag.name);
            return (
              <span key={tag.name} className={`tag-chip${off ? " is-removed" : ""}`}>
                <span>{tag.name}</span>
                {tag.count < total && (
                  <small className="tag-chip-count">{t("common:tagEditor.onSome", { count: tag.count, total })}</small>
                )}
                <Button
                  variant="bare"
                  className="tag-chip-remove"
                  onClick={() => toggleRemove(tag.name)}
                  disabled={busy}
                  aria-label={off ? t("common:tagEditor.keep", { tag: tag.name }) : t("common:tagEditor.removeFromAll", { tag: tag.name })}
                  title={off ? t("common:tagEditor.keep", { tag: tag.name }) : t("common:tagEditor.removeFromAll", { tag: tag.name })}
                >
                  {off ? <RotateCcw size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}
                </Button>
              </span>
            );
          })}
          {value.add.map((tag) => (
            <span key={tag} className="tag-chip is-added">
              <Plus size={12} aria-hidden="true" />
              <span>{tag}</span>
              <Button
                variant="bare"
                className="tag-chip-remove"
                onClick={() => dropAdd(tag)}
                disabled={busy}
                aria-label={t("common:tagEditor.dropAdded", { tag })}
                title={t("common:tagEditor.dropAdded", { tag })}
              >
                <X size={12} aria-hidden="true" />
              </Button>
            </span>
          ))}
        </div>
      )}

      <SuggestBox
        items={items}
        takenNames={taken}
        busy={busy}
        placeholder={t("common:tagEditor.searchPlaceholder")}
        ariaLabel={t("common:tagEditor.searchPlaceholder")}
        listLabel={t("common:tagEditor.listLabel")}
        emptyHint={current && current.tags.length === 0 && value.add.length === 0 ? t("common:tagEditor.noneOnSelection") : undefined}
        newLabel={(name) => t("common:tagEditor.addNew", { name })}
        onPick={(choice) => pick(choice.name)}
      />

      <p className="tag-editor-status muted">
        {hasTagChange(value)
          ? [
            value.add.length > 0 ? t("common:tagEditor.pendingAdd", { count: value.add.length }) : null,
            value.remove.length > 0 ? t("common:tagEditor.pendingRemove", { count: value.remove.length }) : null
          ].filter(Boolean).join(" · ")
          : t("common:tagEditor.bulkHint")}
      </p>
    </div>
  );
}
